import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { query } from '../db/postgres.js';
import { requireRole } from '../auth/rbac.js';

interface ProxyAclRow {
  id: string;
  service_pattern: string;
  description: string | null;
  created_by: string;
  created_at: string;
}

export default async function proxyAclRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * GET /api/proxy-acls
   * List all proxy ACL rules, ordered by most recent first.
   * When the table is empty the proxy is open; when it has entries the proxy is restricted.
   */
  fastify.get(
    '/api/proxy-acls',
    { preHandler: requireRole('admin') },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const result = await query<ProxyAclRow>(
        `SELECT id, service_pattern, description, created_by, created_at
         FROM proxy_acls
         ORDER BY created_at DESC`,
      );

      return reply.send({
        rules: result.rows.map((r) => ({
          id: r.id,
          servicePattern: r.service_pattern,
          description: r.description,
          createdBy: r.created_by,
          createdAt: r.created_at,
        })),
      });
    },
  );

  /**
   * POST /api/proxy-acls
   * Create a new proxy ACL rule. Body: { servicePattern, description }.
   */
  fastify.post(
    '/api/proxy-acls',
    { preHandler: requireRole('admin') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as {
        servicePattern?: string;
        description?: string;
      } | undefined;

      const servicePattern = body?.servicePattern?.trim();
      if (!servicePattern) {
        return reply.code(400).send({ error: 'servicePattern is required' });
      }
      if (servicePattern.length > 255) {
        return reply.code(400).send({ error: 'servicePattern must be 255 characters or less' });
      }

      const description = body?.description?.trim() || null;

      const result = await query<ProxyAclRow>(
        `INSERT INTO proxy_acls (service_pattern, description, created_by)
         VALUES ($1, $2, $3)
         RETURNING id, service_pattern, description, created_by, created_at`,
        [servicePattern, description, request.userId],
      );

      const rule = result.rows[0];
      return reply.code(201).send({
        id: rule.id,
        servicePattern: rule.service_pattern,
        description: rule.description,
        createdBy: rule.created_by,
        createdAt: rule.created_at,
      });
    },
  );

  /**
   * DELETE /api/proxy-acls/:id
   * Delete a proxy ACL rule by ID.
   */
  fastify.delete(
    '/api/proxy-acls/:id',
    { preHandler: requireRole('admin') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };

      const result = await query(
        'DELETE FROM proxy_acls WHERE id = $1 RETURNING id',
        [id],
      );

      if (result.rows.length === 0) {
        return reply.code(404).send({ error: 'Rule not found' });
      }

      return reply.send({ success: true });
    },
  );

  /**
   * GET /api/proxy-acls/status
   * Returns the current proxy mode: open (no rules) or restricted (has rules).
   */
  fastify.get(
    '/api/proxy-acls/status',
    { preHandler: requireRole('admin') },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const result = await query<{ count: string }>(
        'SELECT count(*)::text as count FROM proxy_acls',
      );

      const ruleCount = parseInt(result.rows[0]?.count || '0', 10);

      return reply.send({
        mode: ruleCount > 0 ? 'restricted' : 'open',
        ruleCount,
      });
    },
  );
}
