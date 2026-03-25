import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { query } from '../db/postgres.js';
import { requireAuth, requireRole } from '../auth/rbac.js';
import { createToken } from '../services/token-service.js';

interface TokenRequestRow {
  id: string;
  user_id: string;
  provider: string;
  reason: string | null;
  status: string;
  approved_by: string | null;
  token_id: string | null;
  created_at: string;
  updated_at: string;
  username?: string;
  approver_username?: string;
}

export default async function tokenRequestRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * GET /api/tokens/requests
   * List token requests.
   * Requesters see only their own; manager+ sees all pending.
   */
  fastify.get(
    '/api/tokens/requests',
    { preHandler: requireAuth() },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const roleIsManagerOrAbove =
        request.userRole === 'manager' || request.userRole === 'admin';

      let result;
      if (roleIsManagerOrAbove) {
        result = await query<TokenRequestRow>(
          `SELECT tr.*, u.username, approver.username as approver_username
           FROM token_requests tr
           JOIN users u ON tr.user_id = u.id
           LEFT JOIN users approver ON tr.approved_by = approver.id
           ORDER BY tr.created_at DESC`,
        );
      } else {
        result = await query<TokenRequestRow>(
          `SELECT tr.*, u.username, approver.username as approver_username
           FROM token_requests tr
           JOIN users u ON tr.user_id = u.id
           LEFT JOIN users approver ON tr.approved_by = approver.id
           WHERE tr.user_id = $1
           ORDER BY tr.created_at DESC`,
          [request.userId],
        );
      }

      return reply.send({
        requests: result.rows.map((r) => ({
          id: r.id,
          userId: r.user_id,
          username: r.username,
          requestedBy: r.user_id,
          requestedByUsername: r.username,
          provider: r.provider,
          reason: r.reason,
          status: r.status,
          approvedBy: r.approved_by,
          approverUsername: r.approver_username,
          reviewedBy: r.approved_by,
          reviewedByUsername: r.approver_username,
          tokenId: r.token_id,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
        })),
      });
    },
  );

  /**
   * POST /api/tokens/requests
   * Create a token request. Any authenticated user can request.
   */
  fastify.post(
    '/api/tokens/requests',
    { preHandler: requireAuth() },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as {
        provider?: string;
        reason?: string;
      } | undefined;

      if (!body?.provider?.trim()) {
        return reply.code(400).send({ error: 'provider is required' });
      }

      const provider = body.provider.trim();
      const reason = body.reason?.trim() || null;

      if (provider.length > 255) {
        return reply.code(400).send({ error: 'provider must be 255 characters or less' });
      }

      const result = await query<TokenRequestRow>(
        `INSERT INTO token_requests (user_id, provider, reason)
         VALUES ($1, $2, $3)
         RETURNING *`,
        [request.userId, provider, reason],
      );

      const row = result.rows[0];
      return reply.code(201).send({
        id: row.id,
        userId: row.user_id,
        provider: row.provider,
        reason: row.reason,
        status: row.status,
        createdAt: row.created_at,
      });
    },
  );

  /**
   * POST /api/tokens/requests/:id/approve
   * Approve a token request with { name, realToken }. Manager+ only.
   * Creates the token mapping and links it to the request.
   */
  fastify.post(
    '/api/tokens/requests/:id/approve',
    { preHandler: requireRole('manager') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const body = request.body as {
        name?: string;
        realToken?: string;
      } | undefined;

      if (!body?.name?.trim()) {
        return reply.code(400).send({ error: 'name is required' });
      }
      if (!body?.realToken?.trim()) {
        return reply.code(400).send({ error: 'realToken is required' });
      }

      // Find the pending request
      const reqResult = await query<TokenRequestRow>(
        `SELECT * FROM token_requests WHERE id = $1 AND status = 'pending'`,
        [id],
      );

      if (reqResult.rows.length === 0) {
        return reply.code(404).send({ error: 'Pending request not found' });
      }

      const tokenRequest = reqResult.rows[0];

      // Prevent self-approval
      if (tokenRequest.user_id === request.userId) {
        return reply.code(403).send({ error: 'You cannot approve your own request' });
      }

      // Create the token
      const token = await createToken(
        body.name.trim(),
        tokenRequest.provider,
        body.realToken.trim(),
        request.userId!,
      );

      // Grant access to the requesting user
      await query(
        `INSERT INTO token_access (user_id, token_id, granted_by)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, token_id) DO NOTHING`,
        [tokenRequest.user_id, token.id, request.userId],
      );

      // Update the request
      await query(
        `UPDATE token_requests
         SET status = 'approved', approved_by = $1, token_id = $2, updated_at = NOW()
         WHERE id = $3`,
        [request.userId, token.id, id],
      );

      return reply.send({
        success: true,
        tokenId: token.id,
        fakeToken: token.fakeToken,
      });
    },
  );

  /**
   * POST /api/tokens/requests/:id/deny
   * Deny a token request. Manager+ only.
   */
  fastify.post(
    '/api/tokens/requests/:id/deny',
    { preHandler: requireRole('manager') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };

      // Check requester isn't self-denying (shouldn't happen but be consistent)
      const reqCheck = await query<TokenRequestRow>(
        `SELECT user_id FROM token_requests WHERE id = $1 AND status = 'pending'`,
        [id],
      );
      if (reqCheck.rows.length > 0 && reqCheck.rows[0].user_id === request.userId) {
        return reply.code(403).send({ error: 'You cannot deny your own request' });
      }

      const result = await query(
        `UPDATE token_requests
         SET status = 'denied', approved_by = $1, updated_at = NOW()
         WHERE id = $2 AND status = 'pending'
         RETURNING id`,
        [request.userId, id],
      );

      if (result.rows.length === 0) {
        return reply.code(404).send({ error: 'Pending request not found' });
      }

      return reply.send({ success: true });
    },
  );
}
