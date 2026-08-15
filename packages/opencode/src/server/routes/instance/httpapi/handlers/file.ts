import * as InstanceState from "@/effect/instance-state"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { Ignore } from "@opencode-ai/core/filesystem/ignore"
import { LocationServiceMap, locationServiceMapLayer } from "@opencode-ai/core/location-services"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath, RelativePath } from "@opencode-ai/core/schema"
import { Effect, Layer, Option, Schema } from "effect"
import ignore from "ignore"
import path from "path"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { FileDownloadBody } from "../groups/file"

async function buildProjectZip(directory: string): Promise<Buffer> {
  const { default: JSZip } = await import("jszip")
  const { readdir, readFile } = await import("fs/promises")
  const root = path.resolve(directory)
  const base = path.basename(root)
  const zip = new JSZip()
  const stack: string[] = [root]
  while (stack.length > 0) {
    const dir = stack.pop()!
    const entries = await readdir(dir, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const absolute = path.join(dir, entry.name)
      const relative = path.relative(root, absolute).split(path.sep).join("/")
      if (Ignore.match(relative)) continue
      if (entry.isDirectory()) {
        stack.push(absolute)
        continue
      }
      if (!entry.isFile()) continue
      zip.file(path.posix.join(base, relative), await readFile(absolute))
    }
  }
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } })
}

