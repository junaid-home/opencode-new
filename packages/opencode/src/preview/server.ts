import { type ChildProcess as ChildProcessType } from "child_process"
import { spawn } from "child_process"
import { existsSync } from "fs"
import path from "path"
import { detectProject, type ProjectInfo } from "./detect"
import { registerDisposer } from "@/effect/instance-registry"

const STARTUP_TIMEOUT_MS = 60_000
const INSTALL_TIMEOUT_MS = 120_000
const IDLE_TTL_MS = 180_000
const SWEEP_INTERVAL_MS = 60_000
const RESERVED_PORT = 3000

interface DevServer {
  process: ChildProcessType
  port: number
  hostname: string
  projectInfo: ProjectInfo
  status: "starting" | "running" | "error" | "installing"
  directory: string
  refs: number
  lastActive: number
}

const servers = new Map<string, DevServer>()
const slugToDir = new Map<string, string>()
const locks = new Map<string, Promise<{ sessionId: string; port: number; framework: string }>>()
const portMap = new Map<string, number>()
// Clients that shared an in-flight start promise without bumping the running
// server's refs. Merged into server.refs when the start settles so a stop from
// one owner can't SIGKILL a server another owner still depends on.
const pendingRefs = new Map<string, number>()
let sweepTimer: ReturnType<typeof setInterval> | undefined

function appendHostFlag(command: string, _packageManager: string, port: number, projectInfo: ProjectInfo): string {
  const isDocker = existsSync("/.dockerenv") || process.env.OPENCODE_DOCKER === "1"
  const parts: string[] = []
  if (projectInfo.supportsHost) {
    parts.push(isDocker ? "--host 0.0.0.0" : "--host localhost")
  }
  if (projectInfo.portFlag) {
    parts.push(`${projectInfo.portFlag} ${port}`)
  }
  if (parts.length === 0) return command
  const flags = parts.join(" ")
  if (command.includes("npm run") || command.includes("bun run")) return `${command} -- ${flags}`
  return `${command} ${flags}`
}

function dirSlug(directory: string): string {
  return directory.split("/").filter(Boolean).pop() || "unknown"
}

async function isPortAvailable(port: number): Promise<boolean> {
  const net = await import("net")
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once("error", () => resolve(false))
    server.listen(port, () => {
      server.close(() => resolve(true))
    })
  })
}

async function getOrCreatePort(directory: string): Promise<number> {
  const stored = portMap.get(directory)
  if (stored && (await isPortAvailable(stored))) return stored
  const port = await findFreePort()
  portMap.set(directory, port)
  return port
}

async function findFreePort(): Promise<number> {
  const net = await import("net")
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, () => {
      const addr = server.address()
      if (addr && typeof addr === "object") {
        server.close(() => resolve(addr.port))
      } else {
        server.close(() => reject(new Error("Failed to find free port")))
      }
    })
    server.on("error", reject)
  })
}

function hasNodeModules(directory: string): boolean {
  return existsSync(path.join(directory, "node_modules"))
}

function getInstallCommand(packageManager: string): string {
  switch (packageManager) {
    case "bun": return "bun install --ignore-scripts"
    case "pnpm": return "pnpm install --ignore-scripts"
    case "yarn": return "yarn install --ignore-scripts"
    default: return "npm install --ignore-scripts"
  }
}

async function installDependencies(directory: string, packageManager: string): Promise<void> {
  if (hasNodeModules(directory)) return
  const cmd = getInstallCommand(packageManager)
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Install timed out")), INSTALL_TIMEOUT_MS)
    const child = spawn("sh", ["-c", cmd], { cwd: directory, stdio: ["ignore", "pipe", "pipe"] })
    let output = ""
    child.stdout?.on("data", (d: Buffer) => { output += d.toString() })
    child.stderr?.on("data", (d: Buffer) => { output += d.toString() })
    child.on("close", (code) => {
      clearTimeout(timeout)
      if (code === 0) resolve()
      else reject(new Error(`Install failed (code ${code}): ${output.slice(-300)}`))
    })
    child.on("error", (err) => { clearTimeout(timeout); reject(err) })
  })
}

const PORT_RE = /(?:localhost|127\.0\.0\.1|0\.0\.0\.0)[:\s]+(\d{2,5})/g
const LOCAL_RE =
  /(?:Local|App|ready|started|listening|Server running|http server|VITE|listening on|Accepting connections at)[\s:]*(https?:\/\/[^\s]+)/i
const BOUND_RE = /(?:bound|listening on|available at|Accepting connections at)[\s:]*(?:https?:\/\/)?([^\s:]+):(\d+)/i
const FAIL_RE = /already running|EADDRINUSE|address already in use|port \d+ (?:is )?in use(?!.*trying another)/i

