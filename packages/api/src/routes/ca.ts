import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import forge from 'node-forge';
import { query, getPool } from '../db/postgres.js';
import { encrypt } from '../services/encryption.js';
import { requireAuth, requireRole } from '../auth/rbac.js';

interface CaCertRow {
  id: string;
  cert_pem: string;
  is_active: boolean;
  expires_at: string;
  created_at: string;
}

export default async function caRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * GET /api/ca
   * Download the active CA public certificate in PEM format.
   * Any authenticated user can download it.
   */
  fastify.get(
    '/api/ca',
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const result = await query<CaCertRow>(
        `SELECT id, cert_pem, expires_at, created_at
         FROM ca_certificates
         WHERE is_active = TRUE
         ORDER BY created_at DESC
         LIMIT 1`,
      );

      if (result.rows.length === 0) {
        return reply.code(404).send({ error: 'No active CA certificate found' });
      }

      const cert = result.rows[0];
      return reply
        .header('Content-Type', 'application/x-pem-file')
        .header('Content-Disposition', 'attachment; filename="overbearer-ca.pem"')
        .send(cert.cert_pem);
    },
  );

  /**
   * POST /api/ca/generate
   * Generate a new self-signed CA certificate and key pair.
   * Encrypts the private key and stores both in DB. Deactivates old CAs.
   * Admin only.
   */
  fastify.post(
    '/api/ca/generate',
    { preHandler: requireRole('admin') },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      // Generate a 4096-bit RSA key pair
      const keys = forge.pki.rsa.generateKeyPair(4096);

      const cert = forge.pki.createCertificate();
      cert.publicKey = keys.publicKey;
      cert.serialNumber = '01';

      // Valid from now, for 20 years
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

      // CA extensions
      cert.setExtensions([
        { name: 'basicConstraints', cA: true, critical: true },
        {
          name: 'keyUsage',
          keyCertSign: true,
          cRLSign: true,
          critical: true,
        },
        {
          name: 'subjectKeyIdentifier',
        },
      ]);

      // Self-sign with SHA-256
      cert.sign(keys.privateKey, forge.md.sha256.create());

      const certPem = forge.pki.certificateToPem(cert);
      const keyPem = forge.pki.privateKeyToPem(keys.privateKey);

      // Encrypt the private key before storing
      const encryptedKey = encrypt(keyPem);

      // Deactivate all existing CAs and insert the new one, in a transaction
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

      return reply.code(201).send({
        success: true,
        expiresAt: expiry.toISOString(),
      });
    },
  );

  /**
   * POST /api/ca/upload
   * Upload a custom CA certificate and private key.
   * Validates the PEM, encrypts the key, stores in DB. Deactivates old CAs.
   * Admin only.
   */
  fastify.post(
    '/api/ca/upload',
    { preHandler: requireRole('admin') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as { certPem?: string; keyPem?: string } | undefined;

      if (!body?.certPem || !body?.keyPem) {
        return reply.code(400).send({ error: 'certPem and keyPem are required' });
      }

      // Validate the certificate
      let cert: forge.pki.Certificate;
      try {
        cert = forge.pki.certificateFromPem(body.certPem);
      } catch {
        return reply.code(400).send({ error: 'Invalid certificate PEM' });
      }

      // Validate it's a CA
      const bc = cert.getExtension('basicConstraints') as { cA?: boolean } | undefined;
      if (!bc?.cA) {
        return reply.code(400).send({ error: 'Certificate is not a CA (basicConstraints.cA is not true)' });
      }

      // Validate the private key
      let key: forge.pki.PrivateKey;
      try {
        key = forge.pki.privateKeyFromPem(body.keyPem);
      } catch {
        return reply.code(400).send({ error: 'Invalid private key PEM' });
      }

      // Verify the key matches the certificate
      const certPublicKeyPem = forge.pki.publicKeyToPem(cert.publicKey);
      const keyPublicKeyPem = forge.pki.publicKeyToPem(
        forge.pki.rsa.setPublicKey(
          (key as forge.pki.rsa.PrivateKey).n,
          (key as forge.pki.rsa.PrivateKey).e,
        ),
      );
      if (certPublicKeyPem !== keyPublicKeyPem) {
        return reply.code(400).send({ error: 'Private key does not match the certificate' });
      }

      const expiry = cert.validity.notAfter;
      const encryptedKey = encrypt(body.keyPem);

      const pool = getPool();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('UPDATE ca_certificates SET is_active = FALSE WHERE is_active = TRUE');
        await client.query(
          `INSERT INTO ca_certificates (cert_pem, key_pem_encrypted, is_active, expires_at)
           VALUES ($1, $2, TRUE, $3)`,
          [body.certPem, encryptedKey, expiry.toISOString()],
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      return reply.code(201).send({
        success: true,
        subject: cert.subject.getField('CN')?.value ?? 'Unknown',
        expiresAt: expiry.toISOString(),
      });
    },
  );
}
