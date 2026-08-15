import { existsSync } from "fs"
import { readdir } from "fs/promises"
import path from "path"

export interface ProjectInfo {
  framework: string
  command: string
  packageManager: string
  defaultPort: number
  hasDevScript: boolean
  supportsHost: boolean
  portFlag: string | false
}

const FRAMEWORK_MAP: Record<string, { command: string; defaultPort: number; supportsHost: boolean; portFlag: string | false }> = {
  next: { command: "npx next dev", defaultPort: 3000, supportsHost: false, portFlag: "-p" },
  gatsby: { command: "npm run develop", defaultPort: 8000, supportsHost: false, portFlag: "-p" },
  hexo: { command: "npm run server", defaultPort: 4000, supportsHost: false, portFlag: false },
  "@angular/cli": { command: "npx ng serve", defaultPort: 4200, supportsHost: true, portFlag: "--port" },
  angular: { command: "npx ng serve", defaultPort: 4200, supportsHost: true, portFlag: "--port" },
  nuxt: { command: "npx nuxt dev", defaultPort: 3000, supportsHost: true, portFlag: "--port" },
  "@sveltejs/kit": { command: "npm run dev", defaultPort: 5173, supportsHost: true, portFlag: "--port" },
  "@remix-run/react": { command: "npm run dev", defaultPort: 5173, supportsHost: true, portFlag: "--port" },
  "@remix-run/node": { command: "npm run dev", defaultPort: 5173, supportsHost: true, portFlag: "--port" },
  astro: { command: "npm run dev", defaultPort: 4321, supportsHost: true, portFlag: "--port" },
  vite: { command: "npm run dev", defaultPort: 5173, supportsHost: true, portFlag: "--port" },
  webpack: { command: "npm run serve", defaultPort: 8080, supportsHost: true, portFlag: "--port" },
  parcel: { command: "npm run start", defaultPort: 1234, supportsHost: false, portFlag: "--port" },
  esbuild: { command: "npm run start", defaultPort: 8000, supportsHost: false, portFlag: "--port" },
  svelte: { command: "npm run dev", defaultPort: 5173, supportsHost: true, portFlag: "--port" },
  vue: { command: "npm run dev", defaultPort: 5173, supportsHost: true, portFlag: "--port" },
  react: { command: "npm run dev", defaultPort: 5173, supportsHost: true, portFlag: "--port" },
  "react-dom": { command: "npm run dev", defaultPort: 5173, supportsHost: true, portFlag: "--port" },
  "solid-js": { command: "npm run dev", defaultPort: 3000, supportsHost: true, portFlag: "--port" },
  preact: { command: "npm run dev", defaultPort: 5173, supportsHost: true, portFlag: "--port" },
  lit: { command: "npm run dev", defaultPort: 5173, supportsHost: true, portFlag: "--port" },
  alpinejs: { command: "npm run dev", defaultPort: 5173, supportsHost: true, portFlag: "--port" },
  "htmx.org": { command: "npm run dev", defaultPort: 5173, supportsHost: true, portFlag: "--port" },
}

const DEV_SCRIPTS = ["dev", "develop", "serve", "start:dev", "start:app", "dev:app", "run:dev"]

