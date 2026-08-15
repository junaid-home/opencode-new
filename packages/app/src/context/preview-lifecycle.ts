import { onCleanup, onMount } from "solid-js"
import { useServerSDK } from "./server-sdk"
import { useServerSync } from "./server-sync"
import { createMemo } from "solid-js"

const activeSessions = new Map<string, number>()
const previewUrls = new Map<string, string>()
const HEARTBEAT_INTERVAL_MS = 20_000

export function getPreviewUrl(directory: string): string | undefined {
  return previewUrls.get(directory)
}

export function setPreviewUrl(directory: string, url: string): void {
  previewUrls.set(directory, url)
}

export function usePreviewLifecycle(directory: () => string) {
  const serverSDK = useServerSDK()

  const stopServer = async (dir: string) => {
    if (!dir) return
    const refs = (activeSessions.get(dir) ?? 1) - 1
    activeSessions.set(dir, refs)
    if (refs > 0) return
    activeSessions.delete(dir)
    previewUrls.delete(dir)
    try {
      await serverSDK().client.global.preview.stop({ directory: dir })
    } catch {}
  }

  const startServer = async (dir: string) => {
    if (!dir) return
    const refs = (activeSessions.get(dir) ?? 0) + 1
    activeSessions.set(dir, refs)
    if (refs > 1) return
    try {
      const result = await serverSDK().client.global.preview.start({ directory: dir })
      const data = result.data as any
      if (data?.success && data?.url) {
        previewUrls.set(dir, data.url)
      }
    } catch {}
  }

  onMount(() => {
    startServer(directory())
    const dir = directory()
    if (!dir) return
    const heartbeat = setInterval(() => {
      serverSDK().client.global.preview.heartbeat({ directory: dir }).catch(() => {})
    }, HEARTBEAT_INTERVAL_MS)
    onCleanup(() => clearInterval(heartbeat))
  })

  onCleanup(() => {
    stopServer(directory())
  })

  if (typeof window !== "undefined") {
    const dir = directory()
    const handler = () => {
      if (dir) stopServer(dir)
    }
    window.addEventListener("pagehide", handler)
    window.addEventListener("beforeunload", handler)
    onCleanup(() => {
      window.removeEventListener("pagehide", handler)
      window.removeEventListener("beforeunload", handler)
    })
  }

  return {
    start: () => startServer(directory()),
    stop: () => stopServer(directory()),
  }
}
