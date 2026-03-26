import forge from 'node-forge';
import { query, getPool } from '../db/postgres.js';
import { encrypt } from './encryption.js';

/**
 * Generate a new self-signed CA certificate and key pair.
 * Deactivates all existing CAs and stores the new one.
 * Returns the expiry date.
 */
export async function generateCa(): Promise<{ expiresAt: string }> {
  const keys = forge.pki.rsa.generateKeyPair(4096);

  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';

  const now = new Date();
  const expiry = new Date(now);
  expiry.setFullYear(expiry.getFullYear() + 20);

  cert.validity.notBefore = now;
  cert.validity.notAfter = expiry;

  const attrs = [
    { name: 'commonName', value: 'Overbearer CA' },
    { name: 'organizationName', value: 'Overbearer' },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);

  cert.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    { name: 'subjectKeyIdentifier' },
  ]);

  cert.sign(keys.privateKey, forge.md.sha256.create());

  const certPem = forge.pki.certificateToPem(cert);
  const keyPem = forge.pki.privateKeyToPem(keys.privateKey);
  const encryptedKey = encrypt(keyPem);

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE ca_certificates SET is_active = FALSE WHERE is_active = TRUE');
    await client.query(
      `INSERT INTO ca_certificates (cert_pem, key_pem_encrypted, is_active, expires_at)
       VALUES ($1, $2, TRUE, $3)`,
      [certPem, encryptedKey, expiry.toISOString()],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return { expiresAt: expiry.toISOString() };
}

/**
 * Ensure an active CA certificate exists in the database.
 * On a fresh install, auto-generates a self-signed CA so that TLS
 * can start immediately without manual intervention.
 */
export async function ensureCaExists(): Promise<void> {
  const existing = await query(
    'SELECT id FROM ca_certificates WHERE is_active = TRUE LIMIT 1',
  );
  if (existing.rows.length > 0) return;

  console.log('[ca] No active CA found — generating initial CA certificate...');
  const { expiresAt } = await generateCa();
  console.log(`[ca] Initial CA certificate generated (expires ${expiresAt})`);
}
