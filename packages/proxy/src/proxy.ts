import http from "node:http";
import https from "node:https";
import net from "node:net";
import crypto from "node:crypto";
import pg from "pg";
import forge from "node-forge";
import { performMitm } from "./tls/mitm.js";
import { identifyService } from "./k8s/service-id.js";
import { log, type ProxyLogEntry } from "./logging/clickhouse.js";
import { lookupFakeToken } from "./token/memcached.js";
import { isCALoaded, getCACert, getCAKey } from "./tls/ca.js";
import { getCertForHost } from "./tls/cert-cache.js";
import { isServiceAllowed } from "./acl/source-acl.js";

function cleanIp(ip: string): string {
  // Strip IPv4-mapped IPv6 prefix
  return ip.replace(/^::ffff:/, "");
}

let server: http.Server | undefined;
let tlsServer: https.Server | undefined;
let concurrentConnections = 0;

export function getConcurrentConnections(): number {
  return concurrentConnections;
}

/**
 * Start the proxy server.
 * Handles HTTP CONNECT requests for MiTM TLS interception.
 */
function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  // Health check endpoint for K8s probes
  if (req.url === "/healthz" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", connections: concurrentConnections }));
    return;
  }
  // Handle plain HTTP proxy requests (non-CONNECT)
  if (req.url && req.url.startsWith("http://")) {
    void handleHttpProxy(req, res);
    return;
  }
  res.writeHead(405, { "Content-Type": "text/plain" });
  res.end("Use this as an HTTP/HTTPS proxy.\n");
}

function handleConnectEvent(
  req: http.IncomingMessage,
  clientSocket: net.Socket,
  _head: Buffer,
): void {
  void handleConnect(req, clientSocket);
}

function handleClientError(err: Error, socket: net.Socket | import("node:stream").Duplex): void {
  console.error("[proxy] client error:", err.message);
  if (socket.writable) {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  }
}

export function startProxy(port: number): http.Server {
  server = http.createServer(handleRequest);
  server.on("connect", handleConnectEvent);
  server.on("clientError", handleClientError);

  server.listen(port, () => {
    console.log(`[proxy] HTTP listening on port ${port}`);
  });

  // Start TLS listener — auto-generate cert from CA
  const tlsPort = parseInt(process.env.TLS_PORT ?? "8443", 10);
  startTlsListener(tlsPort);

  return server;
}

function startTlsListener(tlsPort: number): void {
  if (tlsServer) {
    tlsServer.close();
    tlsServer = undefined;
  }

  if (!isCALoaded()) {
    console.log("[proxy] CA not loaded, HTTPS listener deferred");
    const retryInterval = setInterval(() => {
      if (isCALoaded()) {
        clearInterval(retryInterval);
        startTlsListener(tlsPort);
      }
    }, 1_000);
    retryInterval.unref();
    return;
  }

  void loadOrGenerateServiceCert("overbearer-proxy").then((creds) => {
    if (!creds) {
      console.warn("[proxy] Could not obtain TLS cert, HTTPS disabled");
      return;
    }

    tlsServer = https.createServer({ cert: creds.cert, key: creds.key }, handleRequest);
    tlsServer.on("connect", handleConnectEvent);
    tlsServer.on("clientError", handleClientError);

    tlsServer.listen(tlsPort, () => {
      console.log(`[proxy] HTTPS listening on port ${tlsPort} (${creds.source})`);
    });
  }).catch((err) => {
    console.warn("[proxy] Failed to start TLS listener:", err instanceof Error ? err.message : err);
  });
}

/**
 * Load an existing service cert from DB, or generate a new one if the CA changed.
 */
