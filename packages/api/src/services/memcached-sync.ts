import Memcached from 'memcached';
import { promisify } from 'node:util';

let client: Memcached | null = null;

const MEMCACHED_HOST = process.env.MEMCACHED_HOST || 'localhost:11211';
/** Keys never truly expire in memcached; set a very long TTL (30 days). */
const DEFAULT_TTL = 60 * 60 * 24 * 30;

export function getMemcachedClient(): Memcached {
  if (!client) {
    client = new Memcached(MEMCACHED_HOST, {
      retries: 3,
      retry: 5000,
      timeout: 3000,
      reconnect: 10000,
    });
  }
  return client;
}

/**
 * Store a fake-token-hash → encrypted-real-token mapping.
 * The proxy reads this to swap fake tokens for real ones.
 */
export async function setFakeToken(fakeHash: string, encryptedRealToken: Buffer): Promise<void> {
  const mc = getMemcachedClient();
  const set = promisify(mc.set).bind(mc);
  const key = `fake:${fakeHash}`;
  // Store the encrypted buffer as a base64 string for memcached compatibility
  await set(key, encryptedRealToken.toString('base64'), DEFAULT_TTL);
}

/**
 * Store a real-token hash so the proxy can detect direct real-token usage.
 */
export async function setRealTokenHash(realHash: string): Promise<void> {
  const mc = getMemcachedClient();
  const set = promisify(mc.set).bind(mc);
  const key = `real:${realHash}`;
  await set(key, '1', DEFAULT_TTL);
}

/**
 * Remove a fake-token mapping (on revoke/rotate).
 */
export async function removeFakeToken(fakeHash: string): Promise<void> {
  const mc = getMemcachedClient();
  const del = promisify(mc.del).bind(mc);
  const key = `fake:${fakeHash}`;
  await del(key);
}

/**
 * Remove a real-token hash (on revoke).
 */
export async function removeRealTokenHash(realHash: string): Promise<void> {
  const mc = getMemcachedClient();
  const del = promisify(mc.del).bind(mc);
  const key = `real:${realHash}`;
  await del(key);
}

/**
 * Close the memcached connection.
 */
export function closeMemcached(): void {
  if (client) {
    client.end();
    client = null;
  }
}
