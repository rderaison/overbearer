import { SignJWT, jwtVerify } from 'jose';
import type { FastifyReply, FastifyRequest } from 'fastify';

const JWT_SECRET_ENV = 'OVERBEARER_JWT_SECRET';
const COOKIE_NAME = 'overbearer_session';
const TOKEN_EXPIRY = '8h';

function getSecret(): Uint8Array {
  const secret = process.env[JWT_SECRET_ENV];
  if (!secret) {
    throw new Error(`${JWT_SECRET_ENV} environment variable is required`);
  }
  return new TextEncoder().encode(secret);
}

export interface SessionPayload {
  userId: string;
  role: string;
}

/**
 * Create a signed JWT containing the user's ID and role.
 */
export async function createSession(userId: string, role: string): Promise<string> {
  const token = await new SignJWT({ userId, role })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(TOKEN_EXPIRY)
    .setIssuer('overbearer')
    .sign(getSecret());

  return token;
}

/**
 * Verify a JWT and return the session payload.
 */
export async function verifySession(token: string): Promise<SessionPayload> {
  const { payload } = await jwtVerify(token, getSecret(), {
    issuer: 'overbearer',
  });

  const userId = payload.userId as string | undefined;
  const role = payload.role as string | undefined;

  if (!userId || !role) {
    throw new Error('Invalid session token');
  }

  return { userId, role };
}

/**
 * Set the session JWT as an httpOnly secure cookie on the response.
 */
export function setSessionCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
    maxAge: 8 * 60 * 60, // 8 hours in seconds
  });
}

/**
 * Read the session JWT from the request cookie.
 */
export function getSessionCookie(request: FastifyRequest): string | undefined {
  return request.cookies[COOKIE_NAME];
}

/**
 * Clear the session cookie.
 */
export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
  });
}
