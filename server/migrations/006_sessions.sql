-- 006 · Sign-in sessions. The token itself is never stored, only its SHA-256.
CREATE TABLE sessions (
  token_hash  text PRIMARY KEY,
  user_id     text NOT NULL REFERENCES app_users(id),
  device      text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_seen   timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  ended_at    timestamptz            -- signed out (kept, never deleted)
);
CREATE INDEX sessions_user ON sessions (user_id);
CREATE TRIGGER sessions_no_delete BEFORE DELETE ON sessions FOR EACH ROW EXECUTE FUNCTION no_delete();
CREATE TRIGGER sessions_no_truncate BEFORE TRUNCATE ON sessions FOR EACH STATEMENT EXECUTE FUNCTION no_truncate();
