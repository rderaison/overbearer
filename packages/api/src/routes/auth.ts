import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../db/postgres.js';
import {
  generateRegistrationOpts,
  verifyRegistration,
  generateAuthenticationOpts,
  verifyAuthentication,
} from '../auth/passkey.js';
import {
  createSession,
  setSessionCookie,
  clearSessionCookie,
} from '../auth/session.js';
import { requireAuth } from '../auth/rbac.js';

interface UserRow {
  id: string;
  username: string;
  display_name: string | null;
  role: string;
}

export default async function authRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * GET /api/auth/setup-status
   * Public endpoint. Returns whether initial setup is needed (no users exist).
   */
  fastify.get('/api/auth/setup-status', async (_request: FastifyRequest, reply: FastifyReply) => {
    const countResult = await query<{ count: string }>('SELECT COUNT(*) as count FROM users');
    const needsSetup = parseInt(countResult.rows[0].count, 10) === 0;
    return reply.send({ needsSetup });
  });

  /**
   * POST /api/auth/setup
   * Public endpoint. Creates the first admin user WITHOUT passkey and logs them in.
   * Only works when no users exist.
   */
  fastify.post('/api/auth/setup', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as { username?: string; displayName?: string } | undefined;
    const username = body?.username?.trim();

    if (!username || username.length < 2 || username.length > 255) {
      return reply.code(400).send({ error: 'Username is required (2-255 characters)' });
    }

    // Only allow setup when no users exist
    const countResult = await query<{ count: string }>('SELECT COUNT(*) as count FROM users');
    if (parseInt(countResult.rows[0].count, 10) > 0) {
      return reply.code(403).send({ error: 'Setup already completed. Use passkey login.' });
    }

    const id = uuidv4();
    const displayName = body?.displayName?.trim() || username;
    await query(
      `INSERT INTO users (id, username, display_name, role) VALUES ($1, $2, $3, 'admin')`,
      [id, username, displayName],
    );

    const token = await createSession(id, 'admin');
    setSessionCookie(reply, token);

    return reply.send({
      user: {
        id,
        username,
        displayName,
        role: 'admin',
      },
    });
  });

  /**
   * POST /api/auth/register-passkey
   * Authenticated endpoint. Lets a logged-in user add a passkey to their account.
   * Returns WebAuthn registration options.
   */
  fastify.post(
    '/api/auth/register-passkey',
    { preHandler: requireAuth() },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.userId!;
      const userResult = await query<UserRow>(
        'SELECT id, username FROM users WHERE id = $1',
        [userId],
      );
      if (userResult.rows.length === 0) {
        return reply.code(404).send({ error: 'User not found' });
      }
      const user = userResult.rows[0];
      const options = await generateRegistrationOpts(user.id, user.username);
      return reply.send({ options, userId: user.id });
    },
  );

  /**
   * POST /api/auth/register-passkey-verify
   * Authenticated endpoint. Completes passkey registration for the current user.
   */
  fastify.post(
    '/api/auth/register-passkey-verify',
    { preHandler: requireAuth() },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as { response?: unknown } | undefined;
      const userId = request.userId!;

      if (!body?.response) {
        return reply.code(400).send({ error: 'response is required' });
      }

      try {
        const verified = await verifyRegistration(
          userId,
          body.response as Parameters<typeof verifyRegistration>[1],
        );
        if (!verified) {
          return reply.code(400).send({ error: 'Passkey verification failed' });
        }
        return reply.send({ success: true });
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    },
  );

  /**
   * GET /api/auth/has-passkey
   * Authenticated endpoint. Returns whether the current user has a passkey registered.
   */
  fastify.get(
    '/api/auth/has-passkey',
    { preHandler: requireAuth() },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const result = await query<{ count: string }>(
        'SELECT COUNT(*) as count FROM passkey_credentials WHERE user_id = $1',
        [request.userId!],
      );
      return reply.send({ hasPasskey: parseInt(result.rows[0].count, 10) > 0 });
    },
  );

  /**
   * POST /api/auth/register-options
   * Start passkey registration. First user becomes admin automatically.
   * Subsequent users need to be created by an admin (user record must already exist).
   */
  fastify.post('/api/auth/register-options', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as { username?: string; displayName?: string } | undefined;
    const username = body?.username?.trim();

    if (!username || username.length < 1 || username.length > 255) {
      return reply.code(400).send({ error: 'Username is required (1-255 characters)' });
    }

    // Check if this is the first user
    const countResult = await query<{ count: string }>('SELECT COUNT(*) as count FROM users');
    const isFirstUser = parseInt(countResult.rows[0].count, 10) === 0;

    let userId: string;
    let userRole: string;

    if (isFirstUser) {
      // Auto-create the first user as admin
      const id = uuidv4();
      const displayName = body?.displayName?.trim() || username;
      await query(
        `INSERT INTO users (id, username, display_name, role) VALUES ($1, $2, $3, 'admin')`,
        [id, username, displayName],
      );
      userId = id;
      userRole = 'admin';
    } else {
      // User must already exist (created by admin)
      const existing = await query<UserRow>(
        'SELECT id, role FROM users WHERE username = $1',
        [username],
      );
      if (existing.rows.length === 0) {
        return reply.code(403).send({
          error: 'User not found. An admin must create your account first.',
        });
      }

      // Check if user already has credentials
      const credCount = await query<{ count: string }>(
        'SELECT COUNT(*) as count FROM passkey_credentials WHERE user_id = $1',
        [existing.rows[0].id],
      );
      if (parseInt(credCount.rows[0].count, 10) > 0) {
        return reply.code(409).send({ error: 'User already has registered credentials' });
      }

      userId = existing.rows[0].id;
      userRole = existing.rows[0].role;
    }

    const options = await generateRegistrationOpts(userId, username);
    return reply.send({ options, userId, role: userRole });
  });

  /**
   * POST /api/auth/register
   * Complete passkey registration.
   */
  fastify.post('/api/auth/register', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as { userId?: string; response?: unknown } | undefined;

    if (!body?.userId || !body?.response) {
      return reply.code(400).send({ error: 'userId and response are required' });
    }

    try {
      const verified = await verifyRegistration(
        body.userId,
        body.response as Parameters<typeof verifyRegistration>[1],
      );

      if (!verified) {
        return reply.code(400).send({ error: 'Registration verification failed' });
      }

      // Fetch user to create session
      const userResult = await query<UserRow>(
        'SELECT id, username, display_name, role FROM users WHERE id = $1',
        [body.userId],
      );

      if (userResult.rows.length === 0) {
        return reply.code(404).send({ error: 'User not found' });
      }

      const user = userResult.rows[0];
      const token = await createSession(user.id, user.role);
      setSessionCookie(reply, token);

      return reply.send({
        verified: true,
        user: {
          id: user.id,
          username: user.username,
          displayName: user.display_name,
          role: user.role,
        },
      });
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  /**
   * POST /api/auth/login-options
   * Start passkey authentication (login).
   */
  fastify.post('/api/auth/login-options', async (_request: FastifyRequest, reply: FastifyReply) => {
    const options = await generateAuthenticationOpts();
    return reply.send({ options });
  });

  /**
   * POST /api/auth/login
   * Complete passkey authentication, set session cookie.
   */
  fastify.post('/api/auth/login', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as { response?: unknown } | undefined;

    if (!body?.response) {
      return reply.code(400).send({ error: 'response is required' });
    }

    try {
      const user = await verifyAuthentication(
        body.response as Parameters<typeof verifyAuthentication>[0],
      );

      const token = await createSession(user.id, user.role);
      setSessionCookie(reply, token);

      return reply.send({
        verified: true,
        user: {
          id: user.id,
          username: user.username,
          displayName: user.display_name,
          role: user.role,
        },
      });
    } catch (err) {
      return reply.code(401).send({ error: (err as Error).message });
    }
  });

  /**
   * POST /api/auth/logout
   * Clear the session cookie.
   */
  fastify.post('/api/auth/logout', async (_request: FastifyRequest, reply: FastifyReply) => {
    clearSessionCookie(reply);
    return reply.send({ success: true });
  });

  /**
   * GET /api/auth/me
   * Get current user info from session.
   */
  fastify.get(
    '/api/auth/me',
    { preHandler: requireAuth() },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userResult = await query<UserRow>(
        'SELECT id, username, display_name, role, created_at FROM users WHERE id = $1',
        [request.userId!],
      );

      if (userResult.rows.length === 0) {
        return reply.code(404).send({ error: 'User not found' });
      }

      const user = userResult.rows[0];
      return reply.send({
        id: user.id,
        username: user.username,
        displayName: user.display_name,
        role: user.role,
      });
    },
  );
}
