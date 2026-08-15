import { SignJWT, jwtVerify } from "jose"

const SECRET_KEY = new TextEncoder().encode(
  process.env.OPENCODE_JWT_SECRET || "omai-default-secret-key-change-in-production"
)

const TOKEN_EXPIRY = "24h"

export interface JwtPayload {
  sub: string
  username: string
  email: string
}

export function generateToken(payload: JwtPayload): Promise<string> {
  return new SignJWT(payload as any)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(TOKEN_EXPIRY)
    .sign(SECRET_KEY)
}

export async function verifyToken(token: string): Promise<JwtPayload | null> {
  try {
    const { payload } = await jwtVerify(token, SECRET_KEY)
    return payload as unknown as JwtPayload
  } catch {
    return null
  }
}
