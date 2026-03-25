import tls from "node:tls";
import net from "node:net";
import { getCertForHost } from "./cert-cache.js";
import { getCACert, getCAKey, isCALoaded } from "./ca.js";
import { replaceToken, type TokenResult } from "../token/replacer.js";

export interface MitmResult {
  targetHost: string;
  method: string;
  path: string;
  responseStatus: number;
  latencyMs: number;
  tokenResult: TokenResult;
}

/**
 * Perform MiTM interception on a CONNECT-tunnelled connection.
 *
 * 1. Present a forged cert to the client so we can decrypt traffic.
 * 2. Parse the HTTP request, replace bearer tokens.
 * 3. Open a TLS connection to the real server (with cert validation!).
 * 4. Forward the (modified) request, relay the response back to the client.
 */
export async function performMitm(
  clientSocket: net.Socket,
  targetHost: string,
  targetPort: number,
): Promise<MitmResult> {
  const start = performance.now();

  if (!isCALoaded()) {
    const response = buildErrorResponse(503, "Overbearer proxy: CA not configured. Generate a CA in the management UI.");
    clientSocket.write(response);
    clientSocket.end();
    return {
      targetHost,
      method: "CONNECT",
      path: "/",
      responseStatus: 503,
      latencyMs: performance.now() - start,
      tokenResult: { type: "none" },
    };
  }

  const { cert, key } = getCertForHost(targetHost, getCACert(), getCAKey());

  // Wrap the client socket in a TLS server context with the forged cert
  const tlsClientSocket = await tlsServerWrap(clientSocket, cert, key);

  try {
    // Read the full HTTP request from the client
    const rawRequest = await readHttpRequest(tlsClientSocket);

    // Parse basic request line for logging
    const { method, path } = parseRequestLine(rawRequest);

    // Replace fake tokens with real ones
    const { modifiedRequest, result: tokenResult } =
      await replaceToken(rawRequest);

    // Connect to the real upstream server with proper TLS validation
    let upstreamSocket: tls.TLSSocket;
    try {
      upstreamSocket = await connectUpstream(targetHost, targetPort);
    } catch (err) {
      // Upstream TLS validation failed - return 503 to client
      const msg =
        err instanceof Error ? err.message : "upstream TLS error";
      const response = buildErrorResponse(
        503,
        `Upstream TLS error: ${msg}`,
      );
      tlsClientSocket.write(response);
      tlsClientSocket.end();
      return {
        targetHost,
        method,
        path,
        responseStatus: 503,
        latencyMs: performance.now() - start,
        tokenResult,
      };
    }

    try {
      // Forward the modified request to the upstream server
      upstreamSocket.write(modifiedRequest);

      // Read the response from upstream
      const responseBuffer = await readFullResponse(upstreamSocket);

      // Parse the status code from the response
      const responseStatus = parseResponseStatus(responseBuffer);

      // Send the response back to the client
      tlsClientSocket.write(responseBuffer);
      tlsClientSocket.end();

      return {
        targetHost,
        method,
        path,
        responseStatus,
        latencyMs: performance.now() - start,
        tokenResult,
      };
    } finally {
      upstreamSocket.destroy();
    }
  } catch (err) {
    // Best-effort error response to client
    try {
      const response = buildErrorResponse(
        502,
        `Proxy error: ${err instanceof Error ? err.message : "unknown"}`,
      );
      tlsClientSocket.write(response);
      tlsClientSocket.end();
    } catch {
      // Client socket may already be dead
    }
    throw err;
  }
}

function tlsServerWrap(
  socket: net.Socket,
  cert: string,
  key: string,
): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const secureContext = tls.createSecureContext({ cert, key });

    const tlsSock = new tls.TLSSocket(socket, {
      isServer: true,
      secureContext,
    });

    tlsSock.once("secure", () => resolve(tlsSock));
    tlsSock.once("error", reject);
  });
}

function connectUpstream(
  host: string,
  port: number,
): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(
      {
        host,
        port,
        servername: host,
        // Do NOT set rejectUnauthorized: false - we want validation
        rejectUnauthorized: true,
      },
      () => {
        if (!socket.authorized) {
          socket.destroy();
          reject(
            new Error(
              `Upstream certificate not authorized: ${socket.authorizationError}`,
            ),
          );
          return;
        }
        resolve(socket);
      },
    );

    socket.once("error", (err) => {
      reject(err);
    });

    // 10 second connect timeout
    socket.setTimeout(10_000, () => {
      socket.destroy(new Error("Upstream connect timeout"));
    });
  });
}

/**
 * Read a complete HTTP request from the socket.
 * We accumulate data until we have the full headers, then read Content-Length
 * bytes of body if present.
 */
