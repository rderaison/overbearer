import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { query } from '../db/postgres.js';
import { requireRole } from '../auth/rbac.js';

interface GroupRow {
  id: string;
  name: string;
  description: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  member_count?: string;
  token_count?: string;
}

interface GroupMemberRow {
  id: string;
  username: string;
  display_name: string | null;
  role: string;
}

interface GroupTokenRow {
  id: string;
  name: string;
  provider: string | null;
}

export default async function groupRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * GET /api/groups
   * List all groups (admin/manager). Includes member_count and token_count.
   */
  fastify.get(
    '/api/groups',
    { preHandler: requireRole('manager') },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const result = await query<GroupRow>(
        `SELECT g.id, g.name, g.description, g.created_by, g.created_at, g.updated_at,
                (SELECT COUNT(*) FROM group_members gm WHERE gm.group_id = g.id) AS member_count,
                (SELECT COUNT(*) FROM token_group_access tga WHERE tga.group_id = g.id) AS token_count
         FROM groups g
         ORDER BY g.created_at ASC`,
      );

      return reply.send({
        groups: result.rows.map((g) => ({
          id: g.id,
          name: g.name,
          description: g.description,
          createdBy: g.created_by,
          memberCount: Number(g.member_count ?? 0),
          tokenCount: Number(g.token_count ?? 0),
          createdAt: g.created_at,
          updatedAt: g.updated_at,
        })),
      });
    },
  );

  /**
   * POST /api/groups
   * Create a new group (admin only).
   */
  fastify.post(
    '/api/groups',
    { preHandler: requireRole('admin') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as {
        name?: string;
        description?: string;
      } | undefined;

      const name = body?.name?.trim();
      if (!name || name.length < 1 || name.length > 255) {
        return reply.code(400).send({ error: 'name is required (1-255 characters)' });
      }

      const description = body?.description?.trim() || null;

      // Check if name already exists
      const existing = await query<{ id: string }>(
        'SELECT id FROM groups WHERE name = $1',
        [name],
      );
      if (existing.rows.length > 0) {
        return reply.code(409).send({ error: 'Group name already exists' });
      }

      const result = await query<GroupRow>(
        `INSERT INTO groups (name, description, created_by) VALUES ($1, $2, $3) RETURNING *`,
        [name, description, request.userId],
      );

      const group = result.rows[0];
      return reply.code(201).send({
        id: group.id,
        name: group.name,
        description: group.description,
        createdBy: group.created_by,
        createdAt: group.created_at,
        updatedAt: group.updated_at,
      });
    },
  );

  /**
   * GET /api/groups/:id
   * Get a group with its members and tokens (admin/manager).
   */
  fastify.get(
    '/api/groups/:id',
    { preHandler: requireRole('manager') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };

      const groupResult = await query<GroupRow>(
        `SELECT id, name, description, created_by, created_at, updated_at
         FROM groups WHERE id = $1`,
        [id],
      );

      if (groupResult.rows.length === 0) {
        return reply.code(404).send({ error: 'Group not found' });
      }

      const group = groupResult.rows[0];

      const membersResult = await query<GroupMemberRow>(
        `SELECT u.id, u.username, u.display_name, u.role
         FROM group_members gm
         JOIN users u ON gm.user_id = u.id
         WHERE gm.group_id = $1
         ORDER BY u.username ASC`,
        [id],
      );

      const tokensResult = await query<GroupTokenRow>(
        `SELECT t.id, t.name, t.provider
         FROM token_group_access tga
         JOIN token_mappings t ON tga.token_id = t.id
         WHERE tga.group_id = $1
         ORDER BY t.name ASC`,
        [id],
      );

      return reply.send({
        group: {
          id: group.id,
          name: group.name,
          description: group.description,
          createdBy: group.created_by,
          createdAt: group.created_at,
          updatedAt: group.updated_at,
          members: membersResult.rows.map((m) => ({
            id: m.id,
            username: m.username,
            displayName: m.display_name,
            role: m.role,
          })),
          tokens: tokensResult.rows.map((t) => ({
            id: t.id,
            name: t.name,
            provider: t.provider,
          })),
        },
      });
    },
  );

  /**
   * PATCH /api/groups/:id
   * Update a group (admin only).
   */
  fastify.patch(
    '/api/groups/:id',
    { preHandler: requireRole('admin') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const body = request.body as {
        name?: string;
        description?: string;
      } | undefined;

      const name = body?.name?.trim();
      const description = body?.description?.trim();

      if (!name && description === undefined) {
        return reply.code(400).send({ error: 'At least one field (name, description) is required' });
      }

      if (name !== undefined && (name.length < 1 || name.length > 255)) {
        return reply.code(400).send({ error: 'name must be 1-255 characters' });
      }

      // Check for duplicate name
      if (name) {
        const existing = await query<{ id: string }>(
          'SELECT id FROM groups WHERE name = $1 AND id != $2',
          [name, id],
        );
        if (existing.rows.length > 0) {
          return reply.code(409).send({ error: 'Group name already exists' });
        }
      }

      // Build dynamic SET clause
      const setClauses: string[] = [];
      const params: (string | null)[] = [];
      let paramIndex = 1;

      if (name) {
        setClauses.push(`name = $${paramIndex++}`);
        params.push(name);
      }
      if (description !== undefined) {
        setClauses.push(`description = $${paramIndex++}`);
        params.push(description || null);
      }
      setClauses.push('updated_at = NOW()');
      params.push(id);

      const result = await query<GroupRow>(
        `UPDATE groups SET ${setClauses.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
        params,
      );

      if (result.rows.length === 0) {
        return reply.code(404).send({ error: 'Group not found' });
      }

      const group = result.rows[0];
      return reply.send({
        id: group.id,
        name: group.name,
        description: group.description,
        createdBy: group.created_by,
        createdAt: group.created_at,
        updatedAt: group.updated_at,
      });
    },
  );

  /**
   * DELETE /api/groups/:id
   * Delete a group (admin only).
   */
  fastify.delete(
    '/api/groups/:id',
    { preHandler: requireRole('admin') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };

      const result = await query(
        'DELETE FROM groups WHERE id = $1 RETURNING id',
        [id],
      );

      if (result.rows.length === 0) {
        return reply.code(404).send({ error: 'Group not found' });
      }

      return reply.send({ success: true });
    },
  );

  /**
   * POST /api/groups/:id/members
   * Add a user to a group (admin only).
   */
  fastify.post(
    '/api/groups/:id/members',
    { preHandler: requireRole('admin') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const body = request.body as { userId?: string } | undefined;

      if (!body?.userId?.trim()) {
        return reply.code(400).send({ error: 'userId is required' });
      }

      const userId = body.userId.trim();

      // Verify group exists
      const groupCheck = await query<{ id: string }>(
        'SELECT id FROM groups WHERE id = $1',
        [id],
      );
      if (groupCheck.rows.length === 0) {
        return reply.code(404).send({ error: 'Group not found' });
      }

      // Verify user exists
      const userCheck = await query<{ id: string }>(
        'SELECT id FROM users WHERE id = $1',
        [userId],
      );
      if (userCheck.rows.length === 0) {
        return reply.code(404).send({ error: 'User not found' });
      }

      // Check for duplicate membership
      const existing = await query<{ id: string }>(
        'SELECT id FROM group_members WHERE group_id = $1 AND user_id = $2',
        [id, userId],
      );
      if (existing.rows.length > 0) {
        return reply.code(409).send({ error: 'User is already a member of this group' });
      }

      await query(
        `INSERT INTO group_members (group_id, user_id, added_by) VALUES ($1, $2, $3)`,
        [id, userId, request.userId],
      );

      return reply.code(201).send({ success: true });
    },
  );

  /**
   * DELETE /api/groups/:id/members/:userId
   * Remove a user from a group (admin only).
   */
  fastify.delete(
    '/api/groups/:id/members/:userId',
    { preHandler: requireRole('admin') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id, userId } = request.params as { id: string; userId: string };

      const result = await query(
        'DELETE FROM group_members WHERE group_id = $1 AND user_id = $2 RETURNING id',
        [id, userId],
      );

      if (result.rows.length === 0) {
        return reply.code(404).send({ error: 'Group membership not found' });
      }

      return reply.send({ success: true });
    },
  );

  /**
   * POST /api/groups/:id/tokens
   * Grant token access to a group (admin/manager).
   */
  fastify.post(
    '/api/groups/:id/tokens',
    { preHandler: requireRole('manager') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const body = request.body as { tokenId?: string } | undefined;

      if (!body?.tokenId?.trim()) {
        return reply.code(400).send({ error: 'tokenId is required' });
      }

      const tokenId = body.tokenId.trim();

      // Verify group exists
      const groupCheck = await query<{ id: string }>(
        'SELECT id FROM groups WHERE id = $1',
        [id],
      );
      if (groupCheck.rows.length === 0) {
        return reply.code(404).send({ error: 'Group not found' });
      }

      // Verify token exists
      const tokenCheck = await query<{ id: string }>(
        'SELECT id FROM token_mappings WHERE id = $1',
        [tokenId],
      );
      if (tokenCheck.rows.length === 0) {
        return reply.code(404).send({ error: 'Token not found' });
      }

      // Check for duplicate grant
      const existing = await query<{ id: string }>(
        'SELECT id FROM token_group_access WHERE group_id = $1 AND token_id = $2',
        [id, tokenId],
      );
      if (existing.rows.length > 0) {
        return reply.code(409).send({ error: 'Token access already granted to this group' });
      }

      await query(
        `INSERT INTO token_group_access (group_id, token_id, granted_by) VALUES ($1, $2, $3)`,
        [id, tokenId, request.userId],
      );

      return reply.code(201).send({ success: true });
    },
  );

  /**
   * DELETE /api/groups/:id/tokens/:tokenId
   * Revoke token access from a group (admin/manager).
   */
  fastify.delete(
    '/api/groups/:id/tokens/:tokenId',
    { preHandler: requireRole('manager') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id, tokenId } = request.params as { id: string; tokenId: string };

      const result = await query(
        'DELETE FROM token_group_access WHERE group_id = $1 AND token_id = $2 RETURNING id',
        [id, tokenId],
      );

      if (result.rows.length === 0) {
        return reply.code(404).send({ error: 'Token group access not found' });
      }

      return reply.send({ success: true });
    },
  );
}
