/**
 * seed-and-screenshot.ts
 *
 * 1. Seeds PostgreSQL with synthetic users, tokens, groups, requests, ACLs
 * 2. Seeds ClickHouse with proxy log entries
 * 3. Takes screenshots of every UI view per role using Puppeteer
 *
 * Prerequisites:
 *   kubectl port-forward svc/postgres  15432:5432 -n overbearer
 *   kubectl port-forward svc/clickhouse 18123:8123 -n overbearer
 *
 * Run:
 *   npx tsx e2e/seed-and-screenshot.ts
 */

import pg from 'pg';
import { createClient } from '@clickhouse/client';
import { SignJWT } from 'jose';
import {
  createCipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import puppeteer, { type Browser, type Page } from 'puppeteer';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const MGMT_URL =
  process.env.OVERBEARER_URL || 'https://10.163.15.33';

const PG_CONFIG = {
  host: '127.0.0.1',
  port: 15432,
  database: 'overbearer',
  user: 'overbearer',
  password: '049df76f0454115f42edec4ab6a45f43',
};

const CH_URL = 'http://127.0.0.1:18123';
const CH_DB = 'overbearer';

const JWT_SECRET = '13f9b5498120497b76e52a84d2ff5b6883cd0fe708d265469d70a8c79d7830f6';
const MASTER_KEY = '0cc6da08945ac5e23bcc01770ce3183858ac0dbf7e25ed24973ac800fdd7b889';

const DOCS_DIR = `${process.cwd()}/docs`;

// ---------------------------------------------------------------------------
// Crypto helpers (mirroring packages/api/src/services/encryption.ts)
// ---------------------------------------------------------------------------

function encrypt(plaintext: string): Buffer {
  const key = Buffer.from(MASTER_KEY, 'hex');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]);
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function generateFakeToken(realToken: string): string {
  const random = randomBytes(32).toString('hex');
  const delimiters = ['-', '_'];
  let prefixEnd = -1;
  const maxPrefixLen = Math.min(realToken.length, 40);
  for (let i = 0; i < maxPrefixLen; i++) {
    if (delimiters.includes(realToken[i])) prefixEnd = i;
  }
  if (prefixEnd > 0 && prefixEnd < maxPrefixLen) {
    return `${realToken.substring(0, prefixEnd + 1)}ovb-${random}`;
  }
  return `ovb_${random}`;
}

// ---------------------------------------------------------------------------
// JWT helper
// ---------------------------------------------------------------------------

async function createJWT(
  userId: string,
  role: string,
): Promise<string> {
  const secret = new TextEncoder().encode(JWT_SECRET);
  return new SignJWT({ userId, role })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('8h')
    .setIssuer('overbearer')
    .sign(secret);
}

// ---------------------------------------------------------------------------
// Data definitions
// ---------------------------------------------------------------------------

interface SyntheticUser {
  id: string;
  username: string;
  displayName: string;
  role: 'admin' | 'manager' | 'viewer' | 'requester';
}

const USERS: SyntheticUser[] = [
  // We keep the existing admin (f6193877-...) and add more
  {
    id: randomUUID(),
    username: 'bob.ops',
    displayName: 'Bob Operations',
    role: 'admin',
  },
  {
    id: randomUUID(),
    username: 'charlie.mgr',
    displayName: 'Charlie Manager',
    role: 'manager',
  },
  {
    id: randomUUID(),
    username: 'diana.mgr',
    displayName: 'Diana Manager',
    role: 'manager',
  },
  {
    id: randomUUID(),
    username: 'eve.mgr',
    displayName: 'Eve Manager',
    role: 'manager',
  },
  {
    id: randomUUID(),
    username: 'frank.analyst',
    displayName: 'Frank Analyst',
    role: 'viewer',
  },
  {
    id: randomUUID(),
    username: 'grace.auditor',
    displayName: 'Grace Auditor',
    role: 'viewer',
  },
  {
    id: randomUUID(),
    username: 'hank.observer',
    displayName: 'Hank Observer',
    role: 'viewer',
  },
  {
    id: randomUUID(),
    username: 'ivan.dev',
    displayName: 'Ivan Developer',
    role: 'requester',
  },
  {
    id: randomUUID(),
    username: 'julia.eng',
    displayName: 'Julia Engineer',
    role: 'requester',
  },
  {
    id: randomUUID(),
    username: 'karl.intern',
    displayName: 'Karl Intern',
    role: 'requester',
  },
  {
    id: randomUUID(),
    username: 'luna.contractor',
    displayName: 'Luna Contractor',
    role: 'requester',
  },
];