function readHttpRequest(socket: tls.TLSSocket): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let headerEnd = -1;
    let expectedLength = -1;

    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      const combined = Buffer.concat(chunks);

      // Look for end of headers
      if (headerEnd === -1) {
        headerEnd = combined.indexOf("\r\n\r\n");
        if (headerEnd === -1) return; // Keep reading headers

        headerEnd += 4; // Include the \r\n\r\n

        // Parse Content-Length
        const headerStr = combined.subarray(0, headerEnd).toString("ascii");
        const clMatch = headerStr.match(/content-length:\s*(\d+)/i);
        if (clMatch) {
          expectedLength = headerEnd + parseInt(clMatch[1], 10);
        } else {
          // No body expected (GET, DELETE, etc.)
          expectedLength = headerEnd;
        }
      }

      if (combined.length >= expectedLength) {
        socket.removeListener("data", onData);
        socket.removeListener("error", onError);
        socket.removeListener("end", onEnd);
        resolve(combined.subarray(0, expectedLength));
      }
    };

    const onError = (err: Error) => {
      socket.removeListener("data", onData);
      socket.removeListener("end", onEnd);
      reject(err);
    };

    const onEnd = () => {
      socket.removeListener("data", onData);
      socket.removeListener("error", onError);
      // If we got some data, return it; otherwise it's an error
      if (chunks.length > 0) {
        resolve(Buffer.concat(chunks));
      } else {
        reject(new Error("Client disconnected before sending request"));
      }
    };

    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("end", onEnd);
  });
}

function readFullResponse(socket: tls.TLSSocket): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let headerEnd = -1;
    let expectedLength = -1;
    let isChunked = false;

    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      const combined = Buffer.concat(chunks);

      if (headerEnd === -1) {
        headerEnd = combined.indexOf("\r\n\r\n");
        if (headerEnd === -1) return;
        headerEnd += 4;

        const headerStr = combined.subarray(0, headerEnd).toString("ascii");
        const clMatch = headerStr.match(/content-length:\s*(\d+)/i);
        if (clMatch) {
          expectedLength = headerEnd + parseInt(clMatch[1], 10);
        } else if (/transfer-encoding:\s*chunked/i.test(headerStr)) {
          isChunked = true;
        } else {
          // No Content-Length and not chunked: read until close
          expectedLength = -1;
        }
      }

      if (expectedLength > 0 && combined.length >= expectedLength) {
        cleanup();
        resolve(combined.subarray(0, expectedLength));
      } else if (isChunked) {
        // Check for terminating chunk: 0\r\n\r\n
        if (
          combined.length >= 5 &&
          combined.subarray(combined.length - 5).toString("ascii") ===
            "0\r\n\r\n"
        ) {
          cleanup();
          resolve(combined);
        }
      }
    };

    const onEnd = () => {
      cleanup();
      resolve(Buffer.concat(chunks));
    };

    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };

    const cleanup = () => {
      socket.removeListener("data", onData);
      socket.removeListener("end", onEnd);
      socket.removeListener("error", onError);
    };

    socket.on("data", onData);
    socket.once("end", onEnd);
    socket.once("error", onError);

    // Safety timeout: 30 seconds for upstream response
    socket.setTimeout(30_000, () => {
      cleanup();
      reject(new Error("Upstream response timeout"));
    });
  });
}

function parseRequestLine(request: Buffer): {
  method: string;
  path: string;
} {
  const firstLine = request
    .subarray(0, request.indexOf(0x0a))
    .toString("ascii")
    .trim();
  const parts = firstLine.split(" ");
  return {
    method: parts[0] ?? "UNKNOWN",
    path: parts[1] ?? "/",
  };
}

function parseResponseStatus(response: Buffer): number {
  const firstLine = response
    .subarray(0, response.indexOf(0x0a))
    .toString("ascii")
    .trim();
  // "HTTP/1.1 200 OK"
  const parts = firstLine.split(" ");
  const code = parseInt(parts[1] ?? "0", 10);
  return Number.isNaN(code) ? 0 : code;
}

function buildErrorResponse(status: number, message: string): Buffer {
  const body = JSON.stringify({ error: message });
  const response = [
    `HTTP/1.1 ${status} ${statusText(status)}`,
    "Content-Type: application/json",
    `Content-Length: ${Buffer.byteLength(body)}`,
    "Connection: close",
    "",
    body,
  ].join("\r\n");
  return Buffer.from(response);
}

function statusText(status: number): string {
  switch (status) {
    case 502:
      return "Bad Gateway";
    case 503:
      return "Service Unavailable";
    default:
      return "Error";
  }
}
