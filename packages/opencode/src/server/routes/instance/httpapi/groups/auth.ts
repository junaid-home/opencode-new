import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { described } from "./metadata"

const AuthSignupInput = Schema.Struct({
  username: Schema.String,
  email: Schema.String,
  password: Schema.String,
})

const AuthLoginInput = Schema.Struct({
  usernameOrEmail: Schema.String,
  password: Schema.String,
})

const AuthTokenResult = Schema.Struct({
  token: Schema.String,
  user: Schema.Struct({
    id: Schema.String,
    username: Schema.String,
    email: Schema.String,
  }),
})

const AuthUserResult = Schema.Struct({
  id: Schema.String,
  username: Schema.String,
  email: Schema.String,
})

const AuthPaths = {
  signup: "/auth/signup",
  login: "/auth/login",
  me: "/auth/me",
} as const

export const AuthApi = HttpApi.make("auth").add(
  HttpApiGroup.make("auth")
    .add(
      HttpApiEndpoint.post("signup", AuthPaths.signup, {
        payload: AuthSignupInput,
        success: described(AuthTokenResult, "User created successfully"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "auth.signup",
          summary: "Create a new user account",
          description: "Register a new user with username, email, and password.",
        }),
      ),
      HttpApiEndpoint.post("login", AuthPaths.login, {
        payload: AuthLoginInput,
        success: described(AuthTokenResult, "Login successful"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "auth.login",
          summary: "Login with credentials",
          description: "Authenticate with username or email and password.",
        }),
      ),
      HttpApiEndpoint.get("me", AuthPaths.me, {
        success: described(AuthUserResult, "Current user"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "auth.me",
          summary: "Get current user",
          description: "Get the currently authenticated user's information.",
        }),
      ),
    )
    .annotateMerge(OpenApi.annotations({ title: "auth", description: "Authentication routes." })),
)
