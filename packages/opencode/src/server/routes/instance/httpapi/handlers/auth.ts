// @ts-nocheck
import { Effect } from "effect"
import { eq, or } from "drizzle-orm"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { Database } from "@opencode-ai/core/database/database"
import { UserTable } from "@/user/sql"
import { RootHttpApi } from "../api"
import { generateToken, verifyToken } from "@/auth/jwt"
import { hashPassword, verifyPassword } from "@/user"
import { randomUUID } from "crypto"

export const authHandlers = HttpApiBuilder.group(RootHttpApi, "auth", (handlers) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    return handlers
      .handleRaw("signup", Effect.fn("Auth.signup")(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const body = yield* Effect.orDie(request.json)
        const { username, email, password } = body as any

        if (!username || username.length < 3 || username.length > 30) {
          return HttpServerResponse.jsonUnsafe({ error: "Username must be 3-30 characters" }, { status: 400 })
        }
        if (!email || !email.includes("@")) {
          return HttpServerResponse.jsonUnsafe({ error: "Invalid email address" }, { status: 400 })
        }
        if (!password || password.length < 6) {
          return HttpServerResponse.jsonUnsafe({ error: "Password must be at least 6 characters" }, { status: 400 })
        }

        const id = randomUUID()
        const passwordHash = hashPassword(password)
        const now = Date.now()

        yield* db.insert(UserTable).values({
          id,
          username,
          email,
          password_hash: passwordHash,
          time_created: now,
          time_updated: now,
        })

        const token = yield* Effect.tryPromise({ try: () => generateToken({ sub: id, username, email }), catch: (e) => new Error(String(e)) })
        return HttpServerResponse.jsonUnsafe({ token, user: { id, username, email } })
      }))

      .handleRaw("login", Effect.fn("Auth.login")(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const body = yield* Effect.orDie(request.json)
        const { usernameOrEmail, password } = body as any

        if (!usernameOrEmail || !password) {
          return HttpServerResponse.jsonUnsafe({ error: "Username/email and password are required" }, { status: 400 })
        }

        const result = yield* db.select().from(UserTable).where(
          or(
            eq(UserTable.username, usernameOrEmail),
            eq(UserTable.email, usernameOrEmail),
          )
        ).all()
        const user = result[0]
        if (!user) {
          return HttpServerResponse.jsonUnsafe({ error: "Invalid credentials" }, { status: 401 })
        }
        if (!verifyPassword(password, user.password_hash)) {
          return HttpServerResponse.jsonUnsafe({ error: "Invalid credentials" }, { status: 401 })
        }
        const token = yield* Effect.tryPromise({ try: () => generateToken({ sub: user.id, username: user.username, email: user.email }), catch: (e) => new Error(String(e)) })
        return HttpServerResponse.jsonUnsafe({ token, user: { id: user.id, username: user.username, email: user.email } })
      }))

      .handleRaw("me", Effect.fn("Auth.me")(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const authHeader = request.headers["authorization"]
        if (!authHeader || !authHeader.startsWith("Bearer ")) {
          return HttpServerResponse.jsonUnsafe({ error: "Not authenticated" }, { status: 401 })
        }
        const token = authHeader.slice(7)
        const payload = yield* Effect.tryPromise({ try: () => verifyToken(token), catch: () => null })
        if (!payload) {
          return HttpServerResponse.jsonUnsafe({ error: "Invalid or expired token" }, { status: 401 })
        }
        const users = yield* db.select().from(UserTable).where(eq(UserTable.id, payload.sub)).all()
        const user = users[0]
        if (!user) {
          return HttpServerResponse.jsonUnsafe({ error: "User not found" }, { status: 401 })
        }
        return HttpServerResponse.jsonUnsafe({ id: user.id, username: user.username, email: user.email })
      }))
  }),
)
