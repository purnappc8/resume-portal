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

-- ── Candidates (public profile + PRIVATE email) and recruiter → candidate messages ──
CREATE TABLE IF NOT EXISTS candidates (
  id            TEXT PRIMARY KEY,               -- cand_xxx (public)
  email         TEXT NOT NULL UNIQUE,           -- private: never returned by public endpoints
  phone         TEXT,                           -- private
  name          TEXT NOT NULL,
  profile_json  TEXT NOT NULL,                  -- public fields (role, skills, summary…)
  pending_json  TEXT,                           -- an update waiting for email confirmation
  status        TEXT NOT NULL DEFAULT 'pending',-- pending | active | hidden
  verified_at   TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_candidates_status ON candidates(status, updated_at);

CREATE TABLE IF NOT EXISTS messages (
  id            TEXT PRIMARY KEY,
  candidate_id  TEXT NOT NULL REFERENCES candidates(id),
  recruiter_id  TEXT NOT NULL REFERENCES recruiters(id),
  org_id        TEXT NOT NULL REFERENCES orgs(id),
  kind          TEXT NOT NULL DEFAULT 'message', -- message | call
  subject       TEXT NOT NULL,
  body          TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  read_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_candidate ON messages(candidate_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_recruiter ON messages(recruiter_id, created_at);
