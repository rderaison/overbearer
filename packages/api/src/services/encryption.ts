import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

let masterKey: Buffer;

export function initEncryption(key: string): void {
  const keyBuf = Buffer.from(key, 'hex');
  if (keyBuf.length !== 32) {
    throw new Error('OVERBEARER_MASTER_KEY must be 64 hex characters (32 bytes)');
  }
  masterKey = keyBuf;
}

export function getMasterKey(): Buffer {
  if (!masterKey) {
    throw new Error('Encryption not initialized. Call initEncryption() first.');
  }
  return masterKey;
}

export function encrypt(plaintext: string): Buffer {
  const key = getMasterKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: [iv (12)] [tag (16)] [ciphertext (...)]
  return Buffer.concat([iv, tag, encrypted]);
}

export function decrypt(data: Buffer): string {
  const key = getMasterKey();
  const iv = data.subarray(0, IV_LENGTH);
  const tag = data.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = data.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ciphertext) + decipher.final('utf8');
}

/**
 * Generate a fake token that preserves the prefix of the real token.
 * This ensures the target API doesn't reject the key based on format alone.
 * e.g. "sk-ant-api03-real..." → "sk-ant-api03-ovb-<random>"
 *      "sk-proj-real..."     → "sk-proj-ovb-<random>"
 *
 * If no real token is provided, falls back to "ovb_<random>".
 */
export function generateFakeToken(realToken?: string): string {
  const random = randomBytes(32).toString('hex');

  if (!realToken) {
    return `ovb_${random}`;
  }

  // Find the prefix: everything up to and including the last delimiter
  // before the unique part. Common patterns:
  //   sk-ant-api03-XXXX   → prefix "sk-ant-api03-"
  //   sk-proj-XXXX        → prefix "sk-proj-"
  //   sk-XXXX             → prefix "sk-"
  //   key-XXXX            → prefix "key-"
  // Strategy: keep everything up to a reasonable split point, then append ovb marker + random
  const delimiters = ['-', '_'];
  let prefixEnd = -1;

  // Walk through the token and find the last delimiter within the first half
  const maxPrefixLen = Math.min(realToken.length, 40);
  for (let i = 0; i < maxPrefixLen; i++) {
    if (delimiters.includes(realToken[i])) {
      prefixEnd = i;
    }
  }

  if (prefixEnd > 0 && prefixEnd < maxPrefixLen) {
    const prefix = realToken.substring(0, prefixEnd + 1);
    return `${prefix}ovb-${random}`;
  }

  return `ovb_${random}`;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
