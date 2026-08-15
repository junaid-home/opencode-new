import { sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../database/schema.sql"

export const UserTable = sqliteTable("user", {
  id: text().primaryKey(),
  username: text().notNull().unique(),
  email: text().notNull().unique(),
  password_hash: text().notNull(),
  ...Timestamps,
})