interface SyntheticToken {
  id: string;
  name: string;
  provider: string;
  realToken: string;
  revoked: boolean;
  // index into USERS for created_by (or -1 for existing admin)
  creatorIdx: number;
}

const TOKENS: SyntheticToken[] = [
  {
    id: randomUUID(),
    name: 'Anthropic Production',
    provider: 'anthropic',
    realToken: 'sk-ant-api03-prod-real-key-abc123def456',
    revoked: false,
    creatorIdx: -1, // existing admin
  },
  {
    id: randomUUID(),
    name: 'Anthropic Staging',
    provider: 'anthropic',
    realToken: 'sk-ant-api03-staging-key-789ghi012jkl',
    revoked: false,
    creatorIdx: 0, // charlie.mgr (index 2 in USERS but we use logical idx)
  },
  {
    id: randomUUID(),
    name: 'OpenAI GPT-4',
    provider: 'openai',
    realToken: 'sk-proj-gpt4-production-key-mno345pqr678',
    revoked: false,
    creatorIdx: -1,
  },
  {
    id: randomUUID(),
    name: 'OpenAI Embeddings',
    provider: 'openai',
    realToken: 'sk-proj-embed-key-stu901vwx234',
    revoked: false,
    creatorIdx: 1, // diana.mgr
  },
  {
    id: randomUUID(),
    name: 'Cohere Generate',
    provider: 'cohere',
    realToken: 'co-generate-prod-key-yza567bcd890',
    revoked: false,
    creatorIdx: 0,
  },
  {
    id: randomUUID(),
    name: 'AWS Bedrock',
    provider: 'aws',
    realToken: 'AKIA-bedrock-secret-key-efg123hij456',
    revoked: false,
    creatorIdx: -1,
  },
  {
    id: randomUUID(),
    name: 'Google Vertex AI',
    provider: 'google',
    realToken: 'AIzaSy-vertex-key-klm789nop012',
    revoked: true,
    creatorIdx: 1,
  },
  {
    id: randomUUID(),
    name: 'Mistral API',
    provider: 'mistral',
    realToken: 'mistral-api-key-qrs345tuv678',
    revoked: false,
    creatorIdx: 2, // eve.mgr
  },
  {
    id: randomUUID(),
    name: 'Hugging Face Inference',
    provider: 'huggingface',
    realToken: 'hf_inference-key-wxy901zab234',
    revoked: true,
    creatorIdx: 0,
  },
  {
    id: randomUUID(),
    name: 'Stripe Payments',
    provider: 'stripe',
    realToken: 'sk_live-stripe-payment-key-cde567fgh890',
    revoked: false,
    creatorIdx: -1,
  },
  {
    id: randomUUID(),
    name: 'Datadog Monitoring',
    provider: 'datadog',
    realToken: 'dd-api-key-ijk123lmn456opq789',
    revoked: false,
    creatorIdx: 2,
  },
];

const GROUPS = [
  {
    id: randomUUID(),
    name: 'Platform Engineering',
    description: 'Core platform team responsible for infrastructure',
  },
  {
    id: randomUUID(),
    name: 'AI Research',
    description: 'Machine learning and AI research team',
  },
  {
    id: randomUUID(),
    name: 'Security Team',
    description: 'Security operations and compliance',
  },
  {
    id: randomUUID(),
    name: 'DevOps',
    description: 'CI/CD and deployment automation',
  },
];

// ---------------------------------------------------------------------------
// SEED: PostgreSQL
// ---------------------------------------------------------------------------

