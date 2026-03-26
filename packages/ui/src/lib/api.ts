// ---------------------------------------------------------------------------
// API client for the Overbearer management server.
// All functions hit /api/* which Vite proxies to localhost:3000 during dev.
// ---------------------------------------------------------------------------

/** Standard shape returned by the API on errors. */
export interface ApiError {
  status: number;
  message: string;
}

/** Thin wrapper around `fetch` that handles JSON + cookies + errors. */
async function request<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const headers: Record<string, string> = {
    ...((options.headers as Record<string, string>) ?? {}),
  };
  // Only set Content-Type for requests with a body
  if (options.body) {
    headers['Content-Type'] = headers['Content-Type'] ?? 'application/json';
  }
  const res = await fetch(path, {
    credentials: 'include',
    ...options,
    headers,
  });

  // 204 No Content – nothing to parse
  if (res.status === 204) return undefined as unknown as T;

  const body = await res.json().catch(() => null);

  if (!res.ok) {
    const err: ApiError = {
      status: res.status,
      message: body?.message ?? body?.error ?? res.statusText,
    };
    throw err;
  }

  return body as T;
}

function get<T>(path: string) {
  return request<T>(path, { method: 'GET' });
}

function post<T>(path: string, body?: unknown) {
  return request<T>(path, {
    method: 'POST',
    body: body != null ? JSON.stringify(body) : undefined,
  });
}

function put<T>(path: string, body?: unknown) {
  return request<T>(path, {
    method: 'PUT',
    body: body != null ? JSON.stringify(body) : undefined,
  });
}

function del<T>(path: string) {
  return request<T>(path, { method: 'DELETE' });
}

// ---------------------------------------------------------------------------
// Domain types (mirrors of server-side models)
// ---------------------------------------------------------------------------

export type Role = 'admin' | 'manager' | 'viewer' | 'requester';

export interface User {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  createdAt: string;
}

export interface Token {
  id: string;
  name: string;
  provider: string;
  fakeToken: string;
  status: 'active' | 'revoked';
  createdBy: string;
  createdByUsername?: string;
  lastUsedAt: string | null;
  createdAt: string;
  accessibleBy?: {
    users: { id: string; username: string }[];
    groups: { id: string; name: string }[];
  };
}

export interface TokenCreateResult {
  token: Token;
  fakeToken: string;
}

export interface TokenRequest {
  id: string;
  provider: string;
  reason: string;
  status: 'pending' | 'approved' | 'denied';
  requestedBy: string;
  requestedByUsername?: string;
  reviewedBy: string | null;
  reviewedByUsername?: string;
  createdAt: string;
  reviewedAt: string | null;
}

export interface LogEntry {
  id: string;
  timestamp: string;
  service: string;
  sourceIp: string;
  targetHost: string;
  method: string;
  path: string;
  tokenType: 'fake' | 'real_direct' | 'unknown';
  tokenId: string | null;
  statusCode: number;
  latencyMs: number;
}

export interface LogQueryParams {
  startDate?: string;
  endDate?: string;
  service?: string;
  targetHost?: string;
  tokenType?: string;
  page?: number;
  limit?: number;
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
}

export interface Service {
  name: string;
  ip: string;
  warningCount: number;
  lastSeenAt: string;
}

export interface DashboardStats {
  totalTokens: number;
  activeTokens: number;
  pendingRequests: number;
  warningServices: number;
  recentActivity: LogEntry[];
  realTokenServices: Service[];
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export const auth = {
  setupStatus() {
    return get<{ needsSetup: boolean }>('/api/auth/setup-status');
  },

  setup(username: string, displayName?: string) {
    return post<{ user: User }>('/api/auth/setup', { username, displayName });
  },

  registerOptions(username: string) {
    return post<PublicKeyCredentialCreationOptionsJSON>(
      '/api/auth/register-options',
      { username },
    );
  },

  register(userId: string, response: unknown) {
    return post<{ verified: boolean; user: User }>('/api/auth/register', {
      userId,
      response,
    });
  },

  loginOptions() {
    return post<{ options: PublicKeyCredentialRequestOptionsJSON }>(
      '/api/auth/login-options',
    );
  },

  login(response: unknown) {
    return post<{ verified: boolean; user: User }>('/api/auth/login', { response });
  },

  logout() {
    return post<void>('/api/auth/logout');
  },

  me() {
    return get<{ id: string; username: string; displayName: string; role: Role }>('/api/auth/me');
  },

  hasPasskey() {
    return get<{ hasPasskey: boolean }>('/api/auth/has-passkey');
  },

  registerPasskeyOptions() {
    return post<{ options: PublicKeyCredentialCreationOptionsJSON; userId: string }>(
      '/api/auth/register-passkey',
    );
  },

  registerPasskeyVerify(response: unknown) {
    return post<{ success: boolean }>('/api/auth/register-passkey-verify', { response });
  },
};

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

export const tokens = {
  list() {
    return get<{ tokens: Token[] }>('/api/tokens');
  },

  create(data: { name: string; provider: string; realToken: string }) {
    return post<TokenCreateResult>('/api/tokens', data);
  },

  revoke(id: string) {
    return del<void>(`/api/tokens/${id}`);
  },

  capture(data: { name: string; provider?: string; tokenId: string }) {
    return post<{ id: string; name: string; provider: string; fakeToken: string }>(
      '/api/tokens/capture',
      data,
    );
  },

  rotate(id: string, data: { realToken: string }) {
    return post<Token>(`/api/tokens/${id}/rotate`, data);
  },

  grantAccess(tokenId: string, target: { userId?: string; groupId?: string }) {
    return post<void>(`/api/tokens/${tokenId}/access`, target);
  },

  revokeUserAccess(tokenId: string, userId: string) {
    return del<void>(`/api/tokens/${tokenId}/access/users/${userId}`);
  },

  revokeGroupAccess(tokenId: string, groupId: string) {
    return del<void>(`/api/tokens/${tokenId}/access/groups/${groupId}`);
  },
};

// ---------------------------------------------------------------------------
// Token requests
// ---------------------------------------------------------------------------

export const tokenRequests = {
  list() {
    return get<{ requests: TokenRequest[] }>('/api/tokens/requests');
  },

  create(data: { provider: string; reason: string }) {
    return post<TokenRequest>('/api/tokens/requests', data);
  },

  approve(id: string, data: { name: string; realToken: string }) {
    return post<Token>(`/api/tokens/requests/${id}/approve`, data);
  },

  deny(id: string) {
    return post<void>(`/api/tokens/requests/${id}/deny`);
  },
};

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

export const logs = {
  query(params: LogQueryParams = {}) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v != null && v !== '') qs.set(k, String(v));
    }
    const query = qs.toString();
    return get<PaginatedResponse<LogEntry>>(
      `/api/logs${query ? `?${query}` : ''}`,
    );
  },
};

