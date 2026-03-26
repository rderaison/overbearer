import forge from "node-forge";
import crypto from "node:crypto";
import pg from "pg";

let caCert: forge.pki.Certificate | undefined;
let caKey: forge.pki.PrivateKey | undefined;

/**
 * Load CA certificate and encrypted private key from PostgreSQL.
 * Decrypts the key using OVERBEARER_MASTER_KEY.
 * Falls back to environment variables (OVERBEARER_CA_CERT / OVERBEARER_CA_KEY) if set.
 */
export async function loadCA(): Promise<void> {
  // Try env vars first (for local dev / testing)
  const envCert = process.env.OVERBEARER_CA_CERT;
  const envKey = process.env.OVERBEARER_CA_KEY;
  if (envCert && envKey) {
    caCert = forge.pki.certificateFromPem(envCert);
    caKey = forge.pki.privateKeyFromPem(envKey);
    console.log("[ca] loaded from environment variables");
    return;
  }

  // Load from database
  const pool = new pg.Pool({
    host: process.env.PGHOST || "localhost",
    port: parseInt(process.env.PGPORT || "5432"),
    database: process.env.PGDATABASE || "overbearer",
    user: process.env.PGUSER || "overbearer",
    password: process.env.PGPASSWORD || "overbearer",
    max: 2,
    connectionTimeoutMillis: 5000,
  });

  try {
    const result = await pool.query<{ cert_pem: string; key_pem_encrypted: Buffer }>(
      `SELECT cert_pem, key_pem_encrypted
       FROM ca_certificates
       WHERE is_active = TRUE
       ORDER BY created_at DESC
       LIMIT 1`,
    );

    if (result.rows.length === 0) {
      throw new Error("No active CA certificate found in database. Generate one via the management UI.");
    }

    const row = result.rows[0];

    // Parse certificate
    caCert = forge.pki.certificateFromPem(row.cert_pem);

    // Decrypt private key using master key
    const masterKeyHex = process.env.OVERBEARER_MASTER_KEY;
    if (!masterKeyHex) {
      throw new Error("OVERBEARER_MASTER_KEY is required to decrypt the CA private key");
    }
    const masterKey = Buffer.from(masterKeyHex, "hex");
    if (masterKey.length !== 32) {
      throw new Error("OVERBEARER_MASTER_KEY must be 64 hex characters (32 bytes)");
    }

    const encrypted = Buffer.isBuffer(row.key_pem_encrypted)
      ? row.key_pem_encrypted
      : Buffer.from(row.key_pem_encrypted);

    // Format: [iv (12)] [tag (16)] [ciphertext]
    const iv = encrypted.subarray(0, 12);
    const tag = encrypted.subarray(12, 28);
    const ciphertext = encrypted.subarray(28);

    const decipher = crypto.createDecipheriv("aes-256-gcm", masterKey, iv);
    decipher.setAuthTag(tag);
    const keyPem = decipher.update(ciphertext) + decipher.final("utf8");

    caKey = forge.pki.privateKeyFromPem(keyPem);
    console.log("[ca] loaded from database (encrypted key decrypted)");
  } finally {
    await pool.end();
  }
}

export function isCALoaded(): boolean {
  return caCert !== undefined && caKey !== undefined;
}

export function getCACert(): forge.pki.Certificate {
  if (!caCert) {
    throw new Error("CA not loaded. Call loadCA() first.");
  }
  return caCert;
}

export function getCAKey(): forge.pki.PrivateKey {
  if (!caKey) {
    throw new Error("CA not loaded. Call loadCA() first.");
  }
  return caKey;
}

/**
 * Periodically check for CA updates in the database.
 * Reloads if the CA changes (e.g., after regeneration from the management UI).
 */
let caCheckInterval: ReturnType<typeof setInterval> | undefined;
let lastCaCertPem: string | undefined;

type CAChangedCallback = () => void;
const caChangedCallbacks: CAChangedCallback[] = [];

/**
 * Register a callback to be invoked when the CA certificate changes.
 * Only fires on actual changes, not on initial watcher sync.
 */
export function onCAChanged(cb: CAChangedCallback): void {
  caChangedCallbacks.push(cb);
}

export function startCAWatcher(intervalMs = 30_000): void {
  caCheckInterval = setInterval(() => {
    void reloadIfChanged();
  }, intervalMs);
  if (caCheckInterval && typeof caCheckInterval === "object" && "unref" in caCheckInterval) {
    caCheckInterval.unref();
  }
}

export function stopCAWatcher(): void {
  if (caCheckInterval) {
    clearInterval(caCheckInterval);
    caCheckInterval = undefined;
  }
}

async function reloadIfChanged(): Promise<void> {
  try {
    const pg = await import("pg");
    const pool = new pg.default.Pool({
      host: process.env.PGHOST || "localhost",
      port: parseInt(process.env.PGPORT || "5432"),
      database: process.env.PGDATABASE || "overbearer",
      user: process.env.PGUSER || "overbearer",
      password: process.env.PGPASSWORD || "overbearer",
      max: 1,
      connectionTimeoutMillis: 3000,
    });
    try {
      const result = await pool.query<{ cert_pem: string }>(
        "SELECT cert_pem FROM ca_certificates WHERE is_active = TRUE ORDER BY created_at DESC LIMIT 1",
      );
      if (result.rows.length === 0) return;
      const newPem = result.rows[0].cert_pem;
      if (newPem !== lastCaCertPem) {
        const isInitialSync = lastCaCertPem === undefined;
        console.log("[ca] CA change detected, reloading...");
        await loadCA();
        lastCaCertPem = newPem;
        if (!isInitialSync) {
          console.log("[ca] notifying listeners of CA change...");
          for (const cb of caChangedCallbacks) {
            try { cb(); } catch { /* don't let a listener crash the watcher */ }
          }
        }
      }
    } finally {
      await pool.end();
    }
  } catch (err) {
    // Silent — don't crash the proxy for a poll failure
  }
}
