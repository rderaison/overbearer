import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import https from 'node:https';
import fs from 'node:fs';
import crypto from 'node:crypto';
import forge from 'node-forge';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { initEncryption } from './services/encryption.js';
import { initDatabase, closeDatabase } from './db/postgres.js';
import { syncAllTokensToMemcached } from './services/token-service.js';
import { closeMemcached } from './services/memcached-sync.js';
import { ensureCaExists } from './services/ca.js';

import authRoutes from './routes/auth.js';
import tokenRoutes from './routes/tokens.js';
import userRoutes from './routes/users.js';
import logRoutes from './routes/logs.js';
import caRoutes from './routes/ca.js';
import serviceRoutes from './routes/services.js';
import tokenRequestRoutes from './routes/token-requests.js';
import groupRoutes from './routes/groups.js';
import proxyAclRoutes from './routes/proxy-acls.js';
import newServiceRoutes from './routes/new-services.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = parseInt(process.env.PORT || '3000', 10);
const TLS_PORT = parseInt(process.env.TLS_PORT || '3443', 10);
const HOST = process.env.HOST || '0.0.0.0';

async function main(): Promise<void> {
  // --- Validate required environment ---
  const masterKey = process.env.OVERBEARER_MASTER_KEY;
  if (!masterKey) {
    console.error('OVERBEARER_MASTER_KEY environment variable is required');
    process.exit(1);
  }

  const jwtSecret = process.env.OVERBEARER_JWT_SECRET;
  if (!jwtSecret) {
    console.error('OVERBEARER_JWT_SECRET environment variable is required');
    process.exit(1);
  }

  // --- Initialize encryption ---
  initEncryption(masterKey);

  // --- Initialize database ---
  await initDatabase();
  console.log('Database initialized');

  // --- Set up Fastify ---
  const fastify = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || 'info',
      // Never serialize token values into logs
      serializers: {
        req(request) {
          return {
            method: request.method,
            url: request.url,
            hostname: request.hostname,
            remoteAddress: request.ip,
          };
        },
      },
    },
    trustProxy: true,
  });

  // --- Register plugins ---
  await fastify.register(fastifyCors, {
    origin: true,
    credentials: true,
  });

  await fastify.register(fastifyCookie);

  // --- Health endpoint ---
  fastify.get('/api/health', async () => ({ status: 'ok' }));

  // --- Register route plugins ---
  await fastify.register(authRoutes);
  await fastify.register(tokenRoutes);
  await fastify.register(userRoutes);
  await fastify.register(logRoutes);
  await fastify.register(caRoutes);
  await fastify.register(serviceRoutes);
  await fastify.register(tokenRequestRoutes);
  await fastify.register(groupRoutes);
  await fastify.register(proxyAclRoutes);
  await fastify.register(newServiceRoutes);

  // --- Serve static files from UI build directory ---
  // In Docker, UI is at ../public; in dev, at ../../ui/dist
  const dockerUiPath = join(__dirname, '..', 'public');
  const devUiPath = join(__dirname, '..', '..', 'ui', 'dist');
  const { existsSync } = await import('node:fs');
  const uiDistPath = existsSync(dockerUiPath) ? dockerUiPath : devUiPath;
  await fastify.register(fastifyStatic, {
    root: uiDistPath,
    prefix: '/',
    wildcard: false,
    decorateReply: true,
  });

  // SPA fallback: serve index.html for non-API routes
  fastify.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith('/api/')) {
      return reply.code(404).send({ error: 'Not found' });
    }
    return reply.sendFile('index.html');
  });

  // --- Global error handler ---
  fastify.setErrorHandler(async (error: { statusCode?: number; message: string }, request, reply) => {
    request.log.error(error);
    const statusCode = error.statusCode || 500;
    return reply.code(statusCode).send({
      error: statusCode >= 500 ? 'Internal server error' : error.message,
    });
  });

  // --- Sync tokens to memcached on startup ---
  try {
    const count = await syncAllTokensToMemcached();
    console.log(`Synced ${count} tokens to memcached`);
  } catch (err) {
    console.error('Failed to sync tokens to memcached:', (err as Error).message);
    // Non-fatal: continue startup, tokens can be synced later
  }

  // --- Ensure CA exists (auto-generate on fresh install) ---
  await ensureCaExists();

  // --- TLS setup ---
  const tlsCreds = await getTlsCredentials();
  const rpId = process.env.OVERBEARER_RP_ID || 'localhost';

  // Redirect HTTP → HTTPS (except /api/ca and /api/health)
  if (tlsCreds) {
    fastify.addHook('onRequest', async (request, reply) => {
      const isHttps = request.headers['x-forwarded-proto'] === 'https'
        || (request.raw.socket as any).encrypted;
      const exempt = request.url === '/api/ca'
        || request.url === '/api/health'
        || request.url.startsWith('/api/ca?');
      if (!isHttps && !exempt) {
        const extPort = parseInt(process.env.EXTERNAL_TLS_PORT || '443', 10);
        const target = `https://${rpId}${extPort === 443 ? '' : `:${extPort}`}${request.url}`;
        return reply.redirect(target);
      }
    });
  }

  // --- Start HTTP server ---
  await fastify.listen({ port: PORT, host: HOST });
  console.log(`Overbearer API (HTTP) listening on ${HOST}:${PORT}`);

  // --- Start HTTPS server ---
  if (tlsCreds) {
    const tlsServer = https.createServer(
      { cert: tlsCreds.cert, key: tlsCreds.key },
      fastify.server.listeners('request')[0] as any,
    );
    tlsServer.listen(TLS_PORT, HOST, () => {
      console.log(`Overbearer API (HTTPS) listening on ${HOST}:${TLS_PORT} (${tlsCreds.source})`);
    });
  } else {
    console.log('No TLS credentials available, HTTPS disabled. Generate a CA first.');
  }

  // --- Graceful shutdown ---
  const shutdown = async (signal: string) => {
    console.log(`Received ${signal}, shutting down gracefully...`);
    try {
      await fastify.close();
      closeMemcached();
      await closeDatabase();
      console.log('Shutdown complete');
      process.exit(0);
    } catch (err) {
      console.error('Error during shutdown:', err);
      process.exit(1);
    }
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

/**
 * Get TLS credentials for the HTTPS listener.
 * Priority: 1) Custom cert from file, 2) Auto-generated from CA
 */
async function getTlsCredentials(): Promise<{ cert: string; key: string; source: string } | null> {
  // 1. Check for custom cert file
  const customPemPath = process.env.MANAGEMENT_TLS_PEM || '/etc/ssl/management/tls.pem';
  try {
    if (fs.existsSync(customPemPath)) {
      const pem = fs.readFileSync(customPemPath, 'utf8');
      const certMatch = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
      const keyMatch = pem.match(/-----BEGIN (?:RSA )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA )?PRIVATE KEY-----/);
      if (certMatch && keyMatch) {
        return { cert: certMatch.join('\n'), key: keyMatch[0], source: 'custom cert' };
      }
    }
  } catch { /* fall through */ }

  // 2. Load from DB cache or auto-generate
  try {
    const { query: dbQuery } = await import('./db/postgres.js');
    const { getMasterKey } = await import('./services/encryption.js');
    const masterKey = getMasterKey();

    // Get the current CA
    const caResult = await dbQuery<{ cert_pem: string; key_pem_encrypted: Buffer }>(
      'SELECT cert_pem, key_pem_encrypted FROM ca_certificates WHERE is_active = TRUE ORDER BY created_at DESC LIMIT 1',
    );
    if (caResult.rows.length === 0) return null;

    const caRow = caResult.rows[0];
    const caHash = crypto.createHash('sha256').update(caRow.cert_pem).digest('hex');
    const serviceName = 'overbearer-management';

    // Check for existing cached cert
    const cached = await dbQuery<{
      cert_pem: string; key_pem_encrypted: Buffer; ca_cert_hash: string; expires_at: string;
    }>(
      'SELECT cert_pem, key_pem_encrypted, ca_cert_hash, expires_at FROM service_certificates WHERE service_name = $1',
      [serviceName],
    );

    if (cached.rows.length > 0) {
      const row = cached.rows[0];
      const stillValid = new Date(row.expires_at) > new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      if (row.ca_cert_hash === caHash && stillValid) {
        const enc = Buffer.isBuffer(row.key_pem_encrypted) ? row.key_pem_encrypted : Buffer.from(row.key_pem_encrypted);
        const iv = enc.subarray(0, 12);
        const tag = enc.subarray(12, 28);
        const ct = enc.subarray(28);
        const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey, iv);
        decipher.setAuthTag(tag);
        const keyPem = decipher.update(ct) + decipher.final('utf8');
        console.log(`[tls] reusing cached cert for ${serviceName}`);
        return { cert: row.cert_pem, key: keyPem, source: 'cached cert' };
      }
    }

    // Generate new cert
    const encrypted = Buffer.isBuffer(caRow.key_pem_encrypted) ? caRow.key_pem_encrypted : Buffer.from(caRow.key_pem_encrypted);
    const iv2 = encrypted.subarray(0, 12);
    const tag2 = encrypted.subarray(12, 28);
    const ct2 = encrypted.subarray(28);
    const decipher2 = crypto.createDecipheriv('aes-256-gcm', masterKey, iv2);
    decipher2.setAuthTag(tag2);
    const caKeyPem = decipher2.update(ct2) + decipher2.final('utf8');

    const caCert = forge.pki.certificateFromPem(caRow.cert_pem);
    const caKey = forge.pki.privateKeyFromPem(caKeyPem);

    const hostname = process.env.OVERBEARER_RP_ID || 'localhost';
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = forge.util.bytesToHex(forge.random.getBytesSync(16));
    const now = new Date();
    cert.validity.notBefore = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    cert.validity.notAfter = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);
    cert.setSubject([{ name: 'commonName', value: hostname }]);
    cert.setIssuer(caCert.subject.attributes);
    cert.setExtensions([
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames: [
        { type: 2, value: hostname },
        { type: 2, value: `overbearer-management.${process.env.POD_NAMESPACE || 'overbearer'}.svc.cluster.local` },
        { type: 2, value: 'localhost' },
      ]},
    ]);
    cert.sign(caKey as forge.pki.rsa.PrivateKey, forge.md.sha256.create());

    const certPem = forge.pki.certificateToPem(cert);
    const keyPem = forge.pki.privateKeyToPem(keys.privateKey);

    // Encrypt and store
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', masterKey, iv);
    const encData = Buffer.concat([cipher.update(keyPem, 'utf8'), cipher.final()]);
    const encTag = cipher.getAuthTag();
    const encryptedKey = Buffer.concat([iv, encTag, encData]);

    await dbQuery(
      `INSERT INTO service_certificates (service_name, cert_pem, key_pem_encrypted, ca_cert_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (service_name) DO UPDATE SET
         cert_pem = EXCLUDED.cert_pem, key_pem_encrypted = EXCLUDED.key_pem_encrypted,
         ca_cert_hash = EXCLUDED.ca_cert_hash, expires_at = EXCLUDED.expires_at, created_at = NOW()`,
      [serviceName, certPem, encryptedKey, caHash, cert.validity.notAfter.toISOString()],
    );

    console.log(`[tls] generated and stored new cert for ${serviceName}`);
    return { cert: certPem, key: keyPem, source: `auto-generated for ${hostname}` };
  } catch (err) {
    console.warn('Failed to auto-generate TLS cert:', err instanceof Error ? err.message : err);
    return null;
  }
}

main().catch((err) => {
  console.error('Fatal error starting Overbearer API:', err);
  process.exit(1);
});
