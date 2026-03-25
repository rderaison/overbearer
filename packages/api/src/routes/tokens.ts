import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { createClient } from '@clickhouse/client';
import { createDecipheriv } from 'node:crypto';
import { query } from '../db/postgres.js';
import { requireRole } from '../auth/rbac.js';
import { createToken, revokeToken, rotateToken } from '../services/token-service.js';
import { getMasterKey } from '../services/encryption.js';

interface TokenRow {
  id: string;
  name: string;
  provider: string | null;
  fake_token_hash: string;
  fake_token_value: string;
  created_by: string | null;
  last_used_at: string | null;
  revoked: boolean;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
  creator_username?: string;
}

export default async function tokenRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * GET /api/tokens
   * List tokens. Managers see their own tokens; admins see all.
   */
  fastify.get(
    '/api/tokens',
    { preHandler: requireRole('manager') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      let result;

      if (request.userRole === 'admin') {
        result = await query<TokenRow>(
          `SELECT t.id, t.name, t.provider, t.fake_token_hash, t.fake_token_value, t.created_by,
                  t.last_used_at, t.revoked, t.revoked_at, t.created_at, t.updated_at,
                  u.username as creator_username
           FROM token_mappings t
           LEFT JOIN users u ON t.created_by = u.id
           ORDER BY t.created_at DESC`,
        );
      } else {
        result = await query<TokenRow>(
          `SELECT t.id, t.name, t.provider, t.fake_token_hash, t.fake_token_value, t.created_by,
                  t.last_used_at, t.revoked, t.revoked_at, t.created_at, t.updated_at,
                  u.username as creator_username
           FROM token_mappings t
           LEFT JOIN users u ON t.created_by = u.id
           WHERE t.created_by = $1
           ORDER BY t.created_at DESC`,
          [request.userId],
        );
      }

      // Enrich with usage stats from ClickHouse
      let usageMap: Record<string, { lastUsed: string; requestCount: number; services: string[] }> = {};
      try {
        const { createClient } = await import('@clickhouse/client');
        const ch = createClient({
          url: process.env.CLICKHOUSE_URL || 'http://localhost:8123',
          database: process.env.CLICKHOUSE_DATABASE || 'overbearer',
        });
        const usageResult = await ch.query({
          query: `SELECT token_id,
                         max(timestamp) as last_used,
                         count() as request_count,
                         groupArray(10)(DISTINCT service_name) as services
                  FROM proxy_logs
                  WHERE token_type = 'fake' AND token_id != ''
                  GROUP BY token_id`,
          format: 'JSONEachRow',
        });
        const rows = await usageResult.json<Record<string, unknown>>();
        for (const row of rows) {
          usageMap[row.token_id as string] = {
            lastUsed: row.last_used as string,
            requestCount: Number(row.request_count ?? 0),
            services: (row.services as string[]) ?? [],
          };
        }
        await ch.close();
      } catch {
        // ClickHouse unavailable — skip usage enrichment
      }

      return reply.send({
        tokens: result.rows.map((t) => {
          const hashPrefix = t.fake_token_hash.substring(0, 16);
          const usage = usageMap[hashPrefix];
          return {
            id: t.id,
            name: t.name,
            provider: t.provider,
            fakeToken: t.fake_token_value || null,
            status: t.revoked ? 'revoked' : 'active',
            createdBy: t.creator_username ?? 'unknown',
            lastUsedAt: usage?.lastUsed ?? t.last_used_at ?? null,
            requestCount: usage?.requestCount ?? 0,
            services: usage?.services ?? [],
            revokedAt: t.revoked_at,
            createdAt: t.created_at,
          };
        }),
      });
    },
  );

  /**
   * POST /api/tokens
   * Create a new token mapping. Accepts { name, provider, realToken }.
   * Returns the generated fake token.
   */
  fastify.post(
    '/api/tokens',
    { preHandler: requireRole('manager') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as {
        name?: string;
        provider?: string;
        realToken?: string;
      } | undefined;

      if (!body?.name?.trim()) {
        return reply.code(400).send({ error: 'name is required' });
      }
      if (!body?.realToken?.trim()) {
        return reply.code(400).send({ error: 'realToken is required' });
      }

      const name = body.name.trim();
      const provider = body.provider?.trim() || null;
      const realToken = body.realToken.trim();

      if (name.length > 255) {
        return reply.code(400).send({ error: 'name must be 255 characters or less' });
      }

      try {
        const result = await createToken(name, provider, realToken, request.userId!);
        return reply.code(201).send({
          id: result.id,
          name: result.name,
          provider: result.provider,
          fakeToken: result.fakeToken,
        });
      } catch (err) {
        const message = (err as Error).message;
        if (message.includes('unique') || message.includes('duplicate')) {
          return reply.code(409).send({ error: 'A token with this value already exists' });
        }
        throw err;
      }
    },
  );

  /**
   * DELETE /api/tokens/:id
   * Revoke a token (set revoked=true, remove from memcached).
   */
  fastify.delete(
    '/api/tokens/:id',
    { preHandler: requireRole('manager') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };

      // Non-admins can only revoke their own tokens
      if (request.userRole !== 'admin') {
        const check = await query<{ created_by: string }>(
          'SELECT created_by FROM token_mappings WHERE id = $1',
          [id],
        );
        if (check.rows.length === 0) {
          return reply.code(404).send({ error: 'Token not found' });
        }
        if (check.rows[0].created_by !== request.userId) {
          return reply.code(403).send({ error: 'You can only revoke your own tokens' });
        }
      }

      try {
        await revokeToken(id);
        return reply.send({ success: true });
      } catch (err) {
        return reply.code(404).send({ error: (err as Error).message });
      }
    },
  );

  /**
   * POST /api/tokens/:id/rotate
   * Accept a new real token, re-encrypt, update memcached.
   */
  fastify.post(
    '/api/tokens/:id/rotate',
    { preHandler: requireRole('manager') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const body = request.body as { realToken?: string } | undefined;

      if (!body?.realToken?.trim()) {
        return reply.code(400).send({ error: 'realToken is required' });
      }

      // Non-admins can only rotate their own tokens
      if (request.userRole !== 'admin') {
        const check = await query<{ created_by: string }>(
          'SELECT created_by FROM token_mappings WHERE id = $1 AND NOT revoked',
          [id],
        );
        if (check.rows.length === 0) {
          return reply.code(404).send({ error: 'Token not found or revoked' });
        }
        if (check.rows[0].created_by !== request.userId) {
          return reply.code(403).send({ error: 'You can only rotate your own tokens' });
        }
      }

      try {
        await rotateToken(id, body.realToken.trim());
        return reply.send({ success: true });
      } catch (err) {
        return reply.code(404).send({ error: (err as Error).message });
      }
    },
  );

  /**
   * POST /api/tokens/capture
   * One-click token capture. Looks up the encrypted full token from ClickHouse
   * by token_id, decrypts it, and creates a fake mapping automatically.
   */
  fastify.post(
    '/api/tokens/capture',
    { preHandler: requireRole('manager') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as {
        tokenId?: string;
        name?: string;
        provider?: string;
      } | undefined;

      if (!body?.name?.trim()) {
        return reply.code(400).send({ error: 'name is required' });
      }
      if (!body?.tokenId?.trim()) {
        return reply.code(400).send({ error: 'tokenId is required' });
      }

      const name = body.name.trim();
      const provider = body.provider?.trim() || null;
      const tokenId = body.tokenId.trim();

      // Look up the encrypted full token from ClickHouse
      const ch = createClient({
        url: process.env.CLICKHOUSE_URL || 'http://localhost:8123',
        database: process.env.CLICKHOUSE_DATABASE || 'overbearer',
      });

      try {
        const result = await ch.query({
          query: `SELECT token_encrypted FROM proxy_logs
                  WHERE token_id = {tokenId: String} AND token_encrypted != ''
                  ORDER BY timestamp DESC LIMIT 1`,
          query_params: { tokenId },
          format: 'JSONEachRow',
        });
        const rows = await result.json<{ token_encrypted: string }>();

        if (rows.length === 0 || !rows[0].token_encrypted) {
          return reply.code(404).send({ error: 'No encrypted token found for this token ID. Try again after more traffic flows through the proxy.' });
        }

        // Decrypt the full token
        let realToken: string;
        try {
          const buf = Buffer.from(rows[0].token_encrypted, 'base64');
          const key = getMasterKey();
          const iv = buf.subarray(0, 12);
          const tag = buf.subarray(12, 28);
          const ciphertext = buf.subarray(28);
          const decipher = createDecipheriv('aes-256-gcm', key, iv);
          decipher.setAuthTag(tag);
          realToken = decipher.update(ciphertext) + decipher.final('utf8');
        } catch {
          return reply.code(500).send({ error: 'Failed to decrypt token from logs' });
        }

        // Create the fake token mapping
        const tokenResult = await createToken(name, provider, realToken, request.userId!);
        return reply.code(201).send({
          id: tokenResult.id,
          name: tokenResult.name,
          provider: tokenResult.provider,
          fakeToken: tokenResult.fakeToken,
        });
      } catch (err) {
        const message = (err as Error).message;
        if (message.includes('unique') || message.includes('duplicate')) {
          return reply.code(409).send({ error: 'This token is already managed by Overbearer' });
        }
        throw err;
      } finally {
        await ch.close();
      }
    },
  );
}
