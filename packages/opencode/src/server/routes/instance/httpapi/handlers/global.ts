import { Config } from "@/config/config"
import { GlobalBus, type GlobalEvent as GlobalBusEvent } from "@/bus/global"
import { EffectBridge } from "@/effect/bridge"
import { EventV2 } from "@opencode-ai/core/event"
import { Installation } from "@/installation"
import { disposeAllInstancesAndEmitGlobalDisposed } from "@/server/global-lifecycle"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { gitInitRepo } from "@/project/project"
import { Effect, Queue, Schema } from "effect"
import * as Stream from "effect/Stream"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import * as Sse from "effect/unstable/encoding/Sse"
import { RootHttpApi } from "../api"
import { GlobalUpgradeInput } from "../groups/global"
import { mkdir } from "fs/promises"
import path from "path"
import { startDevServer, stopDevServer, getDevServerStatus, touchDevServer } from "@/preview/server"

const ZIP_MAX_BYTES = 200 * 1024 * 1024

function asError(err: unknown): Error {
  if (typeof err === "object" && err !== null && "message" in err) {
    return new Error(String(err.message))
  }
  return new Error(String(err))
}

function eventData(data: unknown): Sse.Event {
  return {
    _tag: "Event",
    event: "message",
    id: undefined,
    data: JSON.stringify(data),
  }
}

function parseBody(body: string) {
  try {
    return JSON.parse(body || "{}") as unknown
  } catch {
    return undefined
  }
}

async function extractZip(zipData: Uint8Array, destPath: string): Promise<number> {
  const JSZip = (await import("jszip")).default
  const zip = await JSZip.loadAsync(zipData)
  const fileNames = Object.keys(zip.files).filter(
    (name) => !zip.files[name].dir && name.includes("/") && !name.startsWith("__MACOSX/"),
  )
  let commonRoot = ""
  if (fileNames.length > 0) {
    const firstParts = fileNames[0].split("/")
    const rootParts: string[] = []
    for (let i = 0; i < firstParts.length - 1; i++) {
      const part = firstParts[i]
      if (fileNames.every((fn) => fn.startsWith(part + "/"))) {
        rootParts.push(part)
      } else {
        break
      }
    }
    if (rootParts.length > 0 && fileNames.every((fn) => fn.startsWith(rootParts.join("/") + "/"))) {
      commonRoot = rootParts.join("/") + "/"
    }
  }
  const resolvedDest = path.resolve(destPath)
  let count = 0
  for (const [name, zipEntry] of Object.entries(zip.files)) {
    if (name.startsWith("__MACOSX/")) continue
    if (!zipEntry.dir) {
      const content = await zipEntry.async("nodebuffer")
      const relativeName = commonRoot ? name.slice(commonRoot.length) : name
      const filePath = path.join(resolvedDest, relativeName)
      if (!filePath.startsWith(resolvedDest + path.sep)) continue
      await mkdir(path.dirname(filePath), { recursive: true })
      await Bun.write(filePath, content)
      count++
    }
  }
  return count
}

function eventResponse() {
  return Effect.gen(function* () {
    yield* Effect.logInfo("global event connected")
    const events = Stream.callback<GlobalBusEvent>((queue) => {
      const handler = (event: GlobalBusEvent) => Queue.offerUnsafe(queue, event)
      return Effect.acquireRelease(
        Effect.sync(() => GlobalBus.on("event", handler)),
        () => Effect.sync(() => GlobalBus.off("event", handler)),
      )
    })
    const heartbeat = Stream.tick("10 seconds").pipe(
      Stream.drop(1),
      Stream.map(() => ({ payload: { id: EventV2.ID.create(), type: "server.heartbeat", properties: {} } })),
    )

    return HttpServerResponse.stream(
      Stream.make({ payload: { id: EventV2.ID.create(), type: "server.connected", properties: {} } }).pipe(
        Stream.concat(events.pipe(Stream.merge(heartbeat, { haltStrategy: "left" }))),
        Stream.map(eventData),
        Stream.pipeThroughChannel(Sse.encode()),
        Stream.encodeText,
        Stream.ensuring(Effect.logInfo("global event disconnected")),
      ),
      {
        contentType: "text/event-stream",
        headers: {
          "Cache-Control": "no-cache, no-transform",
          "X-Accel-Buffering": "no",
          "X-Content-Type-Options": "nosniff",
        },
      },
    )
  })
}

