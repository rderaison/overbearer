CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username VARCHAR(255) UNIQUE NOT NULL,
    display_name VARCHAR(255),
    role VARCHAR(50) NOT NULL CHECK (role IN ('requester', 'manager', 'viewer', 'admin')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS passkey_credentials (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    credential_id TEXT UNIQUE NOT NULL,
    public_key BYTEA NOT NULL,
    counter BIGINT DEFAULT 0,
    transports TEXT[],
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_passkey_user ON passkey_credentials(user_id);
CREATE INDEX IF NOT EXISTS idx_passkey_credential ON passkey_credentials(credential_id);

CREATE TABLE IF NOT EXISTS token_mappings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    provider VARCHAR(255),
    fake_token_hash VARCHAR(64) UNIQUE NOT NULL,
    fake_token_value TEXT NOT NULL,
    real_token_encrypted BYTEA NOT NULL,
    real_token_hash VARCHAR(64) NOT NULL,
    created_by UUID REFERENCES users(id),
    last_used_at TIMESTAMPTZ,
    revoked BOOLEAN DEFAULT FALSE,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_token_fake_hash ON token_mappings(fake_token_hash) WHERE NOT revoked;
CREATE INDEX IF NOT EXISTS idx_token_real_hash ON token_mappings(real_token_hash) WHERE NOT revoked;
CREATE INDEX IF NOT EXISTS idx_token_creator ON token_mappings(created_by);

CREATE TABLE IF NOT EXISTS token_access (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_id UUID NOT NULL REFERENCES token_mappings(id) ON DELETE CASCADE,
    granted_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, token_id)
);

CREATE TABLE IF NOT EXISTS token_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id),
    provider VARCHAR(255) NOT NULL,
    reason TEXT,
    status VARCHAR(50) DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied')),
    approved_by UUID REFERENCES users(id),
    token_id UUID REFERENCES token_mappings(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ca_certificates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cert_pem TEXT NOT NULL,
    key_pem_encrypted BYTEA NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS service_certificates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    service_name VARCHAR(255) UNIQUE NOT NULL,
    cert_pem TEXT NOT NULL,
    key_pem_encrypted BYTEA NOT NULL,
    ca_cert_hash VARCHAR(64),
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS webauthn_challenges (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    challenge TEXT NOT NULL,
    user_id UUID REFERENCES users(id),
    type VARCHAR(20) NOT NULL CHECK (type IN ('registration', 'authentication')),
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_challenge_expires ON webauthn_challenges(expires_at);

CREATE TABLE IF NOT EXISTS invite_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token VARCHAR(255) UNIQUE NOT NULL,
    used BOOLEAN DEFAULT FALSE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_invite_token ON invite_tokens(token);
CREATE INDEX IF NOT EXISTS idx_invite_user ON invite_tokens(user_id);

-- -------------------------------------------------------------------------
-- Groups & Group Membership
-- -------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS groups (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) UNIQUE NOT NULL,
    description TEXT,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS group_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    added_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(group_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_group_members_group ON group_members(group_id);
CREATE INDEX IF NOT EXISTS idx_group_members_user ON group_members(user_id);

-- Group-level token access (complements user-level token_access)
CREATE TABLE IF NOT EXISTS token_group_access (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    token_id UUID NOT NULL REFERENCES token_mappings(id) ON DELETE CASCADE,
    granted_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(group_id, token_id)
);

CREATE INDEX IF NOT EXISTS idx_token_group_access_group ON token_group_access(group_id);
CREATE INDEX IF NOT EXISTS idx_token_group_access_token ON token_group_access(token_id);

-- -------------------------------------------------------------------------
-- Proxy Source ACLs
-- -------------------------------------------------------------------------

-- When this table has entries, only matching sources can use the proxy.
-- When empty, the proxy is open (default).
CREATE TABLE IF NOT EXISTS proxy_acls (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    service_pattern VARCHAR(255) NOT NULL,
    description TEXT,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
);
