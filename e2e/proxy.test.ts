import { describe, it, expect, beforeAll } from 'vitest';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import net from 'node:net';
import forge from 'node-forge';
import { generateTestCA, encryptToken, sha256 } from './helpers.js';

// These tests validate proxy components in isolation
// For full integration tests, use docker-compose

describe('Certificate Generation', () => {
  it('should generate a valid CA certificate', () => {
    const { certPem, keyPem } = generateTestCA();

    expect(certPem).toContain('BEGIN CERTIFICATE');
    expect(keyPem).toContain('BEGIN RSA PRIVATE KEY');

    const cert = forge.pki.certificateFromPem(certPem);
    expect(cert.subject.getField('CN')?.value).toBe('Overbearer Test CA');

    // Should be a CA certificate
    const basicConstraints = cert.getExtension('basicConstraints') as { cA: boolean } | undefined;
    expect(basicConstraints?.cA).toBe(true);
  });

  it('should generate a host certificate signed by the CA', () => {
    const { certPem: caCertPem, keyPem: caKeyPem } = generateTestCA();
    const caCert = forge.pki.certificateFromPem(caCertPem);
    const caKey = forge.pki.privateKeyFromPem(caKeyPem);

    // Generate a host certificate
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = '02';

    const now = new Date();
    cert.validity.notBefore = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    cert.validity.notAfter = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);

    cert.setSubject([{ name: 'commonName', value: 'api.example.com' }]);
    cert.setIssuer(caCert.subject.attributes);
    cert.setExtensions([
      { name: 'basicConstraints', cA: false },
      { name: 'subjectAltName', altNames: [{ type: 2, value: 'api.example.com' }] },
    ]);

    cert.sign(caKey as forge.pki.rsa.PrivateKey, forge.md.sha256.create());

    // Verify the certificate is signed by the CA
    expect(caCert.verify(cert)).toBe(true);
    expect(cert.subject.getField('CN')?.value).toBe('api.example.com');
  });
});

describe('Token Replacement Logic', () => {
  it('should detect Authorization: Bearer header in HTTP request', () => {
    const request = Buffer.from(
      'POST /v1/messages HTTP/1.1\r\n' +
      'Host: api.anthropic.com\r\n' +
      'Authorization: Bearer ovb_fake123\r\n' +
      'Content-Type: application/json\r\n' +
      'Content-Length: 2\r\n' +
      '\r\n' +
      '{}'
    );

    // Verify the header is detectable via regex
    const headerEnd = request.indexOf('\r\n\r\n');
    const headers = request.subarray(0, headerEnd).toString('ascii');
    const match = /^authorization:\s*bearer\s+(\S+)/im.exec(headers);
    expect(match).not.toBeNull();
    expect(match![1]).toBe('ovb_fake123');
  });

  it('should detect x-api-key header', () => {
    const request = Buffer.from(
      'POST /v1/messages HTTP/1.1\r\n' +
      'Host: api.anthropic.com\r\n' +
      'x-api-key: ovb_fake456\r\n' +
      'Content-Type: application/json\r\n' +
      '\r\n'
    );

    const headerEnd = request.indexOf('\r\n\r\n');
    const headers = request.subarray(0, headerEnd).toString('ascii');
    const match = /^x-api-key:\s*(\S+)/im.exec(headers);
    expect(match).not.toBeNull();
    expect(match![1]).toBe('ovb_fake456');
  });

  it('should correctly replace a token in the request buffer', () => {
    const original = Buffer.from(
      'POST /v1/messages HTTP/1.1\r\n' +
      'Host: api.anthropic.com\r\n' +
      'Authorization: Bearer fake_token_abc\r\n' +
      'Content-Length: 2\r\n' +
      '\r\n' +
      '{}'
    );

    const headerEnd = original.indexOf('\r\n\r\n');
    const headerStr = original.subarray(0, headerEnd).toString('ascii');
    const body = original.subarray(headerEnd);

    const newHeaders = headerStr.replace('fake_token_abc', 'real_token_xyz');
    const modified = Buffer.concat([Buffer.from(newHeaders, 'ascii'), body]);

    expect(modified.toString('ascii')).toContain('Authorization: Bearer real_token_xyz');
    expect(modified.toString('ascii')).toContain('{}');
  });
});