export const globalHandlers = HttpApiBuilder.group(RootHttpApi, "global", (handlers) =>
  Effect.gen(function* () {
    const config = yield* Config.Service
    const installation = yield* Installation.Service
    const bridge = yield* EffectBridge.make()

    const health = Effect.fn("GlobalHttpApi.health")(function* () {
      return { healthy: true as const, version: InstallationVersion }
    })

    const event = Effect.fn("GlobalHttpApi.event")(function* () {
      return yield* eventResponse()
    })

    const configGet = Effect.fn("GlobalHttpApi.configGet")(function* () {
      return yield* config.getGlobal()
    })

    const configUpdate = Effect.fn("GlobalHttpApi.configUpdate")(function* (ctx) {
      const result = yield* config.updateGlobal(ctx.payload)
      if (result.changed) bridge.fork(disposeAllInstancesAndEmitGlobalDisposed({ swallowErrors: true }))
      return result.info
    })

    const dispose = Effect.fn("GlobalHttpApi.dispose")(function* () {
      yield* disposeAllInstancesAndEmitGlobalDisposed()
      return true
    })

    const upgrade = Effect.fn("GlobalHttpApi.upgrade")(function* (ctx: { payload: typeof GlobalUpgradeInput.Type }) {
      const method = yield* installation.method()
      if (method === "unknown") {
        return {
          status: 400,
          body: { success: false as const, error: "Unknown installation method" },
        }
      }
      const target = ctx.payload.target || (yield* installation.latest(method))
      const result = yield* installation.upgrade(method, target).pipe(
        Effect.as({ status: 200, body: { success: true as const, version: target } }),
        Effect.catch((err) =>
          Effect.succeed({
            status: 500,
            body: {
              success: false as const,
              error: err instanceof Error ? err.message : String(err),
            },
          }),
        ),
      )
      if (!result.body.success) return result
      GlobalBus.emit("event", {
        directory: "global",
        payload: {
          type: Installation.Event.Updated.type,
          properties: { version: target },
        },
      })
      return result
    })

    const upgradeRaw = Effect.fn("GlobalHttpApi.upgradeRaw")(function* (ctx: {
      request: HttpServerRequest.HttpServerRequest
    }) {
      const body = yield* Effect.orDie(ctx.request.text)
      const json = parseBody(body)
      if (json === undefined) {
        return HttpServerResponse.jsonUnsafe({ success: false, error: "Invalid request body" }, { status: 400 })
      }
      const payload = yield* Schema.decodeUnknownEffect(GlobalUpgradeInput)(json).pipe(
        Effect.map((payload) => ({ valid: true as const, payload })),
        Effect.catch(() => Effect.succeed({ valid: false as const })),
      )
      if (!payload.valid) {
        return HttpServerResponse.jsonUnsafe({ success: false, error: "Invalid request body" }, { status: 400 })
      }
      const result = yield* upgrade({ payload: payload.payload })
      return HttpServerResponse.jsonUnsafe(result.body, { status: result.status })
    })

    return handlers
      .handle("health", health)
      .handleRaw("event", event)
      .handle("configGet", configGet)
      .handle("configUpdate", configUpdate)
      .handle("dispose", dispose)
      .handleRaw("upgrade", upgradeRaw)
      .handleRaw("fileCreate", Effect.fn("GlobalHttpApi.fileCreate")(function* (ctx: {
        request: HttpServerRequest.HttpServerRequest
      }) {
        const request = ctx.request
        const url = new URL(request.url, "http://localhost")
        const contentType = (request.headers["content-type"] ?? "").toLowerCase()
        const queryPath = url.searchParams.get("path")
        let projectPath = queryPath ? decodeURIComponent(queryPath) : undefined
        let zipData: Uint8Array | undefined

        if (contentType.includes("application/json")) {
          const text = yield* Effect.orDie(request.text)
          const json = parseBody(text) as { path?: string; data?: number[] } | undefined
          if (!json?.path) {
            return HttpServerResponse.jsonUnsafe({ success: false, errors: [{ message: "Invalid request body" }] }, { status: 400 })
          }
          projectPath = json.path
          if (Array.isArray(json.data) && json.data.length > 0) zipData = new Uint8Array(json.data)
        } else {
          if (!projectPath) {
            return HttpServerResponse.jsonUnsafe({ success: false, errors: [{ message: "Invalid request body" }] }, { status: 400 })
          }
          const buffer = yield* Effect.orDie(request.arrayBuffer)
          if (buffer.byteLength > 0) zipData = new Uint8Array(buffer)
        }

        yield* Effect.promise(() => mkdir(projectPath, { recursive: true }))

        if (zipData && zipData.length > ZIP_MAX_BYTES) {
          return HttpServerResponse.jsonUnsafe({ success: false, errors: [{ message: "Zip file must be under 200MB" }] }, { status: 400 })
        }
        const files = zipData ? yield* Effect.promise(() => extractZip(zipData, projectPath)) : 0
        const gitInit = yield* gitInitRepo(projectPath).pipe(
          Effect.map(() => null as Error | null),
          Effect.catch((err) => Effect.succeed(asError(err))),
        )
        if (gitInit) {
          return HttpServerResponse.jsonUnsafe(
            { success: false, errors: [{ message: gitInit.message }] },
            { status: 400 },
          )
        }
        return HttpServerResponse.jsonUnsafe({ success: true, path: projectPath, files, git: true })
      }))
      .handleRaw("previewStart", Effect.fn("GlobalHttpApi.previewStart")(function* (ctx: {
        request: HttpServerRequest.HttpServerRequest
      }) {
        const body = yield* Effect.orDie(ctx.request.json) as Effect.Effect<{ directory: string }>
        if (!body?.directory) return HttpServerResponse.jsonUnsafe({ success: false, error: "No directory provided" }, { status: 400 })
        const start = yield* Effect.tryPromise({
          try: () => startDevServer(body.directory),
          catch: (err) => err,
        }).pipe(
          Effect.match({
            onSuccess: (result) => ({ ok: true as const, result }),
            onFailure: (err) => ({ ok: false as const, error: err }),
          }),
        )
        if (!start.ok) {
          return HttpServerResponse.jsonUnsafe(
            { success: false, error: start.error instanceof Error ? start.error.message : "Failed to start dev server" },
            { status: 400 },
          )
        }
        const status = getDevServerStatus(body.directory)
        if (!status.running || !status.port) return HttpServerResponse.jsonUnsafe({ success: false, error: "Dev server failed to start" }, { status: 400 })
        const hostname = process.env.OPENCODE_HOST || status.hostname || "localhost"
        const proto = ctx.request.headers["x-forwarded-proto"] ?? "http"
        const scheme = proto === "wss" ? "https" : proto
        const host = ctx.request.headers["host"] ?? hostname
        const url = `${scheme}://${host}/global/preview/proxy/${status.port}`
        return HttpServerResponse.jsonUnsafe({ success: true, url, framework: start.result.framework })
      }))
      .handleRaw("previewStop", Effect.fn("GlobalHttpApi.previewStop")(function* (ctx: {
        request: HttpServerRequest.HttpServerRequest
      }) {
        const body = yield* Effect.orDie(ctx.request.json) as Effect.Effect<{ directory: string }>
        if (!body?.directory) return HttpServerResponse.jsonUnsafe({ success: false }, { status: 400 })
        return HttpServerResponse.jsonUnsafe({ success: stopDevServer(body.directory) })
      }))
      .handleRaw("previewStatus", Effect.fn("GlobalHttpApi.previewStatus")(function* (ctx: {
        request: HttpServerRequest.HttpServerRequest
      }) {
        const url = new URL(ctx.request.url, "http://localhost")
        const directory = url.searchParams.get("directory")
        if (!directory) return HttpServerResponse.jsonUnsafe({ running: false })
        return HttpServerResponse.jsonUnsafe(getDevServerStatus(directory))
      }))
      .handle("previewHeartbeat", Effect.fn("GlobalHttpApi.previewHeartbeat")(function* (ctx: {
        payload: { directory: string }
      }) {
        touchDevServer(ctx.payload.directory)
        return { success: true }
      }))
  }),
)
