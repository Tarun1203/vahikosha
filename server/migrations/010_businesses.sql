-- 010 · Many businesses in one database (Vahikosha).
--
-- Every business gets its own space: each business table has a business_id, and
-- the database itself only shows a connection the rows of the business it is
-- working for (row-level security). The server says which business that is at
-- the start of every request:
--     SELECT set_config('vahikosha.business_id', '<uuid>', true)
-- A connection that hasn't said so sees nothing and can't save anything.
--
-- People sign in once (app_users) and belong to one or more businesses
-- (members), each time with one role: owner, accountant, staff or outside_ca.
-- Chittam support staff are app users marked is_support: they are never members,
-- so they can't see any business data.
--
-- Chittam Enterprises becomes the first business; every row already here is
-- given to it, so nothing changes for the current app.

-- ---------------------------------------------------------------- businesses

CREATE TABLE businesses (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                   text NOT NULL CHECK (btrim(name) <> ''),
  status                 text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'closed')),
  -- the owner may let the Accountant approve entries before they go to Tally
  accountant_can_approve boolean NOT NULL DEFAULT false,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  version                integer NOT NULL DEFAULT 1
);

-- Chittam Enterprises: the business whose data is already in this database
INSERT INTO businesses (id, name) VALUES ('00000000-0000-4000-8000-000000000001', 'Chittam Enterprises');

ALTER TABLE app_users ADD COLUMN is_support boolean NOT NULL DEFAULT false;

CREATE TABLE members (
  business_id  uuid NOT NULL REFERENCES businesses(id),
  user_id      text NOT NULL REFERENCES app_users(id),
  role         text NOT NULL CHECK (role IN ('owner', 'accountant', 'staff', 'outside_ca')),
  active       boolean NOT NULL DEFAULT true,
  -- an outside CA sees the books only for the period the owner chose
  access_from  date,
  access_to    date,
  added_by     text NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  version      integer NOT NULL DEFAULT 1,
  PRIMARY KEY (business_id, user_id),
  CHECK (access_to IS NULL OR access_from IS NULL OR access_to >= access_from)
);
CREATE INDEX members_user ON members (user_id);

-- support staff can't be members of a business
CREATE OR REPLACE FUNCTION member_not_support() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM app_users WHERE id = NEW.user_id AND is_support) THEN
    RAISE EXCEPTION 'Chittam support staff can''t be members of a business' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER members_not_support BEFORE INSERT OR UPDATE ON members FOR EACH ROW EXECUTE FUNCTION member_not_support();

CREATE OR REPLACE FUNCTION support_not_member() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.is_support AND EXISTS (SELECT 1 FROM members WHERE user_id = NEW.id AND active) THEN
    RAISE EXCEPTION 'A member of a business can''t also be Chittam support' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER app_users_support_not_member BEFORE INSERT OR UPDATE ON app_users FOR EACH ROW EXECUTE FUNCTION support_not_member();

-- the people already here join Chittam Enterprises (manager → accountant)
INSERT INTO members (business_id, user_id, role, active, added_by)
  SELECT '00000000-0000-4000-8000-000000000001', id,
         CASE role WHEN 'owner' THEN 'owner' WHEN 'manager' THEN 'accountant' ELSE 'staff' END,
         active, 'migration 010'
  FROM app_users;

-- modules each business can switch on or off (missing row = on)
CREATE TABLE business_modules (
  business_id  uuid NOT NULL REFERENCES businesses(id),
  module       text NOT NULL CHECK (module IN ('orders', 'services', 'transports', 'catalog')),
  enabled      boolean NOT NULL DEFAULT true,
  changed_by   text NOT NULL DEFAULT '',
  changed_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, module)
);

-- which business a signed-in session is working in (chosen after sign-in)
ALTER TABLE sessions ADD COLUMN business_id uuid REFERENCES businesses(id);
UPDATE sessions SET business_id = '00000000-0000-4000-8000-000000000001';

CREATE TRIGGER businesses_touch BEFORE UPDATE ON businesses FOR EACH ROW EXECUTE FUNCTION touch_row();
CREATE TRIGGER members_touch BEFORE UPDATE ON members FOR EACH ROW EXECUTE FUNCTION touch_row();
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['businesses', 'members', 'business_modules'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION no_delete()', t || '_no_delete', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION no_truncate()', t || '_no_truncate', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------- the current business

-- the business this connection is working for, or NULL when it hasn't said
CREATE OR REPLACE FUNCTION current_business() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('vahikosha.business_id', true), '')::uuid
$$;

-- ---------------------------------------------------------------- business_id on every business table

CREATE TEMP TABLE biz_tables (name text PRIMARY KEY) ON COMMIT DROP;
INSERT INTO biz_tables VALUES
  -- the app's records and history
  ('devices'), ('customers'), ('products'), ('transports'), ('orders'), ('services'), ('receipts'),
  ('messages'), ('settings'), ('activity'), ('submissions'),
  -- accounting copied from Tally
  ('companies'), ('financial_years'), ('period_locks'), ('account_groups'), ('ledgers'), ('ledger_openings'),
  ('stock_groups'), ('units'), ('godowns'), ('stock_items'), ('voucher_types'), ('vouchers'), ('voucher_entries'),
  ('bill_allocations'), ('bank_allocations'), ('inventory_entries'), ('voucher_tax_lines'), ('voucher_links'),
  ('sync_runs'), ('stock_openings'), ('opening_bills'), ('tally_bill_snapshots'),
  -- the copy of Firebase
  ('fb_tally'), ('fb_copy_state');

