import forge from "node-forge";
import { LRUCache } from "lru-cache";

interface CertEntry {
  cert: string; // PEM
  key: string; // PEM
}

const cache = new LRUCache<string, CertEntry>({
  max: 10_000,
  ttl: 24 * 60 * 60 * 1000, // 24 hours
});

/**
 * Generate a TLS certificate for the given hostname, signed by the provided CA.
 * Results are cached so repeated connections to the same host reuse certs.
 */
export function getCertForHost(
  hostname: string,
  caCert: forge.pki.Certificate,
  caKey: forge.pki.PrivateKey,
): CertEntry {
  const cached = cache.get(hostname);
  if (cached) {
    return cached;
  }

  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();

  cert.publicKey = keys.publicKey;
  cert.serialNumber = generateSerial();

  // Valid from 1 day ago to 365 days from now to avoid clock-skew issues
  const now = new Date();
  cert.validity.notBefore = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  cert.validity.notAfter = new Date(
    now.getTime() + 365 * 24 * 60 * 60 * 1000,
  );

  cert.setSubject([{ name: "commonName", value: hostname }]);
  cert.setIssuer(caCert.subject.attributes);

  cert.setExtensions([
    { name: "basicConstraints", cA: false },
    {
      name: "keyUsage",
      digitalSignature: true,
      keyEncipherment: true,
    },
    {
      name: "extKeyUsage",
      serverAuth: true,
    },
    {
      name: "subjectAltName",
      altNames: [
        // If hostname looks like an IP, add as IP; otherwise as DNS
        isIPAddress(hostname)
          ? { type: 7, ip: hostname }
          : { type: 2, value: hostname },
      ],
    },
  ]);

  cert.sign(caKey as forge.pki.rsa.PrivateKey, forge.md.sha256.create());

  const entry: CertEntry = {
    cert: forge.pki.certificateToPem(cert),
    key: forge.pki.privateKeyToPem(keys.privateKey),
  };

  cache.set(hostname, entry);
  return entry;
}

function generateSerial(): string {
  const bytes = forge.random.getBytesSync(16);
  // Ensure the leading bit is 0 (positive integer) per X.509
  const hex = forge.util.bytesToHex(bytes);
  return "0" + hex.slice(1);
}

export function clearCertCache(): void {
  cache.clear();
}

function isIPAddress(host: string): boolean {
  // Simple check covering IPv4 and bracketed IPv6
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(host) || host.includes(":");
}