function extractHostAndPort(output: string): { host: string; port: number } | null {
  const m = LOCAL_RE.exec(output)
  if (m) {
    try {
      const url = new URL(m[1])
      const port = url.port ? Number(url.port) : null
      if (port) return { host: url.hostname, port }
    } catch {}
  }
  const m2 = BOUND_RE.exec(output)
  if (m2 && m2[2]) return { host: m2[1], port: Number(m2[2]) }
  let match: RegExpExecArray | null
  while ((match = PORT_RE.exec(output)) !== null) {
    const port = Number(match[1])
    if (port >= 1000 && port <= 65535) return { host: match[0].split(/[:\s]/)[0], port }
  }
  return null
}

function isReadyOutput(output: string): boolean {
  return /ready|listening|started|compiled|vite.*ready|server running|available at|serving|accepting connections/i.test(output)
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

function forceKillTree(child: ChildProcessType): void {
  const pid = child.pid
  if (!pid) return
  try { process.kill(-pid, "SIGKILL") } catch {}
  try { child.kill("SIGKILL") } catch {}
}

function forceKillAndWait(child: ChildProcessType, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve) => {
    const pid = child.pid
    if (!pid || !isAlive(pid)) { resolve(); return }
    forceKillTree(child)
    const deadline = Date.now() + timeoutMs
    const check = () => {
      if (!isAlive(pid) || Date.now() > deadline) { resolve(); return }
      setTimeout(check, 50)
    }
    check()
  })
}

async function killProcessOnPort(port: number): Promise<void> {
  if (port === RESERVED_PORT) return
  try {
    const { execSync } = await import("child_process")
    const cmd = process.platform === "darwin"
      ? `lsof -ti tcp:${port} 2>/dev/null`
      : `ss -tlnp 'sport = :${port}' 2>/dev/null | grep -oP 'pid=\\K[0-9]+'`
    const pids = execSync(cmd, { encoding: "utf-8", timeout: 5000 }).trim()
    if (!pids) return
    for (const pid of pids.split("\n").filter(Boolean)) {
      const pidNum = Number(pid)
      if (pidNum === process.pid) continue
      try { process.kill(pidNum, "SIGKILL") } catch {}
    }
  } catch {}
}

export async function initPreview(): Promise<void> {
  try {
    const { execSync } = await import("child_process")
    // Start at 3001 so the frontend's reserved port 3000 is never swept.
    const cmd = process.platform === "darwin"
      ? `lsof -ti tcp:3001-9000 2>/dev/null`
      : `ss -tlnp 'sport >= :3001 and sport <= :9000' 2>/dev/null | grep -oP 'pid=\\K[0-9]+'`
    const pids = execSync(cmd, { encoding: "utf-8", timeout: 5000 }).trim()
    if (!pids) return
    for (const pid of pids.split("\n").filter(Boolean)) {
      const pidNum = Number(pid)
      if (pidNum === process.pid) continue
      try { process.kill(pidNum, "SIGKILL") } catch {}
    }
  } catch {}
}

export async function startDevServer(directory: string): Promise<{ sessionId: string; port: number; framework: string }> {
  scheduleSweep()
  const existing = servers.get(directory)
  if (existing && existing.status === "running" && existing.port > 0) {
    existing.refs++
    existing.lastActive = Date.now()
    return { sessionId: directory, port: existing.port, framework: existing.projectInfo.framework }
  }
  const pending = locks.get(directory)
  if (pending) {
    pendingRefs.set(directory, (pendingRefs.get(directory) ?? 0) + 1)
    return pending.finally(() => {
      const extra = pendingRefs.get(directory) ?? 0
      if (extra > 0) {
        pendingRefs.delete(directory)
        const server = servers.get(directory)
        if (server) server.refs += extra
      }
    })
  }
  const promise = startDevServerInner(directory)
  locks.set(directory, promise)
  promise.finally(() => locks.delete(directory))
  return promise
}

