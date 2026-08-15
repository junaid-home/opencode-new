import { existsSync, unlinkSync } from "fs"
import path from "path"

const THUMBNAIL_DIR = ".OMAI+/thumbnails"
const THUMBNAIL_FILE = "preview.png"

export interface ThumbnailInfo {
  exists: boolean
  path?: string
  url?: string
}

function getThumbnailPath(directory: string): string {
  return path.join(directory, THUMBNAIL_DIR, THUMBNAIL_FILE)
}

export function getThumbnailInfo(directory: string): ThumbnailInfo {
  const thumbnailPath = getThumbnailPath(directory)
  const exists = existsSync(thumbnailPath)
  return {
    exists,
    path: exists ? thumbnailPath : undefined,
    url: exists ? `/preview/thumbnail/${encodeDirectory(directory)}` : undefined,
  }
}

export function getThumbnailFilePath(directory: string): string | null {
  const thumbnailPath = getThumbnailPath(directory)
  return existsSync(thumbnailPath) ? thumbnailPath : null
}

export function encodeDirectory(directory: string): string {
  const bytes = new TextEncoder().encode(directory)
  const binary = Array.from(bytes, (b) => String.fromCharCode(b)).join("")
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

export function decodeDirectory(encoded: string): string | null {
  try {
    const std = encoded.replace(/-/g, "+").replace(/_/g, "/")
    const padded = std + "=".repeat((4 - (std.length % 4)) % 4)
    const decoded = Buffer.from(padded, "base64").toString("utf-8")
    if (!decoded || !decoded.startsWith("/")) return null
    return decoded
  } catch {
    return null
  }
}

export function deleteThumbnail(directory: string): boolean {
  const thumbnailPath = getThumbnailPath(directory)
  if (existsSync(thumbnailPath)) {
    unlinkSync(thumbnailPath)
    return true
  }
  return false
}