async function loadOrGenerateServiceCert(
  serviceName: string,
): Promise<{ cert: string; key: string; source: string } | null> {
  const masterKeyHex = process.env.OVERBEARER_MASTER_KEY;
  if (!masterKeyHex) return null;
  const masterKey = Buffer.from(masterKeyHex, "hex");

  // Hash the current CA cert to detect changes
  const caCertPem = forge.pki.certificateToPem(getCACert());
  const caHash = crypto.createHash("sha256").update(caCertPem).digest("hex");

  const pool = new pg.Pool({
    host: process.env.PGHOST || "localhost",
    port: parseInt(process.env.PGPORT || "5432"),
    database: process.env.PGDATABASE || "overbearer",
    user: process.env.PGUSER || "overbearer",
    password: process.env.PGPASSWORD || "overbearer",
    max: 1,
    connectionTimeoutMillis: 5000,
  });

  try {
    // Check for existing cert
    const existing = await pool.query<{
      cert_pem: string;
      key_pem_encrypted: Buffer;
      ca_cert_hash: string;
      expires_at: string;
    }>(
      "SELECT cert_pem, key_pem_encrypted, ca_cert_hash, expires_at FROM service_certificates WHERE service_name = $1",
      [serviceName],
    );

    if (existing.rows.length > 0) {
      const row = existing.rows[0];
      const stillValid = new Date(row.expires_at) > new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // >7d left
      if (row.ca_cert_hash === caHash && stillValid) {
        // Decrypt and reuse
        const enc = Buffer.isBuffer(row.key_pem_encrypted) ? row.key_pem_encrypted : Buffer.from(row.key_pem_encrypted);
        const iv = enc.subarray(0, 12);
        const tag = enc.subarray(12, 28);
        const ct = enc.subarray(28);
        const decipher = crypto.createDecipheriv("aes-256-gcm", masterKey, iv);
        decipher.setAuthTag(tag);
        const keyPem = decipher.update(ct) + decipher.final("utf8");
        console.log(`[tls] reusing existing cert for ${serviceName}`);
        return { cert: row.cert_pem, key: keyPem, source: "cached cert" };
      }
    }

    // Generate new cert
    const hostname = serviceName;
    const extraHosts = process.env.PROXY_TLS_HOSTNAMES;
    const ns = process.env.POD_NAMESPACE || "overbearer";
    const altNames: { type: number; value: string }[] = [
      { type: 2, value: hostname },
      { type: 2, value: `${serviceName}.${ns}.svc.cluster.local` },
      { type: 2, value: "localhost" },
    ];
    if (extraHosts) {
      for (const h of extraHosts.split(",").map((s) => s.trim()).filter(Boolean)) {
        altNames.push({ type: 2, value: h });
      }
    }

    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = forge.util.bytesToHex(forge.random.getBytesSync(16));
    const now = new Date();
    cert.validity.notBefore = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    cert.validity.notAfter = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);
    cert.setSubject([{ name: "commonName", value: hostname }]);
    cert.setIssuer(getCACert().subject.attributes);
    cert.setExtensions([
      { name: "basicConstraints", cA: false },
      { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
      { name: "extKeyUsage", serverAuth: true },
      { name: "subjectAltName", altNames },
    ]);
    cert.sign(getCAKey() as forge.pki.rsa.PrivateKey, forge.md.sha256.create());

    const certPem = forge.pki.certificateToPem(cert);
    const keyPem = forge.pki.privateKeyToPem(keys.privateKey);

    // Encrypt the key
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", masterKey, iv);
    const encrypted = Buffer.concat([cipher.update(keyPem, "utf8"), cipher.final()]);
    const encTag = cipher.getAuthTag();
    const encryptedKey = Buffer.concat([iv, encTag, encrypted]);

    // Upsert into DB
    await pool.query(
      `INSERT INTO service_certificates (service_name, cert_pem, key_pem_encrypted, ca_cert_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (service_name) DO UPDATE SET
         cert_pem = EXCLUDED.cert_pem,
         key_pem_encrypted = EXCLUDED.key_pem_encrypted,
         ca_cert_hash = EXCLUDED.ca_cert_hash,
         expires_at = EXCLUDED.expires_at,
         created_at = NOW()`,
      [serviceName, certPem, encryptedKey, caHash, cert.validity.notAfter.toISOString()],
    );

    console.log(`[tls] generated and stored new cert for ${serviceName}`);
    return { cert: certPem, key: keyPem, source: "newly generated" };
  } finally {
    await pool.end();
  }
}

/**
 * Handle plain HTTP proxy requests.
 * Replaces bearer tokens in the forwarded request just like the MiTM path.
 */