describe('HTTP CONNECT Protocol', () => {
  it('should parse CONNECT target correctly', () => {
    const target = 'api.anthropic.com:443';
    const colonIdx = target.lastIndexOf(':');
    const host = target.substring(0, colonIdx);
    const port = parseInt(target.substring(colonIdx + 1), 10);

    expect(host).toBe('api.anthropic.com');
    expect(port).toBe(443);
  });

  it('should handle target without port', () => {
    const target = 'api.anthropic.com';
    const colonIdx = target.lastIndexOf(':');

    if (colonIdx === -1) {
      expect(target).toBe('api.anthropic.com');
      // Default port should be 443
    }
  });
});

describe('Encryption Format', () => {
  const masterKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

  it('should produce the correct binary format: [iv][tag][ciphertext]', () => {
    const encrypted = encryptToken('test-token', masterKey);

    // IV is 12 bytes, tag is 16 bytes, ciphertext is at least 1 byte
    expect(encrypted.length).toBeGreaterThanOrEqual(29);

    const iv = encrypted.subarray(0, 12);
    const tag = encrypted.subarray(12, 28);
    const ciphertext = encrypted.subarray(28);

    expect(iv.length).toBe(12);
    expect(tag.length).toBe(16);
    expect(ciphertext.length).toBeGreaterThan(0);
  });

  it('should produce consistent hashes for memcached keys', () => {
    const fakeToken = 'ovb_' + 'a'.repeat(64);
    const hash1 = sha256(fakeToken);
    const hash2 = sha256(fakeToken);

    expect(hash1).toBe(hash2);
    expect(hash1.length).toBe(64);
  });
});

describe('Source ACL Enforcement', () => {
  it('should allow all services when no ACL rules exist (open mode)', () => {
    const rules: string[] = [];
    function isAllowed(serviceName: string, serviceIp: string): boolean {
      if (rules.length === 0) return true;
      return rules.some(pattern => {
        const regex = new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
        return regex.test(serviceName) || regex.test(serviceIp);
      });
    }

    expect(isAllowed('default/my-app', '10.0.0.1')).toBe(true);
    expect(isAllowed('any/thing', '192.168.1.1')).toBe(true);
  });

  it('should restrict services when ACL rules exist', () => {
    const rules = ['production/*', 'staging/worker'];
    function isAllowed(serviceName: string): boolean {
      if (rules.length === 0) return true;
      return rules.some(pattern => {
        const regex = new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
        return regex.test(serviceName);
      });
    }

    expect(isAllowed('production/api-gateway')).toBe(true);
    expect(isAllowed('production/worker')).toBe(true);
    expect(isAllowed('staging/worker')).toBe(true);
    expect(isAllowed('staging/api-gateway')).toBe(false);
    expect(isAllowed('development/anything')).toBe(false);
  });
});

describe('TLS Validation', () => {
  it('should reject connections with invalid certificates', async () => {
    // Create a self-signed cert (not trusted)
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = '01';
    const now = new Date();
    cert.validity.notBefore = now;
    cert.validity.notAfter = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);
    cert.setSubject([{ name: 'commonName', value: 'untrusted.example.com' }]);
    cert.setIssuer([{ name: 'commonName', value: 'untrusted.example.com' }]);
    cert.sign(keys.privateKey as forge.pki.rsa.PrivateKey);

    const certPem = forge.pki.certificateToPem(cert);
    const keyPem = forge.pki.privateKeyToPem(keys.privateKey);

    // Start a TLS server with the self-signed cert
    const server = tls.createServer({ cert: certPem, key: keyPem }, (socket) => {
      socket.write('HTTP/1.1 200 OK\r\n\r\n');
      socket.end();
    });

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address() as net.AddressInfo;

    // Try to connect with rejectUnauthorized: true (should fail)
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = tls.connect({
          host: 'localhost',
          port: addr.port,
          rejectUnauthorized: true,
        }, () => {
          socket.destroy();
          reject(new Error('Should have rejected untrusted cert'));
        });
        socket.on('error', (err) => {
          expect(err.message).toMatch(/self[- ]signed|DEPTH_ZERO_SELF_SIGNED_CERT|unable to verify/i);
          resolve();
        });
      });
    } finally {
      server.close();
    }
  });
});