async function seedPostgres(): Promise<{
  adminId: string;
  managerIds: string[];
  viewerIds: string[];
  requesterIds: string[];
}> {
  const pool = new pg.Pool(PG_CONFIG);

  try {
    console.log('  Seeding PostgreSQL...');

    // Get existing admin
    const existingAdmin = await pool.query(
      "SELECT id FROM users WHERE role = 'admin' LIMIT 1",
    );
    const adminId = existingAdmin.rows[0]?.id;
    if (!adminId) throw new Error('No existing admin user found');

    // Insert users
    for (const u of USERS) {
      await pool.query(
        `INSERT INTO users (id, username, display_name, role)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (username) DO UPDATE SET display_name = $3, role = $4
         RETURNING id`,
        [u.id, u.username, u.displayName, u.role],
      ).then(r => { u.id = r.rows[0].id; });
    }
    console.log(`    ${USERS.length} users inserted`);

    // Insert fake passkey credentials for all users (suppresses "no passkey" banner)
    const allUserIds = [adminId, ...USERS.map((u) => u.id)];
    for (const uid of allUserIds) {
      const credId = randomBytes(32).toString('base64url');
      const pubKey = randomBytes(65); // fake EC public key bytes
      await pool.query(
        `INSERT INTO passkey_credentials (user_id, credential_id, public_key, counter, transports)
         VALUES ($1, $2, $3, 0, ARRAY['internal'])
         ON CONFLICT (credential_id) DO NOTHING`,
        [uid, credId, pubKey],
      );
    }
    console.log(`    ${allUserIds.length} passkey credentials inserted`);

    // Helper to resolve creator
    const managerUsers = USERS.filter((u) => u.role === 'manager');
    function getCreator(idx: number): string {
      if (idx < 0) return adminId;
      return managerUsers[idx % managerUsers.length].id;
    }

    // Insert tokens
    for (const t of TOKENS) {
      const fakeToken = generateFakeToken(t.realToken);
      const fakeHash = hashToken(fakeToken);
      const realHash = hashToken(t.realToken);
      const encryptedReal = encrypt(t.realToken);
      const createdBy = getCreator(t.creatorIdx);

      await pool.query(
        `INSERT INTO token_mappings (id, name, provider, fake_token_hash, fake_token_value, real_token_encrypted, real_token_hash, created_by, revoked, revoked_at, created_at, last_used_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                 NOW() - interval '1 day' * (random() * 30)::int,
                 CASE WHEN $9 THEN NULL ELSE NOW() - interval '1 hour' * (random() * 48)::int END)
         ON CONFLICT (fake_token_hash) DO NOTHING`,
        [
          t.id,
          t.name,
          t.provider,
          fakeHash,
          fakeToken,
          encryptedReal,
          realHash,
          createdBy,
          t.revoked,
          t.revoked ? new Date() : null,
        ],
      );
    }
    console.log(`    ${TOKENS.length} tokens inserted`);

    // Insert groups
    for (const g of GROUPS) {
      await pool.query(
        `INSERT INTO groups (id, name, description, created_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (name) DO UPDATE SET description = $3 RETURNING id`,
        [g.id, g.name, g.description, adminId],
      ).then(r => { g.id = r.rows[0].id; });
    }
    console.log(`    ${GROUPS.length} groups inserted`);

    // Group memberships
    const memberships: [number, number][] = [
      // [groupIdx, userIdx in USERS]
      // Platform Engineering: charlie.mgr, frank.analyst, ivan.dev, julia.eng
      [0, 0],
      [0, 3],
      [0, 5],
      [0, 6],
      // AI Research: diana.mgr, grace.auditor, karl.intern
      [1, 1],
      [1, 4],
      [1, 7],
      // Security Team: eve.mgr, hank.observer
      [2, 2],
      [2, 5],
      // DevOps: charlie.mgr, frank.analyst, ivan.dev
      [3, 0],
      [3, 3],
      [3, 5],
    ];

    for (const [gi, ui] of memberships) {
      await pool.query(
        `INSERT INTO group_members (group_id, user_id, added_by)
         VALUES ($1, $2, $3)
         ON CONFLICT (group_id, user_id) DO NOTHING`,
        [GROUPS[gi].id, USERS[ui].id, adminId],
      );
    }
    console.log(`    ${memberships.length} group memberships inserted`);

    // Token access grants (user-level)
    const userAccess: [number, number][] = [
      // [tokenIdx, userIdx]
      [0, 3], // Anthropic Prod → frank.analyst
      [2, 4], // OpenAI GPT-4 → grace.auditor
      [5, 3], // AWS Bedrock → frank.analyst
      [9, 5], // Stripe → hank.observer
    ];

    for (const [ti, ui] of userAccess) {
      await pool.query(
        `INSERT INTO token_access (user_id, token_id, granted_by)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, token_id) DO NOTHING`,
        [USERS[ui].id, TOKENS[ti].id, adminId],
      );
    }
    console.log(`    ${userAccess.length} user token access grants`);

    // Token access grants (group-level)
    const groupAccess: [number, number][] = [
      // [groupIdx, tokenIdx]
      [0, 0], // Platform Eng → Anthropic Prod
      [0, 1], // Platform Eng → Anthropic Staging
      [0, 4], // Platform Eng → Cohere
      [1, 2], // AI Research → OpenAI GPT-4
      [1, 3], // AI Research → OpenAI Embeddings
      [1, 7], // AI Research → Mistral
      [2, 5], // Security → AWS Bedrock
      [2, 9], // Security → Stripe
      [2, 10], // Security → Datadog
      [3, 0], // DevOps → Anthropic Prod
      [3, 5], // DevOps → AWS Bedrock
    ];

    for (const [gi, ti] of groupAccess) {
      await pool.query(
        `INSERT INTO token_group_access (group_id, token_id, granted_by)
         VALUES ($1, $2, $3)
         ON CONFLICT (group_id, token_id) DO NOTHING`,
        [GROUPS[gi].id, TOKENS[ti].id, adminId],
      );
    }
    console.log(`    ${groupAccess.length} group token access grants`);

    // Token requests
    const requests = [
      {
        userId: USERS[5].id, // ivan.dev
        provider: 'anthropic',
        reason: 'Need access for the new chatbot feature',
        status: 'pending',
      },
      {
        userId: USERS[6].id, // julia.eng
        provider: 'openai',
        reason: 'Building embeddings pipeline for search',
        status: 'pending',
      },
      {
        userId: USERS[7].id, // karl.intern
        provider: 'cohere',
        reason: 'Research project on text classification',
        status: 'pending',
      },
      {
        userId: USERS[5].id, // ivan.dev
        provider: 'aws',
        reason: 'CI/CD pipeline needs Bedrock access',
        status: 'approved',
        approvedBy: adminId,
        tokenId: TOKENS[5].id,
      },
      {
        userId: USERS[6].id, // julia.eng
        provider: 'mistral',
        reason: 'Testing Mistral models for summarization',
        status: 'approved',
        approvedBy: managerUsers[2].id,
        tokenId: TOKENS[7].id,
      },
      {
        userId: USERS[8].id, // luna.contractor
        provider: 'stripe',
        reason: 'Payment integration testing',
        status: 'approved',
        approvedBy: adminId,
        tokenId: TOKENS[9].id,
      },
      {
        userId: USERS[7].id, // karl.intern
        provider: 'stripe',
        reason: 'Want to test payment flow',
        status: 'denied',
        approvedBy: adminId,
      },
      {
        userId: USERS[8].id, // luna.contractor
        provider: 'anthropic',
        reason: 'Building demo for client presentation',
        status: 'denied',
        approvedBy: managerUsers[0].id,
      },
    ];

    for (const r of requests) {
      await pool.query(
        `INSERT INTO token_requests (user_id, provider, reason, status, approved_by, token_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW() - interval '1 hour' * (random() * 72)::int)
         ON CONFLICT DO NOTHING`,
        [
          r.userId,
          r.provider,
          r.reason,
          r.status,
          (r as any).approvedBy ?? null,
          (r as any).tokenId ?? null,
        ],
      );
    }
    console.log(`    ${requests.length} token requests inserted`);

    // Proxy ACLs
    const acls = [
      {
        pattern: 'production/*',
        desc: 'Allow all production services',
      },
      {
        pattern: 'staging/*',
        desc: 'Allow staging environment services',
      },
      {
        pattern: 'research/ai-*',
        desc: 'Allow AI research workloads',
      },
    ];

    for (const a of acls) {
      await pool.query(
        `INSERT INTO proxy_acls (service_pattern, description, created_by)
         VALUES ($1, $2, $3)`,
        [a.pattern, a.desc, adminId],
      );
    }
    console.log(`    ${acls.length} proxy ACLs inserted`);

    // Invite tokens (for a couple of users)
    for (const u of USERS.slice(0, 3)) {
      const token = randomBytes(32).toString('hex');
      await pool.query(
        `INSERT INTO invite_tokens (user_id, token, used, expires_at)
         VALUES ($1, $2, true, NOW() + interval '7 days')
         ON CONFLICT DO NOTHING`,
        [u.id, token],
      );
    }
    console.log('    Invite tokens inserted');

    const managerIds = USERS.filter((u) => u.role === 'manager').map(
      (u) => u.id,
    );
    const viewerIds = USERS.filter((u) => u.role === 'viewer').map(
      (u) => u.id,
    );
    const requesterIds = USERS.filter((u) => u.role === 'requester').map(
      (u) => u.id,
    );

    return { adminId, managerIds, viewerIds, requesterIds };
  } finally {
    await pool.end();
  }
}

