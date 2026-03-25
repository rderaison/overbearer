import crypto from "node:crypto";
import Memcached from "memcached";

let client: Memcached | undefined;
let masterKey: Buffer | undefined;

/**
 * Initialize the memcached connection and load the master encryption key.
 */
export function initMemcached(): void {
  const host = process.env.MEMCACHED_HOST ?? "localhost:11211";
  const keyHex = process.env.OVERBEARER_MASTER_KEY;

  if (!keyHex) {
    throw new Error("OVERBEARER_MASTER_KEY environment variable is not set");
  }

  masterKey = Buffer.from(keyHex, "hex");
  if (masterKey.length !== 32) {
    throw new Error(
      `OVERBEARER_MASTER_KEY must be 32 bytes (64 hex chars), got ${masterKey.length} bytes`,
    );
  }

  client = new Memcached(host, {
    retries: 2,
    retry: 1000,
    timeout: 2000,
    poolSize: 25,
  });
}

/**
 * Look up a fake token by its SHA-256 hash.
 * Returns the decrypted real token, or undefined if not found.
 *
 * Memcached value format: [IV (12 bytes)][Auth Tag (16 bytes)][Ciphertext]
 */
export async function lookupFakeToken(
  hash: string,
): Promise<string | undefined> {
  const raw = await mcGet(`fake:${hash}`);
  if (!raw) return undefined;

  return decrypt(raw);
}

/**
 * Check if a hash exists in the real token hashes set.
 */
export async function isRealTokenHash(hash: string): Promise<boolean> {
  const raw = await mcGet(`real:${hash}`);
  return raw !== undefined;
}

function mcGet(key: string): Promise<Buffer | undefined> {
  return new Promise((resolve, reject) => {
    if (!client) {
      reject(new Error("Memcached client not initialized"));
      return;
    }

    client.get(key, (err, data) => {
      if (err) {
        reject(err);
        return;
      }
      if (data === undefined || data === null || data === false) {
        resolve(undefined);
        return;
      }
      // The API stores encrypted tokens as base64 strings in memcached
      if (typeof data === "string") {
        resolve(Buffer.from(data, "base64"));
      } else if (Buffer.isBuffer(data)) {
        resolve(data);
      } else {
        resolve(Buffer.from(data as ArrayBuffer));
      }
    });
  });
}

function decrypt(raw: Buffer): string {
  if (!masterKey) {
    throw new Error("Master key not loaded");
  }

  // Format: [IV (12)][Auth Tag (16)][Ciphertext]
  if (raw.length < 12 + 16) {
    throw new Error(
      `Encrypted value too short: ${raw.length} bytes (need at least 28)`,
    );
  }

  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ciphertext = raw.subarray(28);

  const decipher = crypto.createDecipheriv("aes-256-gcm", masterKey, iv);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return decrypted.toString("utf-8");
}

/**
 * Gracefully shut down the memcached client.
 */
export function shutdownMemcached(): void {
  if (client) {
    client.end();
    client = undefined;
  }
}