async function handleHttpProxy(
  clientReq: http.IncomingMessage,
  clientRes: http.ServerResponse,
): Promise<void> {
  concurrentConnections++;
  const start = performance.now();
  const sourceIp = cleanIp(clientReq.socket.remoteAddress ?? "unknown");

  try {
    const targetUrl = new URL(clientReq.url!);

    // Identify the service and check ACL before doing any work
    const serviceIdentity = await identifyService(sourceIp);
    if (!isServiceAllowed(serviceIdentity.name, serviceIdentity.ip)) {
      console.warn(
        `[proxy] ACL denied HTTP request from ${serviceIdentity.name} (${serviceIdentity.ip}) -> ${targetUrl.hostname}`,
      );
      log({
        timestamp: new Date(),
        service_name: serviceIdentity.name,
        service_ip: serviceIdentity.ip,
        target_host: targetUrl.hostname,
        target_path: targetUrl.pathname,
        method: clientReq.method ?? "GET",
        token_type: "acl_denied",
        token_id: "",
        token_preview: "",
        token_full: "",
        response_status: 403,
        latency_ms: performance.now() - start,
      });
      clientRes.writeHead(403, { "Content-Type": "application/json" });
      clientRes.end(JSON.stringify({ error: "Service not allowed by proxy ACL" }));
      return;
    }

    // Token replacement on Authorization / x-api-key headers
    let tokenType: string = "none";
    let tokenId = "";
    let tokenPreview = "";
    let tokenFull = "";

    const authHeader = clientReq.headers["authorization"];
    const apiKeyHeader = clientReq.headers["x-api-key"];
    const token = authHeader
      ? authHeader.replace(/^bearer\s+/i, "")
      : typeof apiKeyHeader === "string"
        ? apiKeyHeader
        : undefined;

    if (token) {
      const hash = crypto.createHash("sha256").update(token).digest("hex");
      tokenId = hash.substring(0, 16);
      tokenPreview = token.length > 10
        ? token.substring(0, 5) + "..." + token.substring(token.length - 4)
        : token.substring(0, 2) + "..." + token.substring(token.length - 2);
      tokenFull = token;

      const realToken = await lookupFakeToken(hash);
      if (realToken) {
        if (authHeader) {
          clientReq.headers["authorization"] = `Bearer ${realToken}`;
        } else {
          clientReq.headers["x-api-key"] = realToken;
        }
        tokenType = "fake";
      } else {
        // Not a known fake token — it's a real token being used directly
        tokenType = "real_direct";
      }
    }

    // Forward the request
    const proxyReq = http.request(
      {
        hostname: targetUrl.hostname,
        port: targetUrl.port || 80,
        path: targetUrl.pathname + targetUrl.search,
        method: clientReq.method,
        headers: {
          ...clientReq.headers,
          host: targetUrl.host,
        },
      },
      (proxyRes) => {
        clientRes.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
        proxyRes.pipe(clientRes, { end: true });

        // Only log requests that carry a token
        if (tokenType !== "none") {
          log({
            timestamp: new Date(),
            service_name: serviceIdentity.name,
            service_ip: serviceIdentity.ip,
            target_host: targetUrl.hostname,
            target_path: targetUrl.pathname,
            method: clientReq.method ?? "GET",
            token_type: tokenType,
            token_id: tokenId,
            token_preview: tokenPreview,
            token_full: tokenFull,
            response_status: proxyRes.statusCode ?? 0,
            latency_ms: performance.now() - start,
          });
        }
      },
    );

    proxyReq.on("error", (err) => {
      console.error(`[proxy] HTTP proxy error to ${clientReq.url}:`, err.message);
      if (!clientRes.headersSent) {
        clientRes.writeHead(502, { "Content-Type": "application/json" });
      }
      clientRes.end(JSON.stringify({ error: `Proxy error: ${err.message}` }));
    });

    clientReq.pipe(proxyReq, { end: true });
  } catch (err) {
    console.error(
      `[proxy] HTTP proxy error:`,
      err instanceof Error ? err.message : err,
    );
    if (!clientRes.headersSent) {
      clientRes.writeHead(502, { "Content-Type": "application/json" });
    }
    clientRes.end(JSON.stringify({ error: "Proxy error" }));
  } finally {
    concurrentConnections--;
  }
}

