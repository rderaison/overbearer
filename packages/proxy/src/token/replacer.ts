import crypto from "node:crypto";
import { lookupFakeToken } from "./memcached.js";

export interface TokenResult {
  type: "fake" | "real_direct" | "none";
  tokenId?: string;
  tokenPreview?: string;
  tokenFull?: string;
}

interface ReplaceResult {
  modifiedRequest: Buffer;
  result: TokenResult;
}

// Precompiled patterns for fast header matching
const AUTHORIZATION_RE = /^authorization:\s*bearer\s+(\S+)/im;
const X_API_KEY_RE = /^x-api-key:\s*(\S+)/im;

function preview(token: string): string {
  if (token.length <= 10) return token.substring(0, 2) + "..." + token.substring(token.length - 2);
  return token.substring(0, 5) + "..." + token.substring(token.length - 4);
}

/**
 * Parse the raw HTTP request, find Authorization: Bearer or x-api-key headers,
 * hash the token, look it up in memcached, and replace if it is a fake token.
 * Any token not in memcached is treated as a real token used directly.
 */
export async function replaceToken(
  rawRequest: Buffer,
): Promise<ReplaceResult> {
  const headerEndIdx = rawRequest.indexOf("\r\n\r\n");
  if (headerEndIdx === -1) {
    return { modifiedRequest: rawRequest, result: { type: "none" } };
  }

  const headerSection = rawRequest.subarray(0, headerEndIdx).toString("ascii");

  let match = AUTHORIZATION_RE.exec(headerSection);
  let headerName: "authorization" | "x-api-key" = "authorization";

  if (!match) {
    match = X_API_KEY_RE.exec(headerSection);
    headerName = "x-api-key";
  }

  if (!match) {
    return { modifiedRequest: rawRequest, result: { type: "none" } };
  }

  const token = match[1]!;
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const tokenPrev = preview(token);

  // Check if it is a fake token with a real token mapping
  const realToken = await lookupFakeToken(tokenHash);
  if (realToken) {
    const modified = replaceTokenInBuffer(
      rawRequest,
      headerSection,
      headerName,
      token,
      realToken,
    );
    return {
      modifiedRequest: modified,
      result: { type: "fake", tokenId: tokenHash.substring(0, 16), tokenPreview: tokenPrev, tokenFull: token },
    };
  }

  // Not a fake token — it's a real token being used directly
  return {
    modifiedRequest: rawRequest,
    result: { type: "real_direct", tokenId: tokenHash.substring(0, 16), tokenPreview: tokenPrev, tokenFull: token },
  };
}

function replaceTokenInBuffer(
  rawRequest: Buffer,
  headerSection: string,
  headerName: "authorization" | "x-api-key",
  oldToken: string,
  newToken: string,
): Buffer {
  const headerEndIdx = rawRequest.indexOf("\r\n\r\n");
  const body = rawRequest.subarray(headerEndIdx);

  let newHeaderSection: string;
  if (headerName === "authorization") {
    newHeaderSection = headerSection.replace(
      AUTHORIZATION_RE,
      (fullMatch) => fullMatch.replace(oldToken, newToken),
    );
  } else {
    newHeaderSection = headerSection.replace(
      X_API_KEY_RE,
      (fullMatch) => fullMatch.replace(oldToken, newToken),
    );
  }

  const newHeaders = Buffer.from(newHeaderSection, "ascii");
  return Buffer.concat([newHeaders, body]);
}
