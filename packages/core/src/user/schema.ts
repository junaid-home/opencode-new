import { Schema } from "effect"

export const UserID = Schema.String.pipe(Schema.brand("User.ID"))

export type UserID = typeof UserID.Type

export const User = Schema.Struct({
  id: UserID,
  username: Schema.String,
  email: Schema.String,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
})

export type User = typeof User.Type
