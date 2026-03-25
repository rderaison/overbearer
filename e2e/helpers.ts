import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import forge from 'node-forge';

/**
 * Generate a self-signed CA certificate and key pair for testing.
 */
export function generateTestCA(): { certPem: string; keyPem: string } {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();

  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';

  const now = new Date();
  cert.validity.notBefore = now;
  cert.validity.notAfter = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);

  const attrs = [
    { name: 'commonName', value: 'Overbearer Test CA' },
    { name: 'organizationName', value: 'Overbearer Tests' },
  ];

  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true },
  ]);

  cert.sign(keys.privateKey as forge.pki.rsa.PrivateKey, forge.md.sha256.create());

  return {
    certPem: forge.pki.certificateToPem(cert),
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
  };
}

/**
 * Encrypt a token with AES-256-GCM using the given master key.
 * Returns the packed format: [iv(12)][tag(16)][ciphertext]
 */
export function encryptToken(plaintext: string, masterKeyHex: string): Buffer {
  const key = Buffer.from(masterKeyHex, 'hex');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]);
}

/**
 * SHA-256 hash a string.
 */
export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Wait for a port to become available.
 */
export async function waitForPort(port: number, host = 'localhost', timeoutMs = 10_000): Promise<void> {
  const { createConnection } = await import('node:net');
  const start = Date.now();

  return new Promise((resolve, reject) => {
    const attempt = () => {
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`Timeout waiting for ${host}:${port}`));
        return;
      }

      const socket = createConnection({ port, host }, () => {
        socket.destroy();
        resolve();
      });

      socket.on('error', () => {
        setTimeout(attempt, 200);
      });
    };

    attempt();
  });
}
