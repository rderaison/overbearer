import puppeteer, { type Browser, type Page } from 'puppeteer';

const BASE = process.env.OVERBEARER_URL || 'https://localhost';
let browser: Browser;
let page: Page;
let passed = 0;
let failed = 0;
const errors: string[] = [];

async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err: any) {
    console.log(`  ✗ ${name}: ${err.message}`);
    errors.push(`${name}: ${err.message}`);
    failed++;
  }
}

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(msg);
}

async function main() {
  browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium-browser',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--ignore-certificate-errors'],
  });
  page = await browser.newPage();
  page.setDefaultTimeout(10_000);

  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));

  console.log('=========================================');
  console.log('  OVERBEARER UI WALKTHROUGH');
  console.log('=========================================\n');

  // -----------------------------------------------------------------------
  // 1. Setup flow
  // -----------------------------------------------------------------------
  console.log('--- Setup Flow ---');

  const setupStatus = await page.evaluate(async (base) => {
    const r = await fetch(`${base}/api/auth/setup-status`);
    return r.json();
  }, BASE);

  if (setupStatus.needsSetup) {
    await check('Setup status is true', async () => {
      assert(setupStatus.needsSetup === true, `needsSetup=${setupStatus.needsSetup}`);
    });

    await check('Load page shows setup screen', async () => {
      await page.goto(BASE, { waitUntil: 'networkidle2' });
      await page.waitForSelector('#setup-username', { timeout: 5000 });
    });

    await check('Create admin account', async () => {
      await page.type('#setup-username', 'admin');
      await page.type('#setup-display', 'Test Admin');

      await Promise.all([
        page.click('button[type="submit"]'),
        page.waitForFunction(
          () => document.querySelector('h1')?.textContent === 'Dashboard',
          { timeout: 10000 },
        ),
      ]);
    });

    await check('Session cookie was set', async () => {
      const cookies = await page.cookies();
      const session = cookies.find((c) => c.name === 'overbearer_session');
      assert(session !== undefined, `No session cookie. Cookies: ${cookies.map((c) => c.name).join(', ')}`);
    });
  } else {
    console.log('  (setup already completed, injecting session cookie)');
    const sessionToken = process.env.OVERBEARER_SESSION;
    assert(!!sessionToken, 'OVERBEARER_SESSION env var required when setup already completed');

    const url = new URL(BASE);
    await page.setCookie({
      name: 'overbearer_session',
      value: sessionToken!,
      domain: url.hostname,
      path: '/',
      httpOnly: true,
    });

    await page.goto(BASE, { waitUntil: 'networkidle2' });
  }

  await check('Auth me works with cookie', async () => {
    const res = await page.evaluate(async (base) => {
      const r = await fetch(`${base}/api/auth/me`, { credentials: 'include' });
      return { status: r.status, body: await r.text() };
    }, BASE);
    assert(res.status === 200, `Expected 200, got ${res.status}: ${res.body}`);
  });

  await check('No JS page errors', async () => {
    assert(pageErrors.length === 0, pageErrors.join('; '));
  });

  await check('Passkey banner is visible', async () => {
    await page.goto(BASE, { waitUntil: 'networkidle2' });
    const text = await page.evaluate(() => document.body.innerText);
    assert(text.includes('passkey') || text.includes('Passkey'), 'Expected passkey banner to be visible');
  });

  // -----------------------------------------------------------------------
  // 2. Visit every page
  // -----------------------------------------------------------------------
  console.log('\n--- Page Navigation ---');

  const pages = [
    { path: '/', name: 'Dashboard', expect: 'Dashboard' },
    { path: '/tokens', name: 'Tokens', expect: 'Tokens' },
    { path: '/token-requests', name: 'Token Requests', expect: 'Token Request' },
    { path: '/logs', name: 'Logs', expect: 'Log' },
    { path: '/services', name: 'Services', expect: 'Service' },
    { path: '/users', name: 'Users', expect: 'User' },
    { path: '/settings', name: 'Settings', expect: 'Settings' },
    { path: '/new-activity', name: 'New Activity', expect: 'New Activity' },
    { path: '/groups', name: 'Groups', expect: 'Group' },
  ];

  for (const { path, name, expect: expectText } of pages) {
    pageErrors.length = 0;
    const failedApis: string[] = [];

    // Track API failures during page load
    const handler = async (res: any) => {
      const url = res.url();
      if (url.includes('/api/') && res.status() >= 400) {
        let body = '';
        try { body = await res.text(); } catch {}
        const p = new URL(url).pathname;
        failedApis.push(`${res.status()} ${p} → ${body.substring(0, 80)}`);
      }
    };
    page.on('response', handler);

    await check(`${name} page loads`, async () => {
      await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle2' });
      const text = await page.evaluate(() => document.body.innerText);
      assert(text.includes(expectText), `Expected "${expectText}" on page. Got: ${text.substring(0, 300)}`);
    });

    await new Promise((r) => setTimeout(r, 500));

    await check(`${name} - no API errors`, async () => {
      assert(failedApis.length === 0, failedApis.join('; '));
    });

    await check(`${name} - no JS errors`, async () => {
      assert(pageErrors.length === 0, pageErrors.join('; '));
    });

    page.off('response', handler);
  }

  // -----------------------------------------------------------------------
  // 3. CA operations
  // -----------------------------------------------------------------------
  console.log('\n--- CA ---');

  await check('Generate CA', async () => {
    const res = await page.evaluate(async (base) => {
      const r = await fetch(`${base}/api/ca/generate`, { method: 'POST', credentials: 'include' });
      return { status: r.status, body: await r.text() };
    }, BASE);
    assert(res.status >= 200 && res.status < 300, `${res.status}: ${res.body}`);
  });

  await check('Download CA cert', async () => {
    const res = await page.evaluate(async (base) => {
      const r = await fetch(`${base}/api/ca`, { credentials: 'include' });
      return { status: r.status, body: (await r.text()).substring(0, 50) };
    }, BASE);
    assert(res.status === 200 && res.body.includes('BEGIN CERTIFICATE'), `${res.status}: ${res.body}`);
  });

  // -----------------------------------------------------------------------
  // 4. Token CRUD
  // -----------------------------------------------------------------------
  console.log('\n--- Token CRUD ---');

  await check('Create, rotate, revoke token', async () => {
    const res = await page.evaluate(async (base) => {
      // Create
      const cr = await fetch(`${base}/api/tokens`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Test Token', provider: 'anthropic', realToken: 'sk-test-123' }),
      });
      if (cr.status >= 300) return { step: 'create', status: cr.status, body: await cr.text() };
      const created = await cr.json();
      const id = created.id;
      if (!created.fakeToken || !created.fakeToken.includes('ovb')) return { step: 'create', status: cr.status, body: 'no fake token: ' + created.fakeToken };

      // List
      const lr = await fetch(`${base}/api/tokens`, { credentials: 'include' });
      const listed = await lr.json();
      if (!listed.tokens?.length) return { step: 'list', status: lr.status, body: 'no tokens' };

      // Rotate
      const rr = await fetch(`${base}/api/tokens/${id}/rotate`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ realToken: 'sk-rotated-456' }),
      });
      if (rr.status >= 300) return { step: 'rotate', status: rr.status, body: await rr.text() };

      // Revoke
      const dr = await fetch(`${base}/api/tokens/${id}`, { method: 'DELETE', credentials: 'include' });
      if (dr.status >= 300) return { step: 'revoke', status: dr.status, body: await dr.text() };

      return { step: 'done', status: 200, body: 'ok' };
    }, BASE);
    assert(res.step === 'done', `Failed at ${res.step}: ${res.status} ${res.body}`);
  });

  // -----------------------------------------------------------------------
  // 5. User management
  // -----------------------------------------------------------------------
  console.log('\n--- Users ---');

  await check('Create user', async () => {
    const res = await page.evaluate(async (base) => {
      const r = await fetch(`${base}/api/users`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'testviewer', displayName: 'Test Viewer', role: 'viewer' }),
      });
      return { status: r.status, body: await r.text() };
    }, BASE);
    assert(res.status >= 200 && res.status < 300, `${res.status}: ${res.body}`);
  });

  await check('List users includes new user', async () => {
    const res = await page.evaluate(async (base) => {
      const r = await fetch(`${base}/api/users`, { credentials: 'include' });
      return { status: r.status, body: await r.text() };
    }, BASE);
    assert(res.status === 200, `${res.status}`);
    const users = JSON.parse(res.body).users;
    assert(users?.some((u: any) => u.username === 'testviewer'), `testviewer not found in users list`);
  });

  // -----------------------------------------------------------------------
  // 6. Group management
  // -----------------------------------------------------------------------
  console.log('\n--- Groups ---');

  await check('Create group', async () => {
    const res = await page.evaluate(async (base) => {
      const r = await fetch(`${base}/api/groups`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Engineering', description: 'Engineering team' }),
      });
      return { status: r.status, body: await r.text() };
    }, BASE);
    assert(res.status >= 200 && res.status < 300, `${res.status}: ${res.body}`);
  });

  await check('List groups', async () => {
    const res = await page.evaluate(async (base) => {
      const r = await fetch(`${base}/api/groups`, { credentials: 'include' });
      return { status: r.status, body: await r.text() };
    }, BASE);
    assert(res.status === 200, `${res.status}`);
    const groups = JSON.parse(res.body).groups;
    assert(groups?.some((g: any) => g.name === 'Engineering'), 'Engineering group not found');
  });

  // -----------------------------------------------------------------------
  // 7. Group-based token visibility
  // -----------------------------------------------------------------------
  console.log('\n--- Group-Based Token Visibility ---');

  // Shared state populated by the setup check
  let visSetup: {
    tokenNames: { alpha: string; beta: string; gamma: string };
    inviteTokenAlice: string;
    inviteTokenBob: string;
  } | undefined;

  await check('Visibility: admin creates tokens, groups, users', async () => {
    const res = await page.evaluate(async (base) => {
      const post = (url: string, body: unknown) =>
        fetch(`${base}${url}`, {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }).then((r) => r.json());

      // Create 3 tokens
      const tAlpha = await post('/api/tokens', { name: 'Alpha Key', provider: 'alpha', realToken: 'sk-alpha' });
      const tBeta  = await post('/api/tokens', { name: 'Beta Key',  provider: 'beta',  realToken: 'sk-beta' });
      const tGamma = await post('/api/tokens', { name: 'Gamma Key', provider: 'gamma', realToken: 'sk-gamma' });

      // Create 2 groups
      const gAlpha = await post('/api/groups', { name: 'Alpha Team', description: 'Alpha' });
      const gBeta  = await post('/api/groups', { name: 'Beta Team',  description: 'Beta' });

      // Create 2 manager users (need manager role to list tokens)
      const alice = await post('/api/users', { username: 'alice', displayName: 'Alice', role: 'manager' });
      const bob   = await post('/api/users', { username: 'bob',   displayName: 'Bob',   role: 'manager' });

      // Add users to groups
      await post(`/api/groups/${gAlpha.id}/members`, { userId: alice.id });
      await post(`/api/groups/${gBeta.id}/members`,  { userId: bob.id });

      // Grant tokens to groups: Alpha→AlphaTeam, Beta→BetaTeam, Gamma→both
      await post(`/api/groups/${gAlpha.id}/tokens`, { tokenId: tAlpha.id });
      await post(`/api/groups/${gBeta.id}/tokens`,  { tokenId: tBeta.id });
      await post(`/api/groups/${gAlpha.id}/tokens`, { tokenId: tGamma.id });
      await post(`/api/groups/${gBeta.id}/tokens`,  { tokenId: tGamma.id });

      return {
        ok: !!(tAlpha.id && tBeta.id && tGamma.id && alice.inviteUrl && bob.inviteUrl),
        inviteAlice: alice.inviteUrl as string,
        inviteBob: bob.inviteUrl as string,
      };
    }, BASE);
    assert(res.ok, 'Failed to create test resources');

    visSetup = {
      tokenNames: { alpha: 'Alpha Key', beta: 'Beta Key', gamma: 'Gamma Key' },
      inviteTokenAlice: res.inviteAlice.split('/invite/')[1],
      inviteTokenBob: res.inviteBob.split('/invite/')[1],
    };
  });

  await check('Visibility: Alice sees Alpha + Gamma, not Beta', async () => {
    assert(visSetup !== undefined, 'Setup did not complete');

    // Save admin cookies
    const adminCookies = await page.cookies();

    // Accept Alice's invite (sets her session cookie)
    const accept = await page.evaluate(async (base, token) => {
      const r = await fetch(`${base}/api/invite/${token}/accept`, {
        method: 'POST', credentials: 'include',
      });
      return r.status;
    }, BASE, visSetup!.inviteTokenAlice);
    assert(accept === 200, `Invite accept failed: ${accept}`);

    // List tokens as Alice
    const tokens = await page.evaluate(async (base) => {
      const r = await fetch(`${base}/api/tokens`, { credentials: 'include' });
      const data = await r.json();
      return (data.tokens ?? []).map((t: any) => t.name);
    }, BASE);

    assert(tokens.includes('Alpha Key'), `Alice missing Alpha Key. Sees: ${tokens.join(', ')}`);
    assert(tokens.includes('Gamma Key'), `Alice missing Gamma Key. Sees: ${tokens.join(', ')}`);
    assert(!tokens.includes('Beta Key'), `Alice should not see Beta Key. Sees: ${tokens.join(', ')}`);

    // Restore admin session
    await page.deleteCookie(...adminCookies.map((c) => ({ name: c.name, domain: c.domain })));
    for (const c of adminCookies) await page.setCookie(c);
  });

  await check('Visibility: Bob sees Beta + Gamma, not Alpha', async () => {
    assert(visSetup !== undefined, 'Setup did not complete');

    const adminCookies = await page.cookies();

    const accept = await page.evaluate(async (base, token) => {
      const r = await fetch(`${base}/api/invite/${token}/accept`, {
        method: 'POST', credentials: 'include',
      });
      return r.status;
    }, BASE, visSetup!.inviteTokenBob);
    assert(accept === 200, `Invite accept failed: ${accept}`);

    const tokens = await page.evaluate(async (base) => {
      const r = await fetch(`${base}/api/tokens`, { credentials: 'include' });
      const data = await r.json();
      return (data.tokens ?? []).map((t: any) => t.name);
    }, BASE);

    assert(tokens.includes('Beta Key'), `Bob missing Beta Key. Sees: ${tokens.join(', ')}`);
    assert(tokens.includes('Gamma Key'), `Bob missing Gamma Key. Sees: ${tokens.join(', ')}`);
    assert(!tokens.includes('Alpha Key'), `Bob should not see Alpha Key. Sees: ${tokens.join(', ')}`);

    await page.deleteCookie(...adminCookies.map((c) => ({ name: c.name, domain: c.domain })));
    for (const c of adminCookies) await page.setCookie(c);
  });

  await check('Visibility: admin sees all tokens', async () => {
    const tokens = await page.evaluate(async (base) => {
      const r = await fetch(`${base}/api/tokens`, { credentials: 'include' });
      const data = await r.json();
      return (data.tokens ?? []).map((t: any) => t.name);
    }, BASE);

    assert(tokens.includes('Alpha Key'), `Admin missing Alpha Key`);
    assert(tokens.includes('Beta Key'), `Admin missing Beta Key`);
    assert(tokens.includes('Gamma Key'), `Admin missing Gamma Key`);
  });

  // -----------------------------------------------------------------------
  // 8. Proxy ACLs
  // -----------------------------------------------------------------------
  console.log('\n--- Proxy ACLs ---');

  await check('Proxy ACL status is open', async () => {
    const res = await page.evaluate(async (base) => {
      const r = await fetch(`${base}/api/proxy-acls/status`, { credentials: 'include' });
      return { status: r.status, body: await r.text() };
    }, BASE);
    assert(res.status === 200, `${res.status}: ${res.body}`);
    const data = JSON.parse(res.body);
    assert(data.mode === 'open', `Expected open mode, got ${data.mode}`);
  });

  await check('Create and delete proxy ACL rule', async () => {
    const res = await page.evaluate(async (base) => {
      // Create
      const cr = await fetch(`${base}/api/proxy-acls`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ servicePattern: 'production/*', description: 'Prod services' }),
      });
      if (cr.status >= 300) return { step: 'create', status: cr.status, body: await cr.text() };
      const created = await cr.json();

      // Status should now be restricted
      const sr = await fetch(`${base}/api/proxy-acls/status`, { credentials: 'include' });
      const status = await sr.json();
      if (status.mode !== 'restricted') return { step: 'status', status: sr.status, body: `mode=${status.mode}` };

      // Delete
      const dr = await fetch(`${base}/api/proxy-acls/${created.id}`, {
        method: 'DELETE', credentials: 'include',
      });
      if (dr.status >= 300) return { step: 'delete', status: dr.status, body: await dr.text() };

      return { step: 'done', status: 200, body: 'ok' };
    }, BASE);
    assert(res.step === 'done', `Failed at ${res.step}: ${res.status} ${res.body}`);
  });

  // -----------------------------------------------------------------------
  // 8. New services endpoint
  // -----------------------------------------------------------------------
  console.log('\n--- New Services ---');

  await check('New services endpoint', async () => {
    const res = await page.evaluate(async (base) => {
      const r = await fetch(`${base}/api/services/new`, { credentials: 'include' });
      return { status: r.status, body: await r.text() };
    }, BASE);
    assert(res.status === 200, `${res.status}: ${res.body}`);
    const data = JSON.parse(res.body);
    assert(Array.isArray(data.newAssociations), 'Expected newAssociations array');
  });

  // -----------------------------------------------------------------------
  // Results
  // -----------------------------------------------------------------------
  console.log('\n=========================================');
  console.log(`  RESULTS: ${passed} passed, ${failed} failed`);
  console.log('=========================================');

  if (errors.length > 0) {
    console.log('\nFailures:');
    for (const e of errors) {
      console.log(`  - ${e}`);
    }
  }

  await browser.close();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error('Fatal error:', err);
  if (browser) await browser.close();
  process.exit(1);
});
