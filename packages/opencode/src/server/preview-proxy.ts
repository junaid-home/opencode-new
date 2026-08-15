import { Effect, Stream } from "effect"
import { HttpBody, HttpClient, HttpClientRequest, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { requestBody } from "@/server/routes/instance/httpapi/middleware/proxy"
import { ProxyUtil } from "@/server/proxy-util"

const PREVIEW_PROXY_PREFIX = "/global/preview/proxy/"

export function previewProxyTarget(url: URL): { port: number; path: string } | undefined {
  if (!url.pathname.startsWith(PREVIEW_PROXY_PREFIX)) return undefined
  const segments = url.pathname.split("/")
  const port = parseInt(segments[4] ?? "", 10)
  if (!port || port < 1 || port > 65535) return undefined
  return { port, path: "/" + segments.slice(5).join("/") + url.search }
}

export function proxyBase(port: number): string {
  return `${PREVIEW_PROXY_PREFIX}${port}/`
}

// Rebase absolute-path asset URLs (e.g. Vite's `/@vite/client`, `/src/main.tsx`)
// onto the preview proxy path and anchor relative URLs with a <base> tag.
function rewritePreviewHtml(body: string, base: string): string {
  let html = body.replace(/(\b(?:src|href)=")\/(?!\/)/g, (_m, prefix) => `${prefix}${base}`)
  if (!/<base\b/i.test(html)) {
    const withBase = html.replace(/<head([^>]*)>/i, (m, attrs) => `<head${attrs}><base href="${base}">`)
    html = withBase === html ? `<base href="${base}">` + html : withBase
  }
  return html
}

// Rebase absolute-path module specifiers (e.g. Vite's `/src/main.tsx`,
// `/node_modules/.vite/deps/react.js`, `/@vite/client`, `/@fs/...`) onto the
// preview proxy path. Dev servers normalize every import to a root-absolute URL,
// which would otherwise resolve against the origin root and bypass the proxy.
// Only module-specifier positions are touched (`from`, `import`, `import(`,
// `new URL(..., import.meta.url)`) so ordinary string literals like client-side
// route paths are left alone.
function rewritePreviewModule(body: string, base: string): string {
  return body
    .replace(/(\bfrom\s*["'])\/(?!\/)/g, `$1${base}`)
    .replace(/(\bimport\s*(?:\(\s*)?["'])\/(?!\/)/g, `$1${base}`)
    .replace(/(\bnew\s+URL\s*\(\s*["'])\/(?!\/)/g, `$1${base}`)
}

// Preview proxy requests run inside the HttpApi app (short-circuiting the UI
// catch-all) so that exactly one request listener responds; the raw Node server
// callback only handles paths the app never sees. HTML/JS payloads are buffered
// and rewritten so absolute asset URLs resolve through the proxy path; everything
// else streams through untouched. Nothing may be cached: preview ports are stable
// but their content changes on every edit, and there is no HMR/websocket
// bridging — a manual refresh of the preview picks up the latest build. Preview
// dev servers gzip responses, but the app's fetch-based HttpClient transparently
// decompresses those bodies (while leaving `content-encoding` behind), so the
// buffered bytes are always plain text; the stale encoding/framing headers are
// stripped below.
export function previewProxyResponse(
  client: HttpClient.HttpClient,
  request: HttpServerRequest.HttpServerRequest,
  target: { port: number; path: string },
): Effect.Effect<HttpServerResponse.HttpServerResponse, never, never> {
  const url = `http://localhost:${target.port}${target.path}`
  const base = proxyBase(target.port)
  const host = { host: `localhost:${target.port}` }
  return Effect.gen(function* () {
    const response = yield* client.execute(
      HttpClientRequest.make(request.method as never)(url, {
        headers: ProxyUtil.headers(request.headers as HeadersInit, host),
        body: requestBody(request),
      }),
    )
    const contentType = response.headers["content-type"] ?? ""
    const isHtml = contentType.includes("text/html")
    const isJavaScript = /javascript/.test(contentType)
    if (isHtml || isJavaScript) {
      const chunks = yield* response.stream.pipe(Stream.runCollect)
      const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))
      const rewritten = isHtml ? rewritePreviewHtml(body.toString("utf8"), base) : rewritePreviewModule(body.toString("utf8"), base)
      const headers = new Headers(response.headers as HeadersInit)
      headers.delete("content-encoding")
      headers.delete("content-length")
      headers.delete("transfer-encoding")
      headers.set("cache-control", "no-store")
      return HttpServerResponse.uint8Array(Buffer.from(rewritten), {
        status: response.status,
        statusText: statusText(response),
        headers,
      })
    }
    const headers = new Headers(response.headers as HeadersInit)
    headers.delete("content-encoding")
    headers.delete("content-length")
    headers.delete("transfer-encoding")
    headers.set("cache-control", "no-store")
    return HttpServerResponse.stream(response.stream.pipe(Stream.catchCause(() => Stream.empty)), {
      status: response.status,
      statusText: statusText(response),
      headers,
    })
  }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.empty({ status: 502 }))))
}

function statusText(response: unknown) {
  return (response as { source?: Response }).source?.statusText
}