// ---------------------------------------------------------------------------
// Users (admin)
// ---------------------------------------------------------------------------

export const users = {
  list() {
    return get<{ users: User[] }>('/api/users');
  },

  create(username: string, displayName?: string, role?: Role) {
    return post<{ id: string; username: string; displayName: string; role: string; inviteUrl: string }>(
      '/api/users',
      { username, displayName, role },
    );
  },

  updateRole(id: string, role: Role) {
    return request<User>(`/api/users/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ role }),
    });
  },

  delete(id: string) {
    return del<void>(`/api/users/${id}`);
  },
};

// ---------------------------------------------------------------------------
// CA / Certificates
// ---------------------------------------------------------------------------

export const ca = {
  /** Returns the PEM-encoded CA certificate (text). */
  async download(): Promise<string> {
    const res = await fetch('/api/ca', {
      credentials: 'include',
    });
    if (!res.ok) throw { status: res.status, message: res.statusText };
    return res.text();
  },

  generate() {
    return post<{ success: boolean; expiresAt: string }>('/api/ca/generate');
  },

  upload(certPem: string, keyPem: string) {
    return post<{ success: boolean; subject: string; expiresAt: string }>(
      '/api/ca/upload',
      { certPem, keyPem },
    );
  },
};

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

export const services = {
  list() {
    return get<{ services: Service[] }>('/api/services');
  },

  newAssociations(hours?: number) {
    const qs = hours ? `?hours=${hours}` : '';
    return get<{ newAssociations: NewAssociation[]; hours: number }>(`/api/services/new${qs}`);
  },
};

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

export interface Group {
  id: string;
  name: string;
  description: string | null;
  memberCount: number;
  tokenCount: number;
  createdAt: string;
}

export interface GroupDetail extends Group {
  members: { id: string; username: string; displayName: string; role: Role }[];
  tokens: { id: string; name: string; provider: string | null }[];
}

export interface NewAssociation {
  serviceName: string;
  tokenId: string;
  tokenName: string;
  provider: string | null;
  firstSeen: string;
  requestCount: number;
  knownServiceCount: number;
  knownServices: string[];
}

export const groups = {
  list() {
    return get<{ groups: Group[] }>('/api/groups');
  },

  get(id: string) {
    return get<{ group: GroupDetail }>(`/api/groups/${id}`);
  },

  create(data: { name: string; description?: string }) {
    return post<{ group: Group }>('/api/groups', data);
  },

  update(id: string, data: { name?: string; description?: string }) {
    return request<{ group: Group }>(`/api/groups/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  },

  delete(id: string) {
    return del<void>(`/api/groups/${id}`);
  },

  addMember(groupId: string, userId: string) {
    return post<void>(`/api/groups/${groupId}/members`, { userId });
  },

  removeMember(groupId: string, userId: string) {
    return del<void>(`/api/groups/${groupId}/members/${userId}`);
  },

  grantToken(groupId: string, tokenId: string) {
    return post<void>(`/api/groups/${groupId}/tokens`, { tokenId });
  },

  revokeToken(groupId: string, tokenId: string) {
    return del<void>(`/api/groups/${groupId}/tokens/${tokenId}`);
  },
};

// ---------------------------------------------------------------------------
// Proxy ACLs
// ---------------------------------------------------------------------------

export interface ProxyAcl {
  id: string;
  servicePattern: string;
  description: string | null;
  createdBy: string;
  createdAt: string;
}

export const proxyAcls = {
  list() {
    return get<{ rules: ProxyAcl[] }>('/api/proxy-acls');
  },

  status() {
    return get<{ mode: 'open' | 'restricted'; ruleCount: number }>('/api/proxy-acls/status');
  },

  create(data: { servicePattern: string; description?: string }) {
    return post<{ rule: ProxyAcl }>('/api/proxy-acls', data);
  },

  delete(id: string) {
    return del<void>(`/api/proxy-acls/${id}`);
  },
};

// Re-export a convenience type used by WebAuthn helpers.
// These mirror the @simplewebauthn types but we keep our own slim copy
// so consumers don't need to import the library directly.
export type PublicKeyCredentialCreationOptionsJSON = Record<string, unknown>;
export type PublicKeyCredentialRequestOptionsJSON = Record<string, unknown>;