const LOCKFILES: Record<string, string> = {
  "bun.lockb": "bun",
  "bun.lock": "bun",
  "pnpm-lock.yaml": "pnpm",
  "yarn.lock": "yarn",
  "package-lock.json": "npm",
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", ".nuxt", "__MACOSX"])

const BACKEND_PACKAGES = new Set([
  "express", "fastify", "koa", "hapi", "nest", "@nestjs/core", "@nestjs/common",
  "hono", "elysia", "bun", "deno", "@effect/platform", "aws-lambda",
  "serverless", "socket.io", "ws", "graphql", "prisma", "drizzle-orm",
  "mongoose", "sequelize", "typeorm", "knex",
])

function isFrontendProject(deps: Record<string, string>): boolean {
  for (const key of Object.keys(FRAMEWORK_MAP)) {
    if (deps[key]) return true
  }
  const depKeys = Object.keys(deps)
  if (depKeys.length === 0) return false
  const hasBackend = depKeys.some((k) => BACKEND_PACKAGES.has(k))
  const hasFrontend = depKeys.some((k) => FRAMEWORK_MAP[k] !== undefined)
  if (hasBackend && !hasFrontend) return false
  return true
}

async function readJsonFile(filePath: string): Promise<Record<string, any> | null> {
  try {
    const content = await Bun.file(filePath).text()
    return JSON.parse(content)
  } catch {
    return null
  }
}

async function findPackageJson(directory: string, maxDepth = 3): Promise<{ dir: string; pkg: Record<string, any> } | null> {
  const rootResult = await tryLoadPackageJson(directory)
  if (rootResult) return rootResult
  return searchSubdirectories(directory, 0, maxDepth)
}

async function tryLoadPackageJson(directory: string): Promise<{ dir: string; pkg: Record<string, any> } | null> {
  const pkgPath = path.join(directory, "package.json")
  if (!existsSync(pkgPath)) return null
  const pkg = await readJsonFile(pkgPath)
  return pkg ? { dir: directory, pkg } : null
}

async function searchSubdirectories(directory: string, depth: number, maxDepth: number): Promise<{ dir: string; pkg: Record<string, any> } | null> {
  if (depth >= maxDepth) return null
  let entries: string[]
  try {
    entries = await readdir(directory)
  } catch {
    return null
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry) || entry.startsWith(".")) continue
    const fullPath = path.join(directory, entry)
    const result = await tryLoadPackageJson(fullPath)
    if (result && result.pkg.scripts) return result
    const subResult = await searchSubdirectories(fullPath, depth + 1, maxDepth)
    if (subResult) return subResult
  }
  return null
}

export async function detectProject(directory: string): Promise<ProjectInfo | null> {
  const found = await findPackageJson(directory)
  if (found) {
    const { dir, pkg } = found
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies }
    const scripts = pkg.scripts ?? {}
    const packageManager = await detectPackageManager(dir)
    const runCmd = getRunCommand(packageManager)
    const devScript = findDevScript(scripts)
    const framework = detectFramework(allDeps)
    const fw = framework && FRAMEWORK_MAP[framework] ? FRAMEWORK_MAP[framework] : null

    if (devScript) {
      return {
        framework: framework || "unknown",
        command: `cd ${JSON.stringify(dir)} && ${runCmd} ${devScript}`,
        packageManager,
        defaultPort: fw?.defaultPort ?? 5173,
        hasDevScript: true,
        supportsHost: fw?.supportsHost ?? false,
        portFlag: fw?.portFlag ?? false,
      }
    }
    if (scripts.start) {
      return {
        framework: framework || "unknown",
        command: `cd ${JSON.stringify(dir)} && ${runCmd} start`,
        packageManager,
        defaultPort: fw?.defaultPort ?? 3000,
        hasDevScript: false,
        supportsHost: fw?.supportsHost ?? false,
        portFlag: fw?.portFlag ?? false,
      }
    }
    if (scripts.serve) {
      return {
        framework: framework || "unknown",
        command: `cd ${JSON.stringify(dir)} && ${runCmd} serve`,
        packageManager,
        defaultPort: fw?.defaultPort ?? 8080,
        hasDevScript: false,
        supportsHost: fw?.supportsHost ?? false,
        portFlag: fw?.portFlag ?? false,
      }
    }
  }

  if (await isStaticHtmlDirectory(directory)) {
    return {
      framework: "static",
      command: "npx serve",
      packageManager: "npm",
      defaultPort: 3000,
      hasDevScript: false,
      supportsHost: false,
      portFlag: "-l",
    }
  }
  return null
}

async function isStaticHtmlDirectory(directory: string): Promise<boolean> {
  let entries: string[]
  try {
    entries = await readdir(directory)
  } catch {
    return false
  }
  if (entries.includes("index.html")) return true
  return entries.filter((e) => e.endsWith(".html") && !e.startsWith(".")).length >= 2
}

function findDevScript(scripts: Record<string, string>): string | null {
  for (const name of DEV_SCRIPTS) {
    if (scripts[name]) return name
  }
  return null
}

function getRunCommand(packageManager: string): string {
  switch (packageManager) {
    case "bun": return "bun run"
    case "pnpm": return "pnpm"
    case "yarn": return "yarn"
    default: return "npm run"
  }
}

function detectFramework(deps: Record<string, string>): string {
  for (const key of Object.keys(FRAMEWORK_MAP)) {
    if (deps[key]) return key
  }
  return ""
}

async function detectPackageManager(directory: string): Promise<string> {
  for (const [lockfile, manager] of Object.entries(LOCKFILES)) {
    if (existsSync(path.join(directory, lockfile))) return manager
  }
  return "npm"
}
