import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { encryptToken, sha256 } from './helpers.js';

// Import the actual encryption module
import { initEncryption, encrypt, decrypt, generateFakeToken, hashToken } from '../packages/api/src/services/encryption.js';

const TEST_MASTER_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

describe('Encryption Module', () => {
  it('should initialize with a valid 32-byte hex key', () => {
    expect(() => initEncryption(TEST_MASTER_KEY)).not.toThrow();
  });

  it('should reject keys that are not 32 bytes', () => {
    expect(() => initEncryption('abcd')).toThrow('64 hex characters');
  });

  it('should encrypt and decrypt a token round-trip', () => {
    initEncryption(TEST_MASTER_KEY);

    const token = 'sk-ant-api03-test-token-1234567890abcdef';
    const encrypted = encrypt(token);

    expect(encrypted).toBeInstanceOf(Buffer);
    expect(encrypted.length).toBeGreaterThan(28); // iv(12) + tag(16) + at least 1 byte

    const decrypted = decrypt(encrypted);
    expect(decrypted).toBe(token);
  });

  it('should produce different ciphertexts for the same plaintext (random IV)', () => {
    initEncryption(TEST_MASTER_KEY);

    const token = 'sk-ant-api03-test-token';
    const a = encrypt(token);
    const b = encrypt(token);

    // The IVs should be different, so the ciphertexts should differ
    expect(a.equals(b)).toBe(false);

    // But both should decrypt to the same value
    expect(decrypt(a)).toBe(token);
    expect(decrypt(b)).toBe(token);
  });

  it('should fail to decrypt with a tampered auth tag', () => {
    initEncryption(TEST_MASTER_KEY);

    const encrypted = encrypt('secret-token');
    // Tamper with the auth tag (bytes 12-28)
    encrypted[15] ^= 0xff;

    expect(() => decrypt(encrypted)).toThrow();
  });

  it('should fail to decrypt with a tampered ciphertext', () => {
    initEncryption(TEST_MASTER_KEY);

    const encrypted = encrypt('secret-token');
    // Tamper with the ciphertext (after byte 28)
    if (encrypted.length > 28) {
      encrypted[28] ^= 0xff;
    }

    expect(() => decrypt(encrypted)).toThrow();
  });

  it('should generate fake tokens with ovb_ prefix', () => {
    const token = generateFakeToken();
    expect(token).toMatch(/^ovb_[0-9a-f]{64}$/);
  });

  it('should generate unique fake tokens', () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 100; i++) {
      tokens.add(generateFakeToken());
    }
    expect(tokens.size).toBe(100);
  });

  it('should hash tokens consistently', () => {
    const token = 'test-token-123';
    const hash1 = hashToken(token);
    const hash2 = hashToken(token);
    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('should produce SHA-256 hashes matching the helper', () => {
    const token = 'test-token-456';
    expect(hashToken(token)).toBe(sha256(token));
  });
});

describe('Encryption format compatibility', () => {
  it('helper encryptToken should produce data decryptable by the module', () => {
    initEncryption(TEST_MASTER_KEY);

    const token = 'sk-real-api-key-to-encrypt';
    const encrypted = encryptToken(token, TEST_MASTER_KEY);

    // The encrypted format should be: [iv(12)][tag(16)][ciphertext]
    expect(encrypted.length).toBeGreaterThan(28);

    // Should be decryptable by the api encryption module
    const decrypted = decrypt(encrypted);
    expect(decrypted).toBe(token);
  });
});
