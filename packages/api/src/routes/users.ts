import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { randomBytes } from 'node:crypto';
import { query } from '../db/postgres.js';
import { requireRole } from '../auth/rbac.js';
import type { Role } from '../auth/rbac.js';
import { createSession, setSessionCookie } from '../auth/session.js';

const VALID_ROLES: Role[] = ['requester', 'viewer', 'manager', 'admin'];

interface UserRow {
  id: string;
  username: string;
  display_name: string | null;
  role: string;
  created_at: string;
  updated_at: string;
}

export default async function userRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * GET /api/users
   * List all users (admin only).
   */
  fastify.get(
    '/api/users',
    { preHandler: requireRole('admin') },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const result = await query<UserRow>(
        `SELECT id, username, display_name, role, created_at, updated_at
         FROM users
         ORDER BY created_at ASC`,
      );

      // Fetch group memberships for all users
      const groupResult = await query<{ user_id: string; group_id: string; group_name: string }>(
        `SELECT gm.user_id, gm.group_id, g.name as group_name
         FROM group_members gm JOIN groups g ON gm.group_id = g.id`,
      );
      const userGroups: Record<string, { id: string; name: string }[]> = {};
      for (const row of groupResult.rows) {
        (userGroups[row.user_id] ??= []).push({ id: row.group_id, name: row.group_name });
      }

      return reply.send({
        users: result.rows.map((u) => ({
          id: u.id,
          username: u.username,
          displayName: u.display_name,
          role: u.role,
          groups: userGroups[u.id] ?? [],
          createdAt: u.created_at,
          updatedAt: u.updated_at,
        })),
      });
    },
  );

  /**
   * POST /api/users
   * Create a new user (admin only). The user can then register a passkey.
   */
  fastify.post(
    '/api/users',
    { preHandler: requireRole('admin') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as {
        username?: string;
        displayName?: string;
        role?: string;
      } | undefined;

      const username = body?.username?.trim();
      if (!username || username.length < 1 || username.length > 255) {
        return reply.code(400).send({ error: 'username is required (1-255 characters)' });
      }

      const role = (body?.role?.trim() || 'viewer') as Role;
      if (!VALID_ROLES.includes(role)) {
        return reply.code(400).send({ error: `role must be one of: ${VALID_ROLES.join(', ')}` });
      }

      const displayName = body?.displayName?.trim() || username;

      // Check if username already exists
      const existing = await query<{ id: string }>(
        'SELECT id FROM users WHERE username = $1',
        [username],
      );
      if (existing.rows.length > 0) {
        return reply.code(409).send({ error: 'Username already exists' });
      }

      const id = uuidv4();
      await query(
        `INSERT INTO users (id, username, display_name, role) VALUES ($1, $2, $3, $4)`,
        [id, username, displayName, role],
      );

      // Generate invite token (valid 7 days)
      const inviteToken = randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      await query(
        `INSERT INTO invite_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)`,
        [id, inviteToken, expiresAt],
      );

      const origin = process.env.OVERBEARER_ORIGIN || `https://${process.env.OVERBEARER_RP_ID || 'localhost'}`;
      const inviteUrl = `${origin}/invite/${inviteToken}`;

      return reply.code(201).send({
        id,
        username,
        displayName,
        role,
        inviteUrl,
      });
    },
  );

  /**
   * GET /api/invite/:token
   * Public. Validate an invite token and return user info.
   */
  fastify.get(
    '/api/invite/:token',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { token } = request.params as { token: string };
      const result = await query<{ user_id: string; expires_at: string; used: boolean }>(
        `SELECT i.user_id, i.expires_at, i.used, u.username, u.display_name, u.role
         FROM invite_tokens i
         JOIN users u ON i.user_id = u.id
         WHERE i.token = $1`,
        [token],
      );

      if (result.rows.length === 0) {
        return reply.code(404).send({ error: 'Invalid invite link' });
      }
      const row = result.rows[0] as any;
      if (row.used) {
        return reply.code(410).send({ error: 'This invite has already been used' });
      }
      if (new Date(row.expires_at) < new Date()) {
        return reply.code(410).send({ error: 'This invite has expired' });
      }

      return reply.send({
        username: row.username,
        displayName: row.display_name,
        role: row.role,
      });
    },
  );

  /**
   * POST /api/invite/:token/accept
   * Public. Accept invite — logs the user in (sets session cookie).
   * The user can then register a passkey from Settings.
   */
  fastify.post(
    '/api/invite/:token/accept',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { token } = request.params as { token: string };
      const result = await query<{ id: string; user_id: string; expires_at: string; used: boolean }>(
        `SELECT i.id, i.user_id, i.expires_at, i.used, u.role
         FROM invite_tokens i
         JOIN users u ON i.user_id = u.id
         WHERE i.token = $1`,
        [token],
      );

      if (result.rows.length === 0) {
        return reply.code(404).send({ error: 'Invalid invite link' });
      }
      const row = result.rows[0] as any;
      if (row.used) {
        return reply.code(410).send({ error: 'This invite has already been used' });
      }
      if (new Date(row.expires_at) < new Date()) {
        return reply.code(410).send({ error: 'This invite has expired' });
      }

      // Mark invite as used
      await query('UPDATE invite_tokens SET used = TRUE WHERE id = $1', [row.id]);

      // Create session
      const sessionToken = await createSession(row.user_id, row.role);
      setSessionCookie(reply, sessionToken);

      return reply.send({ success: true });
    },
  );

  /**
   * PATCH /api/users/:id
   * Update a user's role (admin only).
   */
  fastify.patch(
    '/api/users/:id',
    { preHandler: requireRole('admin') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const body = request.body as { role?: string } | undefined;

      const role = body?.role?.trim() as Role | undefined;
      if (!role || !VALID_ROLES.includes(role)) {
        return reply.code(400).send({ error: `role must be one of: ${VALID_ROLES.join(', ')}` });
      }

      // Prevent admin from demoting themselves
      if (id === request.userId && role !== 'admin') {
        return reply.code(400).send({ error: 'You cannot change your own role' });
      }

      const result = await query<UserRow>(
        `UPDATE users SET role = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
        [role, id],
      );

      if (result.rows.length === 0) {
        return reply.code(404).send({ error: 'User not found' });
      }

      const user = result.rows[0];
      return reply.send({
        id: user.id,
        username: user.username,
        displayName: user.display_name,
        role: user.role,
      });
    },
  );

  /**
   * DELETE /api/users/:id
   * Delete a user (admin only).
   */
  fastify.delete(
    '/api/users/:id',
    { preHandler: requireRole('admin') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };

      // Prevent admin from deleting themselves
      if (id === request.userId) {
        return reply.code(400).send({ error: 'You cannot delete yourself' });
      }

      const result = await query(
        'DELETE FROM users WHERE id = $1 RETURNING id',
        [id],
      );

      if (result.rows.length === 0) {
        return reply.code(404).send({ error: 'User not found' });
      }

      return reply.send({ success: true });
    },
  );
}
