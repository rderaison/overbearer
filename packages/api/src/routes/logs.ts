import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { createClient } from '@clickhouse/client';
import { createDecipheriv } from 'node:crypto';
import { query as pgQuery } from '../db/postgres.js';
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
    if (buf.length < 28) return value; // not encrypted
    const key = getMasterKey();
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const ciphertext = buf.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(ciphertext) + decipher.final('utf8');
  } catch {
    return value; // not encrypted or wrong key — return as-is
  }
}

interface LogRow {
  timestamp: string;
  request_id: string;
  service_name: string;
  target_host: string;
  method: string;
  path: string;
  token_type: string;
  token_hash: string;
  status_code: number;
  response_time_ms: number;
}

export default async function logRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * GET /api/logs
   * Query proxy_logs from ClickHouse. Supports filters and pagination.
   * Viewers only see logs for tokens they have access to (via token_access table).
   * Admins see all logs.
   */
  fastify.get(
    '/api/logs',
    { preHandler: requireRole('viewer') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const qs = request.query as {
        target_host?: string;
        service_name?: string;
        token_type?: string;
        from?: string;
        to?: string;
        page?: string;
        limit?: string;
      };

      const page = Math.max(1, parseInt(qs.page || '1', 10) || 1);
      const limit = Math.min(1000, Math.max(1, parseInt(qs.limit || '50', 10) || 50));
      const offset = (page - 1) * limit;

      const conditions: string[] = [];
      const params: Record<string, unknown> = {};

      // Viewer role: restrict to tokens they have access to (direct or via groups)
      if (request.userRole === 'viewer') {
        const accessResult = await pgQuery<{ fake_token_hash: string; real_token_hash: string }>(
          `SELECT DISTINCT t.fake_token_hash, t.real_token_hash
           FROM token_mappings t
           WHERE t.id IN (
             SELECT ta.token_id FROM token_access ta WHERE ta.user_id = $1
             UNION
             SELECT tga.token_id FROM token_group_access tga
               JOIN group_members gm ON tga.group_id = gm.group_id
               WHERE gm.user_id = $1
           )`,
          [request.userId],
        );

        if (accessResult.rows.length === 0) {
          return reply.send({ logs: [], total: 0, page, limit });
        }

        const hashes = accessResult.rows.flatMap((r) => [r.fake_token_hash, r.real_token_hash]);
        conditions.push(`token_hash IN {allowedHashes: Array(String)}`);
        params.allowedHashes = hashes;
      }

      if (qs.target_host) {
        conditions.push(`target_host = {targetHost: String}`);
        params.targetHost = qs.target_host;
      }

      if (qs.service_name) {
        conditions.push(`service_name = {serviceName: String}`);
        params.serviceName = qs.service_name;
      }

      if (qs.token_type) {
        conditions.push(`token_type = {tokenType: String}`);
        params.tokenType = qs.token_type;
      }

      if (qs.from) {
        conditions.push(`timestamp >= {fromDate: DateTime}`);
        params.fromDate = qs.from;
      }

      if (qs.to) {
        conditions.push(`timestamp <= {toDate: DateTime}`);
        params.toDate = qs.to;
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      const ch = getClickHouseClient();
      try {
        // Get total count
        const countResult = await ch.query({
          query: `SELECT count() as total FROM proxy_logs ${whereClause}`,
          query_params: params,
          format: 'JSONEachRow',
        });
        const countRows = await countResult.json<{ total: string }>();
        const total = parseInt(countRows[0]?.total || '0', 10);

        // Get paginated logs
        const logsResult = await ch.query({
          query: `SELECT * FROM proxy_logs ${whereClause}
                  ORDER BY timestamp DESC
                  LIMIT {limit: UInt32} OFFSET {offset: UInt32}`,
          query_params: { ...params, limit, offset },
          format: 'JSONEachRow',
        });
        const rawLogs = await logsResult.json<Record<string, unknown>>();

        const logs = rawLogs.map((row: Record<string, unknown>) => ({
          timestamp: row.timestamp,
          service: row.service_name ?? '',
          sourceIp: row.service_ip ?? '',
          targetHost: row.target_host ?? '',
          method: row.method ?? '',
          path: row.target_path ?? '',
          tokenType: row.token_type ?? 'unknown',
          tokenId: row.token_id ?? '',
          tokenPreview: decryptField(row.token_preview as string ?? ''),
          statusCode: Number(row.response_status ?? 0),
          latencyMs: Number(row.latency_ms ?? 0),
        }));

        return reply.send({ logs, total, page, limit });
      } finally {
        await ch.close();
      }
    },
  );
}
