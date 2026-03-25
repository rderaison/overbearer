import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { createClient } from '@clickhouse/client';
import { createDecipheriv } from 'node:crypto';
import { requireRole } from '../auth/rbac.js';
import { getMasterKey } from '../services/encryption.js';

const CLICKHOUSE_URL = process.env.CLICKHOUSE_URL || 'http://localhost:8123';
const CLICKHOUSE_DATABASE = process.env.CLICKHOUSE_DATABASE || 'overbearer';

function getClickHouseClient() {
  return createClient({ url: CLICKHOUSE_URL, database: CLICKHOUSE_DATABASE });
}

function decryptField(value: string): string {
  if (!value) return value;
  try {
    const buf = Buffer.from(value, 'base64');
    if (buf.length < 28) return value;
    const key = getMasterKey();
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const ciphertext = buf.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(ciphertext) + decipher.final('utf8');
  } catch {
    return value;
  }
}

export default async function serviceRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * GET /api/services
   * List services that used real tokens directly (last 24h by default).
   * Includes per-service stats: call count, distinct tokens, last call, token previews, 403 count.
   */
  fastify.get(
    '/api/services',
    { preHandler: requireRole('viewer') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const qs = request.query as { hours?: string };
      const hours = Math.min(720, Math.max(1, parseInt(qs.hours || '24', 10) || 24));

      const ch = getClickHouseClient();
      try {
        // Services with direct token usage
        const result = await ch.query({
          query: `
            SELECT
              service_name,
              count() as request_count,
              uniqExact(token_id) as distinct_tokens,
              max(timestamp) as last_seen,
              countIf(response_status = 403) as forbidden_count,
              groupArray(10)(DISTINCT token_preview) as token_previews,
              groupArray(10)(DISTINCT token_id) as token_ids
            FROM proxy_logs
            WHERE token_type = 'real_direct'
              AND timestamp >= now() - INTERVAL {hours: UInt32} HOUR
            GROUP BY service_name
            ORDER BY request_count DESC
          `,
          query_params: { hours },
          format: 'JSONEachRow',
        });

        const rows = await result.json<Record<string, unknown>>();

        return reply.send({
          services: rows.map((s) => ({
            name: s.service_name,
            requestCount: Number(s.request_count ?? 0),
            distinctTokens: Number(s.distinct_tokens ?? 0),
            lastSeenAt: s.last_seen,
            forbiddenCount: Number(s.forbidden_count ?? 0),
            tokenPreviews: ((s.token_previews as string[]) ?? []).map(decryptField),
            tokenIds: (s.token_ids as string[]) ?? [],
          })),
          hours,
        });
      } finally {
        await ch.close();
      }
    },
  );
}
