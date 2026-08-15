import { Effect } from "effect"
import { sql } from "drizzle-orm"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260723000000_add_user_table",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(sql`
        CREATE TABLE IF NOT EXISTS ${sql.identifier("user")} (
          ${sql.identifier("id")} text PRIMARY KEY,
          ${sql.identifier("username")} text NOT NULL,
          ${sql.identifier("email")} text NOT NULL,
          ${sql.identifier("password_hash")} text NOT NULL,
          ${sql.identifier("time_created")} integer NOT NULL,
          ${sql.identifier("time_updated")} integer NOT NULL
        )
      `)
      yield* tx.run(sql`CREATE UNIQUE INDEX IF NOT EXISTS ${sql.identifier("user_username_unique")} ON ${sql.identifier("user")} (${sql.identifier("username")})`)
      yield* tx.run(sql`CREATE UNIQUE INDEX IF NOT EXISTS ${sql.identifier("user_email_unique")} ON ${sql.identifier("user")} (${sql.identifier("email")})`)
    })
  },
} satisfies DatabaseMigration.Migration
