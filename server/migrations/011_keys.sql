-- 011 · A key for each business, and each person's own access to it.
--
-- The keys themselves are made and opened only on people's devices
-- (shared/vahikosha-keys.ts). This database keeps only what can't open
-- anything on its own:
--   person_keys       each person's public key, and their private key sealed
--                     with a passphrase only they know
--   business_keys     the versions of a business's key (a check value each,
--                     never the key)
--   key_envelopes     a key version locked for one person, or for the
--                     business's recovery code
--   business_recovery the recovery code's public key, and its private key
--                     sealed with the code
-- When someone leaves a business, their envelopes are withdrawn at once and
-- the business is marked for a new key version, which the owner's device makes
-- for everyone who stays.

CREATE TABLE person_keys (
  user_id        text PRIMARY KEY REFERENCES app_users(id),
  public_key     text NOT NULL,
  private_sealed text NOT NULL,
  salt           text NOT NULL,
  iter           integer NOT NULL CHECK (iter >= 100000),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  version        integer NOT NULL DEFAULT 1
);

CREATE TABLE business_keys (
  business_id  uuid NOT NULL REFERENCES businesses(id) DEFAULT current_business(),
  version      integer NOT NULL CHECK (version >= 1),
  key_check    text NOT NULL,
  created_by   text NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now(),
  retired_at   timestamptz,          -- a newer version took over
  PRIMARY KEY (business_id, version)
);

CREATE TABLE key_envelopes (
  business_id  uuid NOT NULL REFERENCES businesses(id) DEFAULT current_business(),
  version      integer NOT NULL,
  holder       text NOT NULL,        -- a user id, or 'recovery'
  envelope     text NOT NULL,
  created_by   text NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz,          -- the holder left the business
  PRIMARY KEY (business_id, version, holder),
  FOREIGN KEY (business_id, version) REFERENCES business_keys (business_id, version)
);

CREATE TABLE business_recovery (
  business_id    uuid PRIMARY KEY REFERENCES businesses(id) DEFAULT current_business(),
  public_key     text NOT NULL,
  private_sealed text NOT NULL,
  salt           text NOT NULL,
  iter           integer NOT NULL CHECK (iter >= 100000),
  created_by     text NOT NULL DEFAULT '',
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- someone left, or the owner asked: the next key version is due
ALTER TABLE businesses ADD COLUMN key_rotation_due boolean NOT NULL DEFAULT false;

-- each business sees only its own keys (as in 010)
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['business_keys', 'key_envelopes', 'business_recovery'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY own_business ON %I USING (business_id = current_business()) WITH CHECK (business_id = current_business())', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION no_delete()', t || '_no_delete', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION no_truncate()', t || '_no_truncate', t);
  END LOOP;
END $$;
CREATE TRIGGER person_keys_no_delete BEFORE DELETE ON person_keys FOR EACH ROW EXECUTE FUNCTION no_delete();
CREATE TRIGGER person_keys_no_truncate BEFORE TRUNCATE ON person_keys FOR EACH STATEMENT EXECUTE FUNCTION no_truncate();
CREATE TRIGGER person_keys_touch BEFORE UPDATE ON person_keys FOR EACH ROW EXECUTE FUNCTION touch_row();

-- an envelope never changes after it's made; it can only be withdrawn
CREATE OR REPLACE FUNCTION envelope_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.envelope IS DISTINCT FROM OLD.envelope OR NEW.holder IS DISTINCT FROM OLD.holder OR NEW.version IS DISTINCT FROM OLD.version
     OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN
    RAISE EXCEPTION 'An envelope can''t be changed, only withdrawn' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER key_envelopes_guard BEFORE UPDATE ON key_envelopes FOR EACH ROW EXECUTE FUNCTION envelope_guard();

-- a key version's check value never changes
CREATE OR REPLACE FUNCTION business_key_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.key_check IS DISTINCT FROM OLD.key_check OR NEW.version IS DISTINCT FROM OLD.version THEN
    RAISE EXCEPTION 'A key version can''t be changed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER business_keys_guard BEFORE UPDATE ON business_keys FOR EACH ROW EXECUTE FUNCTION business_key_guard();

-- a person's key pair stays the same once anyone has locked a key for it
-- (a new passphrase re-seals the same private key; a new pair comes with recovery)
CREATE OR REPLACE FUNCTION person_key_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.public_key IS DISTINCT FROM OLD.public_key THEN
    RAISE EXCEPTION 'This person''s key is in use; it can only get a new passphrase' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER person_keys_guard BEFORE UPDATE ON person_keys FOR EACH ROW EXECUTE FUNCTION person_key_guard();

-- someone leaves a business: withdraw their envelopes there and ask for a new key version
CREATE OR REPLACE FUNCTION member_left() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE was text := current_setting('vahikosha.business_id', true); has_key boolean;
BEGIN
  IF OLD.active AND NOT NEW.active THEN
    -- work inside that business for a moment (row-level security), then put the setting back
    PERFORM set_config('vahikosha.business_id', NEW.business_id::text, true);
    UPDATE key_envelopes SET revoked_at = now() WHERE holder = NEW.user_id AND revoked_at IS NULL;
    SELECT EXISTS (SELECT 1 FROM business_keys) INTO has_key;
    PERFORM set_config('vahikosha.business_id', COALESCE(was, ''), true);
    IF has_key THEN UPDATE businesses SET key_rotation_due = true WHERE id = NEW.business_id; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER members_left AFTER UPDATE ON members FOR EACH ROW EXECUTE FUNCTION member_left();
