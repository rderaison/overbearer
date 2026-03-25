import type { FastifyRequest, FastifyReply, preHandlerHookHandler } from 'fastify';
import { verifySession, getSessionCookie } from './session.js';

/** Roles in ascending order of privilege. */
const ROLE_HIERARCHY = ['requester', 'viewer', 'manager', 'admin'] as const;
export type Role = (typeof ROLE_HIERARCHY)[number];

declare module 'fastify' {
  interface FastifyRequest {
    userId?: string;
    userRole?: Role;
  }
}

function getRoleLevel(role: string): number {
  const idx = ROLE_HIERARCHY.indexOf(role as Role);
  return idx === -1 ? -1 : idx;
}

/**
 * Extract and attach user info from the session cookie to the request.
 * Does not reject unauthenticated requests -- use requireAuth/requireRole for that.
 */
async function extractUser(request: FastifyRequest): Promise<boolean> {
  const token = getSessionCookie(request);
  if (!token) return false;

  try {
    const session = await verifySession(token);
    request.userId = session.userId;
    request.userRole = session.role as Role;
    return true;
  } catch {
    return false;
  }
}

/**
 * Fastify preHandler hook that requires any authenticated user.
 */
export function requireAuth(): preHandlerHookHandler {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const authenticated = await extractUser(request);
    if (!authenticated) {
      reply.code(401).send({ error: 'Authentication required' });
    }
  };
}

/**
 * Fastify preHandler hook that requires a minimum role level.
 * admin > manager > viewer > requester
 */
export function requireRole(minRole: Role): preHandlerHookHandler {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const authenticated = await extractUser(request);
    if (!authenticated) {
      reply.code(401).send({ error: 'Authentication required' });
      return;
    }

    const userLevel = getRoleLevel(request.userRole!);
    const requiredLevel = getRoleLevel(minRole);

    if (userLevel < requiredLevel) {
      reply.code(403).send({ error: 'Insufficient permissions' });
    }
  };
}