async function handleConnect(
  req: http.IncomingMessage,
  clientSocket: net.Socket,
): Promise<void> {
  concurrentConnections++;

  const target = req.url ?? "";
  const [targetHost, targetPortStr] = parseHostPort(target);

  if (!targetHost) {
    clientSocket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    clientSocket.end();
    concurrentConnections--;
    return;
  }

  const targetPort = parseInt(targetPortStr, 10) || 443;
  const sourceIp = cleanIp(clientSocket.remoteAddress ?? "unknown");

  if (!isCALoaded()) {
    clientSocket.write("HTTP/1.1 503 Service Unavailable\r\n\r\nOverbearer proxy: CA not yet loaded\r\n");
    clientSocket.end();
    concurrentConnections--;
    return;
  }

  // Acknowledge the CONNECT tunnel
  clientSocket.write(
    "HTTP/1.1 200 Connection Established\r\n\r\n",
  );

  clientSocket.on("error", (err) => {
    console.error(`[proxy] client socket error (${target}):`, err.message);
  });

  try {
    // Identify the K8s service first, then check ACL before MiTM
    const serviceIdentity = await identifyService(sourceIp);

    if (!isServiceAllowed(serviceIdentity.name, serviceIdentity.ip)) {
      console.warn(
        `[proxy] ACL denied CONNECT from ${serviceIdentity.name} (${serviceIdentity.ip}) -> ${target}`,
      );
      log({
        timestamp: new Date(),
        service_name: serviceIdentity.name,
        service_ip: serviceIdentity.ip,
        target_host: targetHost,
        target_path: "",
        method: "CONNECT",
        token_type: "acl_denied",
        token_id: "",
        token_preview: "",
        token_full: "",
        response_status: 403,
        latency_ms: 0,
      });
      clientSocket.end();
      return;
    }

    const mitmResult = await performMitm(clientSocket, targetHost, targetPort);

    const entry: ProxyLogEntry = {
      timestamp: new Date(),
      service_name: serviceIdentity.name,
      service_ip: serviceIdentity.ip,
      target_host: mitmResult.targetHost,
      target_path: mitmResult.path,
      method: mitmResult.method,
      token_type: mitmResult.tokenResult.type,
      token_id: mitmResult.tokenResult.tokenId ?? "",
      token_preview: mitmResult.tokenResult.tokenPreview ?? "",
      token_full: mitmResult.tokenResult.tokenFull ?? "",
      response_status: mitmResult.responseStatus,
      latency_ms: mitmResult.latencyMs,
    };

    // Only log requests that have a token (skip tokenless browsing traffic)
    if (mitmResult.tokenResult.type !== "none") {
      log(entry);
    }

    if (mitmResult.tokenResult.type === "real_direct") {
      console.warn(
        `[proxy] WARNING: real token used directly by ${serviceIdentity.name} -> ${mitmResult.targetHost}${mitmResult.path}`,
      );
    }
  } catch (err) {
    console.error(
      `[proxy] error handling CONNECT to ${target}:`,
      err instanceof Error ? err.message : err,
    );
    if (!clientSocket.destroyed) {
      clientSocket.end();
    }
  } finally {
    concurrentConnections--;
  }
}

function parseHostPort(target: string): [string, string] {
  const colonIdx = target.lastIndexOf(":");
  if (colonIdx === -1) {
    return [target, "443"];
  }
  return [target.substring(0, colonIdx), target.substring(colonIdx + 1)];
}

/**
 * Gracefully shut down the proxy server.
 * Stops accepting new connections and waits for existing ones to drain.
 */
export async function shutdownProxy(): Promise<void> {
  console.log(
    `[proxy] shutting down (${concurrentConnections} connections in flight)`,
  );

  const closeServer = (s: http.Server | https.Server | undefined): Promise<void> =>
    new Promise((resolve) => {
      if (!s) { resolve(); return; }
      s.close(() => resolve());
      setTimeout(() => resolve(), 30_000).unref();
    });

  await Promise.all([closeServer(server), closeServer(tlsServer)]);
}
