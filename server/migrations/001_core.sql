-- 001 · The app's own records (what lives in Firebase today), one table per
-- collection. Each record keeps its full shape in `data` (so moving from
-- Firebase loses nothing); the columns used for searching are taken from it.
-- Rules: nothing is ever deleted, and every change is written to `activity`.

-- ---------------------------------------------------------------- helpers

-- refuse DELETE on any table that has this trigger
CREATE OR REPLACE FUNCTION no_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Deleting is not allowed (%): cancel or correct the record instead', TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END $$;

-- refuse UPDATE and DELETE (append-only logs)
CREATE OR REPLACE FUNCTION append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END $$;

-- keep updated_at / version current
CREATE OR REPLACE FUNCTION touch_row() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  NEW.version := COALESCE(OLD.version, 0) + 1;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------- users

CREATE TABLE app_users (
  id            text PRIMARY KEY,                 -- e.g. the email
  email         text NOT NULL UNIQUE,
  display_name  text NOT NULL DEFAULT '',
  role          text NOT NULL DEFAULT 'staff' CHECK (role IN ('owner', 'manager', 'staff')),
  password_hash text,                             -- scrypt; never the plain password
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  version       integer NOT NULL DEFAULT 1
);

CREATE TABLE devices (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     text NOT NULL REFERENCES app_users(id),
  name        text NOT NULL DEFAULT '',
  kind        text NOT NULL DEFAULT 'phone' CHECK (kind IN ('phone', 'windows', 'browser')),
  last_seen   timestamptz,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- records

-- the common shape of every business record table
CREATE TABLE customers (
  id          text PRIMARY KEY,
  data        jsonb NOT NULL,
  name        text GENERATED ALWAYS AS (data->>'name') STORED,
  mobile      text GENERATED ALWAYS AS (data->>'mobile') STORED,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text NOT NULL DEFAULT '',
  version     integer NOT NULL DEFAULT 1
);
CREATE INDEX customers_name ON customers (lower(name));

CREATE TABLE products (
  id          text PRIMARY KEY,
  data        jsonb NOT NULL,
  name        text GENERATED ALWAYS AS (data->>'name') STORED,
  category    text GENERATED ALWAYS AS (data->>'category') STORED,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text NOT NULL DEFAULT '',
  version     integer NOT NULL DEFAULT 1
);
CREATE INDEX products_name ON products (lower(name));

CREATE TABLE transports (
  id          text PRIMARY KEY,
  data        jsonb NOT NULL,
  name        text GENERATED ALWAYS AS (data->>'name') STORED,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text NOT NULL DEFAULT '',
  version     integer NOT NULL DEFAULT 1
);

CREATE TABLE orders (
  id            text PRIMARY KEY,
  data          jsonb NOT NULL,
  order_no      text GENERATED ALWAYS AS (data->>'orderNo') STORED,
  order_date    text GENERATED ALWAYS AS (data->>'date') STORED,
  customer_id   text GENERATED ALWAYS AS (data->>'customerId') STORED,
  status        text GENERATED ALWAYS AS (data->>'status') STORED,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    text NOT NULL DEFAULT '',
  version       integer NOT NULL DEFAULT 1
);
CREATE INDEX orders_date ON orders (order_date);
CREATE INDEX orders_customer ON orders (customer_id);

CREATE TABLE services (
  id            text PRIMARY KEY,
  data          jsonb NOT NULL,
  job_no        text GENERATED ALWAYS AS (data->>'jobNo') STORED,
  customer_id   text GENERATED ALWAYS AS (data->>'customerId') STORED,
  status        text GENERATED ALWAYS AS (data->>'status') STORED,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    text NOT NULL DEFAULT '',
  version       integer NOT NULL DEFAULT 1
);

CREATE TABLE receipts (
  id            text PRIMARY KEY,
  data          jsonb NOT NULL,
  receipt_date  text GENERATED ALWAYS AS (data->>'date') STORED,
  customer_id   text GENERATED ALWAYS AS (data->>'customerId') STORED,
  cancelled     boolean GENERATED ALWAYS AS (COALESCE((data->>'cancelled')::boolean, false)) STORED,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    text NOT NULL DEFAULT '',
  version       integer NOT NULL DEFAULT 1
);
CREATE INDEX receipts_date ON receipts (receipt_date);

CREATE TABLE messages (
  id            text PRIMARY KEY,
  data          jsonb NOT NULL,
  type          text GENERATED ALWAYS AS (data->>'type') STORED,
  customer_name text GENERATED ALWAYS AS (data->>'customerName') STORED,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    text NOT NULL DEFAULT '',
  version       integer NOT NULL DEFAULT 1
);
CREATE INDEX messages_created ON messages (created_at DESC);

CREATE TABLE settings (
  id          text PRIMARY KEY,               -- 'app'
  data        jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text NOT NULL DEFAULT '',
  version     integer NOT NULL DEFAULT 1
);

-- ---------------------------------------------------------------- history

-- every save, edit, message, PDF, sync and posting: who, when, before, after
CREATE TABLE activity (
  id          bigserial PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  by_user     text NOT NULL DEFAULT '',
  device_id   uuid,
  collection  text NOT NULL,
  record_id   text,
  action      text NOT NULL,
  name        text NOT NULL DEFAULT '',
  details     jsonb,
  before      jsonb,
  after       jsonb
);
CREATE INDEX activity_at ON activity (at DESC);
CREATE INDEX activity_record ON activity (collection, record_id);

-- one entry per offline submission, so a phone retrying never saves twice
CREATE TABLE submissions (
  entry_key   text PRIMARY KEY,               -- uuid made on the phone
  device_id   uuid,
  by_user     text NOT NULL DEFAULT '',
  collection  text NOT NULL,
  record_id   text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  result      jsonb
);

-- ---------------------------------------------------------------- triggers

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['app_users','devices','customers','products','transports','orders','services','receipts','messages','settings','submissions'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION no_delete()', t || '_no_delete', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['app_users','customers','products','transports','orders','services','receipts','messages','settings'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION touch_row()', t || '_touch', t);
  END LOOP;
END $$;

CREATE TRIGGER activity_append_only BEFORE UPDATE OR DELETE ON activity FOR EACH ROW EXECUTE FUNCTION append_only();
