-- TechTalent Portal — recruiter accounts (Cloudflare D1 / SQLite)
-- Apply once: Cloudflare → D1 → techtalent-accounts → Console → paste & run
--         or: npx wrangler d1 execute techtalent-accounts --remote --file=accounts-schema.sql

CREATE TABLE IF NOT EXISTS orgs (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  domain       TEXT NOT NULL,
  group_email  TEXT NOT NULL UNIQUE,          -- shared company mailbox, e.g. hiring@acme.com
  seat_limit   INTEGER NOT NULL DEFAULT 5,    -- max active + pending recruiters
  verified_at  TEXT,                          -- set when the group mailbox confirms
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS recruiters (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES orgs(id),
  username      TEXT NOT NULL UNIQUE,         -- lowercase, used to sign in
  display_name  TEXT NOT NULL,
  pass_hash     TEXT NOT NULL,                -- PBKDF2-SHA256, base64
  pass_salt     TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',  -- pending | active | declined | removed
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until  TEXT,
  created_at    TEXT NOT NULL,
  approved_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_recruiters_org ON recruiters(org_id, status);

-- One-time links (confirm org, approve/decline recruiter) and sign-in sessions.
-- Only a SHA-256 hash of each token is stored.
CREATE TABLE IF NOT EXISTS tokens (
  token_hash  TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,                  -- org_verify | approve | decline | session
  ref_id      TEXT NOT NULL,                  -- org id or recruiter id
  expires_at  TEXT NOT NULL,
  used_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_tokens_ref ON tokens(ref_id, kind);