async function startDevServerInner(directory: string): Promise<{ sessionId: string; port: number; framework: string }> {
  const existing = servers.get(directory)
  if (existing && existing.status === "running" && existing.port > 0) {
    existing.refs++
    existing.lastActive = Date.now()
    return { sessionId: directory, port: existing.port, framework: existing.projectInfo.framework }
  }
  if (existing) {
    servers.delete(directory)
    await forceKillAndWait(existing.process)
  }
  const storedPort = portMap.get(directory)
  if (storedPort) await killProcessOnPort(storedPort)

  const projectInfo = await detectProject(directory)
  if (!projectInfo) throw new Error("No dev server command found. Add a 'dev' script to package.json.")

  if (projectInfo.framework !== "static") {
    await installDependencies(directory, projectInfo.packageManager)
  }

  const isDocker = existsSync("/.dockerenv") || process.env.OPENCODE_DOCKER === "1"
  const port = await getOrCreatePort(directory)
  const bind = isDocker ? "0.0.0.0" : "localhost"
  const env = { ...process.env, PORT: String(port), HOST: bind, HOSTNAME: bind, VITE_HOST: bind, BIND: bind, BROWSER: "none" }
  const command = appendHostFlag(projectInfo.command, projectInfo.packageManager, port, projectInfo)
  const child = spawn("sh", ["-c", command], { cwd: directory, env, stdio: ["ignore", "pipe", "pipe"], detached: true })

  const server: DevServer = { process: child, port: 0, hostname: process.env.OPENCODE_HOST || "localhost", projectInfo, status: "starting", directory, refs: 1, lastActive: Date.now() }
  servers.set(directory, server)

  return new Promise((resolve, reject) => {
    let output = ""
    let resolved = false
    let detected: { host: string; port: number } | null = null

    const cleanup = (err?: Error) => {
      if (resolved) return
      resolved = true
      forceKillTree(child)
      if (!detected) servers.delete(directory)
      if (err) reject(err)
    }

    const timeout = setTimeout(() => {
      cleanup(new Error(`Dev server timed out after ${STARTUP_TIMEOUT_MS / 1000}s. Output:\n${output.slice(-500)}`))
    }, STARTUP_TIMEOUT_MS)

    const handleOutput = (data: Buffer) => {
      const chunk = data.toString()
      output += chunk
      if (!resolved && FAIL_RE.test(output)) { clearTimeout(timeout); cleanup(new Error(`Dev server failed to start. Output:\n${output.slice(-500)}`)); return }
      if (!resolved && !detected) detected = extractHostAndPort(output)
      if (!resolved && detected && isReadyOutput(output)) {
        clearTimeout(timeout)
        resolved = true
        server.port = detected.port
        server.hostname = detected.host
        server.status = "running"
        portMap.set(directory, detected.port)
        slugToDir.set(dirSlug(directory), directory)
        resolve({ sessionId: directory, port: detected.port, framework: projectInfo.framework })
      }
    }

    child.stdout?.on("data", handleOutput)
    child.stderr?.on("data", handleOutput)
    child.on("error", cleanup)
    child.on("exit", (code, signal) => {
      clearTimeout(timeout)
      if (!resolved) {
        resolved = true
        server.status = "error"
        servers.delete(directory)
        reject(new Error(`Dev server exited with code ${signal || code}. Output:\n${output.slice(-500)}`))
      } else if (servers.get(directory) === server) {
        servers.delete(directory)
      }
    })
  })
}

export function stopDevServer(directory: string): boolean {
  const server = servers.get(directory)
  if (server) {
    server.refs--
    if (server.refs > 0) return false
    if ((pendingRefs.get(directory) ?? 0) > 0) return false
    terminateServer(server)
    return true
  }
  const pending = pendingRefs.get(directory)
  if (pending && pending > 0) pendingRefs.set(directory, pending - 1)
  return false
}

export function touchDevServer(directory: string): void {
  const server = servers.get(directory)
  if (server) server.lastActive = Date.now()
}

export function collectIdleServers(
  entries: Iterable<{ directory: string; lastActive: number }>,
  now: number,
  idleMs: number,
): string[] {
  const idle: string[] = []
  for (const entry of entries) {
    if (now - entry.lastActive > idleMs) idle.push(entry.directory)
  }
  return idle
}

function terminateServer(server: DevServer): void {
  servers.delete(server.directory)
  slugToDir.delete(dirSlug(server.directory))
  portMap.delete(server.directory)
  forceKillTree(server.process)
  forceKillAndWait(server.process, 5000).then(() => {
    if (server.port > 0) killProcessOnPort(server.port)
  })
}

function sweepIdleServers(): void {
  const now = Date.now()
  for (const directory of collectIdleServers(servers.values(), now, IDLE_TTL_MS)) {
    const server = servers.get(directory)
    if (server) terminateServer(server)
  }
  if (servers.size === 0 && sweepTimer !== undefined) {
    clearInterval(sweepTimer)
    sweepTimer = undefined
  }
}

function scheduleSweep(): void {
  if (sweepTimer !== undefined) return
  sweepTimer = setInterval(sweepIdleServers, SWEEP_INTERVAL_MS)
}

registerDisposer(async (directory) => {
  stopDevServer(directory)
})

export function directoryFromSlug(slug: string): string | undefined {
  return slugToDir.get(slug)
}

export function getDevServerStatus(directory: string): { running: boolean; hostname?: string; port?: number; framework?: string } {
  const server = servers.get(directory)
  if (!server || server.status !== "running") return { running: false }
  if (server.process.pid && !isAlive(server.process.pid)) {
    servers.delete(directory)
    return { running: false }
  }
  return { running: true, hostname: server.hostname, port: server.port, framework: server.projectInfo.framework }
}
