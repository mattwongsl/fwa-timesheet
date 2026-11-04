-- Additive only. No password resets, account changes, or session deletion.
CREATE TABLE auth_sessions (
  id_hash TEXT PRIMARY KEY CHECK (length(id_hash) = 64),
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX auth_sessions_user ON auth_sessions(user_id);
CREATE INDEX auth_sessions_expiry ON auth_sessions(expires_at);
CREATE TABLE password_reset_tokens (
  token_hash TEXT PRIMARY KEY CHECK (length(token_hash) = 64),
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX password_reset_user ON password_reset_tokens(user_id);
-- Deactivation revokes sessions permanently, including after reactivation.
CREATE FUNCTION revoke_inactive_sessions() RETURNS TRIGGER LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF OLD.active AND NOT NEW.active THEN
    DELETE FROM auth_sessions WHERE user_id = NEW.id;
    DELETE FROM password_reset_tokens WHERE user_id = NEW.id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER revoke_inactive_sessions AFTER UPDATE OF active ON users
  FOR EACH ROW EXECUTE FUNCTION revoke_inactive_sessions();
