import { query } from '../db/postgres.js';
import { encrypt, generateFakeToken, hashToken } from './encryption.js';
import {
  setFakeToken,
  setRealTokenHash,
  removeFakeToken,
  removeRealTokenHash,
} from './memcached-sync.js';

export interface TokenMapping {
  id: string;
  name: string;
  provider: string | null;
  fake_token_hash: string;
  real_token_hash: string;
  real_token_encrypted: Buffer;
  created_by: string | null;
  last_used_at: string | null;
  revoked: boolean;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateTokenResult {
  id: string;
  fakeToken: string;
  name: string;
  provider: string | null;
}

/**
 * Create a new token mapping: encrypt the real token, generate a fake one,
 * persist to Postgres and sync to memcached.
 */
export async function createToken(
  name: string,
  provider: string | null,
  realToken: string,
  createdBy: string,
): Promise<CreateTokenResult> {
  const fakeToken = generateFakeToken(realToken);
  const fakeHash = hashToken(fakeToken);
  const realHash = hashToken(realToken);
  const encryptedReal = encrypt(realToken);

  const result = await query<TokenMapping>(
    `INSERT INTO token_mappings (name, provider, fake_token_hash, fake_token_value, real_token_encrypted, real_token_hash, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [name, provider, fakeHash, fakeToken, encryptedReal, realHash, createdBy],
  );

  const row = result.rows[0];

  // Sync to memcached
  await setFakeToken(fakeHash, encryptedReal);
  await setRealTokenHash(realHash);

  return {
    id: row.id,
    fakeToken,
    name: row.name,
    provider: row.provider,
  };
}

/**
 * Revoke a token: mark as revoked in DB and remove from memcached.
 */
export async function revokeToken(tokenId: string): Promise<void> {
  const result = await query<TokenMapping>(
    `UPDATE token_mappings
     SET revoked = TRUE, revoked_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND NOT revoked
     RETURNING fake_token_hash, real_token_hash`,
    [tokenId],
  );

  if (result.rows.length === 0) {
    throw new Error('Token not found or already revoked');
  }

  const { fake_token_hash, real_token_hash } = result.rows[0];

  await removeFakeToken(fake_token_hash);
  await removeRealTokenHash(real_token_hash);
}

/**
 * Rotate a token: replace the real token with a new one, update DB and memcached.
 */
export async function rotateToken(tokenId: string, newRealToken: string): Promise<void> {
  // Fetch current mapping
  const current = await query<TokenMapping>(
    `SELECT * FROM token_mappings WHERE id = $1 AND NOT revoked`,
    [tokenId],
  );

  if (current.rows.length === 0) {
    throw new Error('Token not found or revoked');
  }

  const row = current.rows[0];
  const oldRealHash = row.real_token_hash;
  const newRealHash = hashToken(newRealToken);
  const newEncryptedReal = encrypt(newRealToken);

  await query(
    `UPDATE token_mappings
     SET real_token_encrypted = $1, real_token_hash = $2, updated_at = NOW()
     WHERE id = $3`,
    [newEncryptedReal, newRealHash, tokenId],
  );

  // Update memcached: update the fake→real mapping and swap real hashes
  await setFakeToken(row.fake_token_hash, newEncryptedReal);
  await removeRealTokenHash(oldRealHash);
  await setRealTokenHash(newRealHash);
}

/**
 * Bulk-sync all active tokens to memcached. Called on startup.
 */
export async function syncAllTokensToMemcached(): Promise<number> {
  const result = await query<TokenMapping>(
    `SELECT fake_token_hash, real_token_encrypted, real_token_hash
     FROM token_mappings
     WHERE NOT revoked`,
  );

  let count = 0;
  for (const row of result.rows) {
    try {
      await setFakeToken(row.fake_token_hash, row.real_token_encrypted);
      await setRealTokenHash(row.real_token_hash);
      count++;
    } catch (err) {
      // Log but continue syncing other tokens
      console.error(`Failed to sync token to memcached: ${(err as Error).message}`);
    }
  }

  return count;
}

/**
 * Look up a token by ID (non-sensitive fields only).
 */
export async function getTokenById(tokenId: string): Promise<TokenMapping | null> {
  const result = await query<TokenMapping>(
    `SELECT id, name, provider, fake_token_hash, real_token_hash, created_by,
            last_used_at, revoked, revoked_at, created_at, updated_at
     FROM token_mappings
     WHERE id = $1`,
    [tokenId],
  );
  return result.rows[0] ?? null;
}