-- 1. remember the links between these tables, then drop them (they come back
--    below with business_id in them, so a row can only point inside its own business)
CREATE TEMP TABLE biz_fks ON COMMIT DROP AS
  SELECT c.conname, c.conrelid::regclass::text AS tbl, c.confrelid::regclass::text AS ref,
         (SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY k.n) FROM unnest(c.conkey) WITH ORDINALITY k(attnum, n)
            JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS cols,
         (SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY k.n) FROM unnest(c.confkey) WITH ORDINALITY k(attnum, n)
            JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum) AS refcols,
         c.condeferrable, c.condeferred
  FROM pg_constraint c
  WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace
    AND c.conrelid::regclass::text IN (SELECT name FROM biz_tables)
    AND c.confrelid::regclass::text IN (SELECT name FROM biz_tables);

DO $$
DECLARE f record;
BEGIN
  FOR f IN SELECT * FROM biz_fks LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', f.tbl, f.conname);
  END LOOP;
END $$;

-- 2. add the column: existing rows belong to Chittam Enterprises; new rows to
--    the business the connection is working for (none set → the save is refused)
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT name FROM biz_tables LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN business_id uuid REFERENCES businesses(id)', t);
    EXECUTE format('UPDATE %I SET business_id = %L', t, '00000000-0000-4000-8000-000000000001');
    EXECUTE format('ALTER TABLE %I ALTER COLUMN business_id SET DEFAULT current_business(), ALTER COLUMN business_id SET NOT NULL', t);
  END LOOP;
END $$;

-- 3. keys that were unique for one business become unique within a business
--    (two businesses may both have a customer "c1", a company "business", settings "app"…)
DO $$
DECLARE t text; k text;
BEGIN
  FOREACH t IN ARRAY ARRAY['customers', 'products', 'transports', 'orders', 'services', 'receipts', 'messages', 'settings',
                           'companies', 'period_locks', 'stock_groups', 'units', 'godowns', 'voucher_types',
                           'stock_openings', 'opening_bills', 'voucher_links', 'fb_tally', 'fb_copy_state'] LOOP
    SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY k2.n) INTO k
      FROM pg_constraint c, unnest(c.conkey) WITH ORDINALITY k2(attnum, n)
      JOIN pg_attribute a ON a.attnum = k2.attnum
      WHERE c.conrelid = t::regclass AND c.contype = 'p' AND a.attrelid = c.conrelid;
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', t, t || '_pkey');
    EXECUTE format('ALTER TABLE %I ADD PRIMARY KEY (business_id, %s)', t, k);
  END LOOP;
END $$;

ALTER TABLE companies DROP CONSTRAINT companies_id_check;   -- was only 'business' or 'cash'
ALTER TABLE companies ADD CONSTRAINT companies_id_check CHECK (id ~ '^[A-Za-z0-9_-]{1,40}$');

ALTER TABLE financial_years DROP CONSTRAINT financial_years_company_id_starts_key,
  ADD CONSTRAINT financial_years_company_id_starts_key UNIQUE (business_id, company_id, starts);
ALTER TABLE account_groups DROP CONSTRAINT account_groups_company_id_name_key,
  ADD CONSTRAINT account_groups_company_id_name_key UNIQUE (business_id, company_id, name);
ALTER TABLE ledgers DROP CONSTRAINT ledgers_company_id_name_key,
  ADD CONSTRAINT ledgers_company_id_name_key UNIQUE (business_id, company_id, name);
ALTER TABLE stock_items DROP CONSTRAINT stock_items_company_id_name_key,
  ADD CONSTRAINT stock_items_company_id_name_key UNIQUE (business_id, company_id, name);
DROP INDEX vouchers_tally_current;
CREATE UNIQUE INDEX vouchers_tally_current ON vouchers (business_id, company_id, tally_guid) WHERE is_current AND tally_guid IS NOT NULL;

-- 4. put the links back, now including business_id
DO $$
DECLARE f record; has_key boolean;
BEGIN
  FOR f IN SELECT * FROM biz_fks LOOP
    -- the target needs a unique (business_id, …) key to point at
    SELECT EXISTS (
      SELECT 1 FROM pg_constraint c
      WHERE c.conrelid = f.ref::regclass AND c.contype IN ('p', 'u')
        AND (SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY k.n) FROM unnest(c.conkey) WITH ORDINALITY k(attnum, n)
               JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) = 'business_id, ' || f.refcols
    ) INTO has_key;
    IF NOT has_key THEN
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I UNIQUE (business_id, %s)', f.ref, f.ref || '_business_key', f.refcols);
    END IF;
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (business_id, %s) REFERENCES %I (business_id, %s)%s',
      f.tbl, f.conname, f.cols, f.ref, f.refcols,
      CASE WHEN f.condeferred THEN ' DEFERRABLE INITIALLY DEFERRED' WHEN f.condeferrable THEN ' DEFERRABLE' ELSE '' END);
  END LOOP;
END $$;

CREATE INDEX activity_business_at ON activity (business_id, at DESC);
CREATE INDEX vouchers_business ON vouchers (business_id, company_id, vdate) WHERE is_current;

-- 5. the database only shows each connection its own business
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT name FROM biz_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    -- also for the table owner (the app's own database login)
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY own_business ON %I USING (business_id = current_business()) WITH CHECK (business_id = current_business())', t);
  END LOOP;
END $$;

-- reports (views) read with the rights of whoever asks, so the rule above applies to them too
DO $$
DECLARE v text;
BEGIN
  FOR v IN SELECT viewname FROM pg_views WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER VIEW %I SET (security_invoker = true)', v);
  END LOOP;
END $$;
