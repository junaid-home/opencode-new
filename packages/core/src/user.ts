import { Effect } from "effect"
import { eq, or } from "drizzle-orm"
import { UserTable } from "./sql"
import type { UserID } from "./schema"

export class UserService extends Effect.Service<UserService>() {
  static readonly layer = Effect.Service.make("UserService", () =>
    Effect.gen(function* () {
      const db = yield* Effect.promise(() => import("../database/index")).then((m) => m.db)
      const crypto = yield* Effect.promise(() => import("crypto"))

      function hashPassword(password: string): string {
        const salt = crypto.randomBytes(16).toString("hex")
        const hash = crypto.scryptSync(password, salt, 64).toString("hex")
        return `${salt}:${hash}`
      }

      function verifyPassword(password: string, stored: string): boolean {
        const [salt, hash] = stored.split(":")
        const verify = crypto.scryptSync(password, salt, 64).toString("hex")
        return hash === verify
      }

      return {
        createUser: Effect.fn("UserService.createUser")(function* (input: {
          username: string
          email: string
          password: string
        }) {
          const id = crypto.randomUUID()
          const passwordHash = hashPassword(input.password)
          const now = Date.now()

          yield* Effect.tryPromise(() =>
            db.insert(UserTable).values({
              id,
              username: input.username,
              email: input.email,
              password_hash: passwordHash,
              time_created: now,
              time_updated: now,
            })
          )

          return { id, username: input.username, email: input.email }
        }),

        authenticateUser: Effect.fn("UserService.authenticateUser")(function* (input: {
          usernameOrEmail: string
          password: string
        }) {
          const result = yield* Effect.tryPromise(() =>
            db.select().from(UserTable).where(
              or(
                eq(UserTable.username, input.usernameOrEmail),
                eq(UserTable.email, input.usernameOrEmail),
              )
            )
          )

          const user = result[0]
          if (!user) return null

          if (!verifyPassword(input.password, user.password_hash)) return null

          return { id: user.id as UserID, username: user.username, email: user.email }
        }),

        getUserById: Effect.fn("UserService.getUserById")(function* (id: string) {
          const result = yield* Effect.tryPromise(() =>
            db.select().from(UserTable).where(eq(UserTable.id, id))
          )
          return result[0] ?? null
        }),

        userExists: Effect.fn("UserService.userExists")(function* () {
          const result = yield* Effect.tryPromise(() =>
            db.select({ id: UserTable.id }).from(UserTable).limit(1)
          )
          return result.length > 0
        }),
      }
    }),
  )
}
