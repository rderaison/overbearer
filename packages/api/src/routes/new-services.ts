import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { createClient } from '@clickhouse/client';
import { query } from '../db/postgres.js';
import { requireRole } from '../auth/rbac.js';

const CLICKHOUSE_URL = process.env.CLICKHOUSE_URL || 'http://localhost:8123';
const CLICKHOUSE_DATABASE = process.env.CLICKHOUSE_DATABASE || 'overbearer';

function getClickHouseClient() {
  return createClient({ url: CLICKHOUSE_URL, database: CLICKHOUSE_DATABASE });
}

interface TokenMappingRow {
  id: string;
  name: string;
  provider: string | null;
  fake_token_hash: string;
}

export default async function newServiceRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * GET /api/services/new
   * Detect new service-token associations: service-token pairs whose earliest
   * usage falls within the lookback window.
   */
  fastify.get(
    '/api/services/new',
    { preHandler: requireRole('viewer') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const qs = request.query as { hours?: string };
      const hours = Math.min(720, Math.max(1, parseInt(qs.hours || '24', 10) || 24));

      const ch = getClickHouseClient();
      try {
        // Step 1: Find service-token pairs first seen within the lookback window
        const newPairsResult = await ch.query({
          query: `
            SELECT
              token_id,
              service_name,
              min(timestamp) as first_seen,
              count() as request_count
            FROM proxy_logs
            WHERE token_type = 'fake'
            GROUP BY token_id, service_name
            HAVING min(timestamp) >= now() - INTERVAL {hours: UInt32} HOUR
            ORDER BY first_seen DESC
          `,
          query_params: { hours },
          format: 'JSONEachRow',
        });

        const newPairs = await newPairsResult.json<{
          token_id: string;
          service_name: string;
          first_seen: string;
          request_count: string;
        }>();

        if (newPairs.length === 0) {
          return reply.send({ newAssociations: [], hours });
        }

        // Step 2: Get known services count per token (all-time)
        const tokenIds = [...new Set(newPairs.map((r) => r.token_id))];

        const knownResult = await ch.query({
          query: `
            SELECT
              token_id,
              count(DISTINCT service_name) as known_count,
              groupArray(DISTINCT service_name) as known_services
            FROM proxy_logs
            WHERE token_type = 'fake'
              AND token_id IN ({tokenIds: Array(String)})
            GROUP BY token_id
          `,
          query_params: { tokenIds },
          format: 'JSONEachRow',
        });

        const knownRows = await knownResult.json<{
          token_id: string;
          known_count: string;
          known_services: string[];
        }>();

        const knownMap = new Map<string, { count: number; services: string[] }>();
        for (const row of knownRows) {
          knownMap.set(row.token_id, {
            count: Number(row.known_count),
            services: row.known_services,
          });
        }

        // Step 3: Enrich with token names from PostgreSQL
        const tokenResult = await query<TokenMappingRow>(
          'SELECT id, name, provider, fake_token_hash FROM token_mappings WHERE NOT revoked',
        );

        const tokenNameMap = new Map<string, { name: string; provider: string | null }>();
        for (const t of tokenResult.rows) {
          const hashPrefix = t.fake_token_hash.substring(0, 16);
          tokenNameMap.set(hashPrefix, { name: t.name, provider: t.provider });
        }

        // Step 4: Assemble response
        const newAssociations = newPairs.map((pair) => {
          const tokenInfo = tokenNameMap.get(pair.token_id);
          const known = knownMap.get(pair.token_id);

          return {
            serviceName: pair.service_name,
            tokenId: pair.token_id,
            tokenName: tokenInfo?.name ?? null,
            provider: tokenInfo?.provider ?? null,
            firstSeen: pair.first_seen,
            requestCount: Number(pair.request_count),
            knownServiceCount: known?.count ?? 0,
            knownServices: known?.services ?? [],
          };
        });

        return reply.send({ newAssociations, hours });
      } finally {
        await ch.close();
      }
    },
  );
}