// ---------------------------------------------------------------------------
// SEED: ClickHouse
// ---------------------------------------------------------------------------

async function seedClickHouse(): Promise<void> {
  console.log('  Seeding ClickHouse...');

  const ch = createClient({ url: CH_URL, database: CH_DB });

  const serviceNames = [
    'payment-svc',
    'ai-gateway',
    'research-worker',
    'staging-api',
    'chatbot-backend',
    'embed-pipeline',
    'auth-proxy',
    'data-ingestion',
    'notification-svc',
    'analytics-engine',
    'ml-trainer',
    'api-gateway',
  ];

  const targetHosts = [
    'api.anthropic.com',
    'api.openai.com',
    'api.cohere.ai',
    'bedrock-runtime.us-east-1.amazonaws.com',
    'us-central1-aiplatform.googleapis.com',
    'api.mistral.ai',
    'api-inference.huggingface.co',
    'api.stripe.com',
    'api.datadoghq.com',
  ];

  const methods = ['GET', 'POST', 'POST', 'POST', 'PUT', 'DELETE'];
  const paths = [
    '/v1/messages',
    '/v1/chat/completions',
    '/v1/generate',
    '/v1/embeddings',
    '/v2/predict',
    '/v1/completions',
    '/v1/charges',
    '/v1/series',
    '/v1/models',
    '/v1/tokenize',
  ];

  const tokenTypes = ['fake', 'fake', 'fake', 'fake', 'real_direct', 'unknown', 'acl_denied'] as const;
  const statusCodes = [200, 200, 200, 200, 201, 400, 401, 403, 429, 500];

  // Compute token_id values (first 16 chars of fake_token_hash) for active tokens
  const activeTokenIds = TOKENS.filter((t) => !t.revoked).map((t) =>
    hashToken(generateFakeToken(t.realToken)).substring(0, 16),
  );

  // Also create some fake "real_direct" token previews for the Services view
  const realDirectPreviews = [
    'sk-ant-api03-Xx...9k',
    'sk-proj-Ab...7z',
    'AKIA-Cd...3m',
    'hf_Ef...2n',
  ];

  // Encrypt token previews for storage
  function encryptPreview(preview: string): string {
    const buf = encrypt(preview);
    return buf.toString('base64');
  }

  // Generate 300 log entries spread over last 48 hours
  const rows: Record<string, unknown>[] = [];
  const now = Date.now();

  for (let i = 0; i < 300; i++) {
    const ageMs = Math.random() * 48 * 60 * 60 * 1000;
    const ts = new Date(now - ageMs);
    const tokenType = tokenTypes[Math.floor(Math.random() * tokenTypes.length)];
    const service = serviceNames[Math.floor(Math.random() * serviceNames.length)];
    const host = targetHosts[Math.floor(Math.random() * targetHosts.length)];
    const method = methods[Math.floor(Math.random() * methods.length)];
    const path = paths[Math.floor(Math.random() * paths.length)];
    const status = statusCodes[Math.floor(Math.random() * statusCodes.length)];
    const latency = Math.random() * 2000 + 10;

    let tokenId = '';
    let tokenPreview = '';
    let tokenEncrypted = '';

    if (tokenType === 'fake') {
      tokenId =
        activeTokenIds[Math.floor(Math.random() * activeTokenIds.length)] ?? '';
      tokenPreview = '';
    } else if (tokenType === 'real_direct') {
      const preview = realDirectPreviews[Math.floor(Math.random() * realDirectPreviews.length)];
      tokenId = hashToken(preview).substring(0, 16);
      tokenPreview = encryptPreview(preview);
      tokenEncrypted = encryptPreview(
        `sk-real-full-token-${randomBytes(16).toString('hex')}`,
      );
    }

    const serviceIp = `10.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;

    rows.push({
      timestamp: ts.toISOString().replace('T', ' ').replace('Z', ''),
      service_name: service,
      service_ip: serviceIp,
      target_host: host,
      target_path: path,
      method,
      token_type: tokenType,
      token_id: tokenId,
      token_preview: tokenPreview,
      token_encrypted: tokenEncrypted,
      response_status: status,
      latency_ms: Math.round(latency * 100) / 100,
    });
  }

  await ch.insert({
    table: 'proxy_logs',
    values: rows,
    format: 'JSONEachRow',
  });

  console.log(`    ${rows.length} log entries inserted`);
  await ch.close();
}

// ---------------------------------------------------------------------------
// SCREENSHOTS
// ---------------------------------------------------------------------------

// Pages per role (matching Layout.tsx nav visibility)
const ROLE_PAGES: Record<
  string,
  { path: string; name: string; waitFor?: string }[]
> = {
  admin: [
    { path: '/', name: 'dashboard' },
    { path: '/tokens', name: 'tokens' },
    { path: '/token-requests', name: 'token-requests' },
    { path: '/logs', name: 'logs' },
    { path: '/services', name: 'services' },
    { path: '/new-activity', name: 'new-activity' },
    { path: '/users', name: 'users' },
    { path: '/groups', name: 'groups' },
    { path: '/settings', name: 'settings' },
  ],
  manager: [
    { path: '/', name: 'dashboard' },
    { path: '/tokens', name: 'tokens' },
    { path: '/token-requests', name: 'token-requests' },
  ],
  viewer: [
    { path: '/', name: 'dashboard' },
    { path: '/logs', name: 'logs' },
    { path: '/services', name: 'services' },
    { path: '/new-activity', name: 'new-activity' },
  ],
  requester: [
    { path: '/', name: 'dashboard' },
    { path: '/token-requests', name: 'token-requests' },
  ],
};

async function takeScreenshots(usersByRole: Record<string, string>): Promise<void> {
  console.log('  Taking screenshots...');

  await mkdir(`${DOCS_DIR}/screenshots`, { recursive: true });

  const browser = await puppeteer.launch({
    headless: true,
    executablePath:
      process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium-browser',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--ignore-certificate-errors',
    ],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
  page.setDefaultTimeout(15_000);

  const url = new URL(MGMT_URL);

  // Take login page screenshot first (unauthenticated)
  // Clear cookies first
  await page.deleteCookie(
    ...(await page.cookies()),
  );
  await page.goto(`${MGMT_URL}/login`, { waitUntil: 'networkidle2' });
  await delay(1000);
  await page.screenshot({
    path: `${DOCS_DIR}/screenshots/login.png`,
    fullPage: true,
  });
  console.log('    login.png');

  // For each role, set the JWT cookie and screenshot all visible pages
  for (const [role, userId] of Object.entries(usersByRole)) {
    const jwt = await createJWT(userId, role);

    // Set the session cookie
    await page.deleteCookie(
      ...(await page.cookies()),
    );
    await page.setCookie({
      name: 'overbearer_session',
      value: jwt,
      domain: url.hostname,
      path: '/',
      httpOnly: true,
      secure: url.protocol === 'https:',
    });

    const pages = ROLE_PAGES[role] ?? [];

    for (const { path, name } of pages) {
      try {
        await page.goto(`${MGMT_URL}${path}`, {
          waitUntil: 'networkidle2',
        });
        // Wait for content to render
        await delay(2000);

        const filename = `${role}-${name}.png`;
        await page.screenshot({
          path: `${DOCS_DIR}/screenshots/${filename}`,
          fullPage: true,
        });
        console.log(`    ${filename}`);
      } catch (err) {
        console.error(
          `    FAILED: ${role}-${name}: ${(err as Error).message}`,
        );
      }
    }
  }

  await browser.close();
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('=== Overbearer Seed & Screenshot ===\n');

  // 1. Seed data
  console.log('[1/3] Seeding databases...');
  const { adminId, managerIds, viewerIds, requesterIds } =
    await seedPostgres();
  await seedClickHouse();

  // 2. Pick one user per role for screenshots
  const usersByRole: Record<string, string> = {
    admin: adminId,
    manager: managerIds[0],
    viewer: viewerIds[0],
    requester: requesterIds[0],
  };

  console.log('\n[2/3] Users for screenshots:');
  for (const [role, id] of Object.entries(usersByRole)) {
    console.log(`  ${role}: ${id}`);
  }

  // 3. Screenshots
  console.log('\n[3/3] Capturing screenshots...');
  await takeScreenshots(usersByRole);

  console.log('\nDone! Screenshots saved to docs/screenshots/');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