export const fileHandlers = HttpApiBuilder.group(InstanceHttpApi, "file", (handlers) =>
  Effect.gen(function* () {
    const ripgrep = yield* Ripgrep.Service
    const locations = yield* LocationServiceMap.Service

    const filesystem = Effect.fnUntraced(function* <A, E, R>(effect: Effect.Effect<A, E, R>) {
      return yield* effect.pipe(
        Effect.provide(
          locations.get(Location.Ref.make({ directory: AbsolutePath.make((yield* InstanceState.context).directory) })),
        ),
      )
    })

    const findText = Effect.fn("FileHttpApi.findText")(function* (ctx: { query: { pattern: string } }) {
      return (yield* ripgrep
        .grep({ cwd: (yield* InstanceState.context).directory, pattern: ctx.query.pattern, limit: 10 })
        .pipe(Effect.orDie)).map((match) => ({
        path: { text: match.entry.path },
        lines: { text: match.text },
        line_number: match.line,
        absolute_offset: match.offset,
        submatches: match.submatches.map((submatch) => ({
          match: { text: submatch.text },
          start: submatch.start,
          end: submatch.end,
        })),
      }))
    })

    const findFile = Effect.fn("FileHttpApi.findFile")(function* (ctx: {
      query: { query: string; dirs?: "true" | "false"; type?: "file" | "directory"; limit?: number }
    }) {
      const directory = (yield* InstanceState.context).directory
      const limit = ctx.query.limit ?? 10
      const type = ctx.query.type ?? (ctx.query.dirs === "false" ? "file" : undefined)
      const started = performance.now()
      const found = yield* filesystem(FileSystem.Service.use((fs) => fs.find({ query: ctx.query.query, limit, type })))
      yield* Effect.logInfo("find file", {
        query: ctx.query.query,
        type,
        directory,
        limit,
        results: found.length,
        duration: Math.round(performance.now() - started),
      })
      return found.map((item) => item.path)
    })

    const findSymbol = Effect.fn("FileHttpApi.findSymbol")(function* () {
      return []
    })

    const list = Effect.fn("FileHttpApi.list")(function* (ctx: { query: { path: string } }) {
      const directory = (yield* InstanceState.context).directory
      return yield* filesystem(
        Effect.gen(function* () {
          const fs = yield* FileSystem.Service
          const raw = yield* FSUtil.Service
          const location = yield* Location.Service
          const ignored = ignore()
          const gitignore = yield* raw
            .readFileString(path.join(location.project.directory, ".gitignore"))
            .pipe(Effect.catch(() => Effect.succeed("")))
          if (gitignore) ignored.add(gitignore)
          const ignorefile = yield* raw
            .readFileString(path.join(location.project.directory, ".ignore"))
            .pipe(Effect.catch(() => Effect.succeed("")))
          if (ignorefile) ignored.add(ignorefile)
          return (yield* fs.list({ path: RelativePath.make(ctx.query.path) })).map((item) => ({
            name: path.basename(item.path),
            path: item.path,
            absolute: path.resolve(location.directory, item.path),
            type: item.type,
            ignored: ignored.ignores(
              path.relative(location.project.directory, path.resolve(location.directory, item.path)) +
                (item.type === "directory" ? "/" : ""),
            ),
          }))
        }),
      )
    })

    const content = Effect.fn("FileHttpApi.content")(function* (ctx: { query: { path: string } }) {
      const directory = (yield* InstanceState.context).directory
      const file = path.resolve(directory, ctx.query.path)
      if (!FSUtil.contains(directory, file)) return yield* Effect.die(new Error("Path escapes the location"))
      if (!(yield* FSUtil.Service.use((fs) => fs.existsSafe(file)))) return { type: "text" as const, content: "" }
      return yield* filesystem(
        FileSystem.Service.use((fs) => fs.read({ path: RelativePath.make(ctx.query.path) })),
      ).pipe(
        Effect.flatMap((item) =>
          Effect.gen(function* () {
            const text = item.content.includes(0)
              ? Option.none<string>()
              : yield* Effect.sync(() => new TextDecoder("utf-8", { fatal: true }).decode(item.content)).pipe(
                  Effect.option,
                )
            return { item, text }
          }),
        ),
        Effect.map(({ item, text }) =>
          Option.isSome(text)
            ? { type: "text" as const, content: text.value.trim() }
            : {
                type: "binary" as const,
                content: Buffer.from(item.content).toString("base64"),
                encoding: "base64" as const,
                mimeType: item.mime,
              },
        ),
      )
    })

    const status = Effect.fn("FileHttpApi.status")(function* () {
      return []
    })

    const remove = Effect.fn("FileHttpApi.remove")(function* (ctx: { payload: { directory: string; path: string } }) {
      const fs = yield* Effect.promise(() => import("fs/promises"))
      const nodePath = yield* Effect.promise(() => import("path"))
      const fullPath = nodePath.resolve(ctx.payload.directory, ctx.payload.path)
      yield* Effect.promise(() => fs.rm(fullPath, { recursive: true, force: true }))
      return { success: true }
    })

    const rename = Effect.fn("FileHttpApi.rename")(
      function* (ctx: { payload: { directory: string; oldPath: string; newPath: string } }) {
        const fs = yield* Effect.promise(() => import("fs/promises"))
        const nodePath = yield* Effect.promise(() => import("path"))
        const absOld = nodePath.resolve(ctx.payload.directory, ctx.payload.oldPath)
        const absNew = nodePath.resolve(ctx.payload.directory, ctx.payload.newPath)
        const dir = absNew.substring(0, absNew.lastIndexOf("/"))
        if (dir) yield* Effect.promise(() => fs.mkdir(dir, { recursive: true }))
        yield* Effect.promise(() => fs.rename(absOld, absNew))
        return { success: true }
      },
    )

    const download = Effect.fn("FileHttpApi.download")(function* (ctx: {
      request: HttpServerRequest.HttpServerRequest
    }) {
      const body = yield* Effect.orDie(ctx.request.json)
      const decoded = yield* Schema.decodeUnknownEffect(FileDownloadBody)(body).pipe(Effect.option)
      if (Option.isNone(decoded)) return HttpServerResponse.uint8Array(new Uint8Array(), { status: 400 })
      const directory = path.resolve(decoded.value.directory)
      const name = `${path.basename(directory) || "project"}.zip`
      const buffer = yield* Effect.promise(() => buildProjectZip(directory))
      return HttpServerResponse.uint8Array(new Uint8Array(buffer), {
        contentType: "application/zip",
        headers: { "Content-Disposition": `attachment; filename="${name}"` },
      })
    })

    return handlers
      .handle("findText", findText)
      .handle("findFile", findFile)
      .handle("findSymbol", findSymbol)
      .handle("list", list)
      .handle("content", content)
      .handle("status", status)
      .handle("remove", remove)
      .handle("rename", rename)
      .handleRaw("download", download)
  }),
).pipe(Layer.provide(locationServiceMapLayer))
