import pg from "pg";

interface AclRule {
  id: number;
  service_pattern: string;
  description: string;
}

let pool: pg.Pool | undefined;
let rules: AclRule[] = [];
let pollInterval: ReturnType<typeof setInterval> | undefined;

/**
 * Parse an IPv4 address string into a 32-bit unsigned integer.
 * Returns null for non-IPv4 or invalid addresses.
 */
function parseIPv4(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;

  let result = 0;
  for (const part of parts) {
    const num = parseInt(part, 10);
    if (isNaN(num) || num < 0 || num > 255 || part !== String(num)) return null;
    result = (result << 8) | num;
  }
  // Convert to unsigned 32-bit integer
  return result >>> 0;
}

/**
 * Check if an IPv4 address falls within a CIDR range.
 * Returns false for IPv6, invalid input, or non-IPv4 addresses.
 */
function ipInCidr(ip: string, cidr: string): boolean {
  const slashIdx = cidr.indexOf("/");
  if (slashIdx === -1) return false;

  const baseIp = cidr.substring(0, slashIdx);
  const prefixLen = parseInt(cidr.substring(slashIdx + 1), 10);

  if (isNaN(prefixLen) || prefixLen < 0 || prefixLen > 32) return false;

  const ipNum = parseIPv4(ip);
  const baseNum = parseIPv4(baseIp);

  if (ipNum === null || baseNum === null) return false;

  if (prefixLen === 0) return true;

  // Create mask: prefixLen leading 1s, rest 0s
  const mask = (~0 << (32 - prefixLen)) >>> 0;
  return ((ipNum & mask) >>> 0) === ((baseNum & mask) >>> 0);
}

/**
 * Check if a CIDR-like pattern looks like an IP range (e.g., 10.0.0.0/16).
 */
function isCidrPattern(pattern: string): boolean {
  const slashIdx = pattern.indexOf("/");
  if (slashIdx === -1) return false;

  const ipPart = pattern.substring(0, slashIdx);
  const prefixPart = pattern.substring(slashIdx + 1);

  // Must have a valid prefix length
  const prefixLen = parseInt(prefixPart, 10);
  if (isNaN(prefixLen) || prefixLen < 0 || prefixLen > 32 || prefixPart !== String(prefixLen)) {
    return false;
  }

  // Must look like an IPv4 address
  return parseIPv4(ipPart) !== null;
}

/**
 * Convert a glob pattern to a RegExp.
 * Escapes regex special chars, replaces `*` with `.*`, wraps in `^...$`.
 */
function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  const withWildcards = escaped.replace(/\*/g, ".*");
  return new RegExp(`^${withWildcards}$`);
}

/**
 * Load ACL rules from PostgreSQL.
 */
async function loadRules(): Promise<void> {
  if (!pool) return;

  try {
    const result = await pool.query<AclRule>(
      "SELECT id, service_pattern, description FROM proxy_acls",
    );
    rules = result.rows;
    console.log(`[acl] loaded ${rules.length} source ACL rules`);
  } catch (err) {
    console.error(
      "[acl] failed to load ACL rules:",
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Initialize source ACLs by connecting to PostgreSQL, loading rules,
 * and setting up a polling interval to reload every 30 seconds.
 */
export async function initSourceAcls(): Promise<void> {
  pool = new pg.Pool({
    host: process.env.PGHOST || "localhost",
    port: parseInt(process.env.PGPORT || "5432"),
    database: process.env.PGDATABASE || "overbearer",
    user: process.env.PGUSER || "overbearer",
    password: process.env.PGPASSWORD || "overbearer",
    max: 1,
    connectionTimeoutMillis: 5000,
  });

  await loadRules();

  pollInterval = setInterval(() => {
    void loadRules();
  }, 30_000);
  pollInterval.unref();
}

/**
 * Check if a service is allowed to use the proxy.
 *
 * - If no ACL rules exist (empty list), returns true (open mode).
 * - If rules exist, checks if serviceName or serviceIp matches any service_pattern.
 * - Supports glob-style wildcards and CIDR notation for IP ranges.
 */
export function isServiceAllowed(serviceName: string, serviceIp: string): boolean {
  // Open mode: no rules means everything is allowed
  if (rules.length === 0) return true;

  for (const rule of rules) {
    const pattern = rule.service_pattern;

    // CIDR matching for IP ranges
    if (isCidrPattern(pattern)) {
      if (ipInCidr(serviceIp, pattern)) return true;
      continue;
    }

    // Glob matching against both serviceName and serviceIp
    const regex = globToRegex(pattern);
    if (regex.test(serviceName) || regex.test(serviceIp)) return true;
  }

  return false;
}

/**
 * Shut down source ACLs: clear the polling interval and release the pool.
 */
export async function shutdownSourceAcls(): Promise<void> {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = undefined;
  }

  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
