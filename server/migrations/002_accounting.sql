-- 002 · Double-entry accounting, modelled on Tally so every Tally voucher fits.
-- Stage A fills these from Tally (owner = 'tally'); Stage B adds vouchers made
-- in the app (owner = 'app') that are then posted to Tally.
--
-- Sign rule everywhere: amount > 0 is DEBIT, amount < 0 is CREDIT
-- (the opposite of Tally's XML, which shows debit as negative).
-- Nothing is deleted: a Tally voucher that changes is kept, marked superseded,
-- and its new version is added.

CREATE TABLE companies (
  id             text PRIMARY KEY CHECK (id IN ('business', 'cash')),
  label          text NOT NULL,            -- "Chittam Enterprises", "Cash"
  tally_company  text NOT NULL DEFAULT '', -- e.g. "Chittam Enterprises - 2026"
  gstin          text NOT NULL DEFAULT '',
  state          text NOT NULL DEFAULT ''
);
INSERT INTO companies (id, label) VALUES ('business', 'Chittam Enterprises'), ('cash', 'Cash');

CREATE TABLE financial_years (
  id             serial PRIMARY KEY,
  company_id     text NOT NULL REFERENCES companies(id),
  starts         date NOT NULL,
  ends           date NOT NULL,
  tally_company  text NOT NULL DEFAULT '',
  closed         boolean NOT NULL DEFAULT false,
  UNIQUE (company_id, starts),
  CHECK (ends > starts)
);

-- months that can't take new app vouchers (GST filed, year closed)
CREATE TABLE period_locks (
  company_id  text NOT NULL REFERENCES companies(id),
  month       date NOT NULL CHECK (extract(day FROM month) = 1),
  reason      text NOT NULL DEFAULT '',
  locked_by   text NOT NULL DEFAULT '',
  locked_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, month)
);

-- ---------------------------------------------------------------- chart of accounts

CREATE TABLE account_groups (
  id             bigserial PRIMARY KEY,
  company_id     text NOT NULL REFERENCES companies(id),
  name           text NOT NULL,
  parent         text NOT NULL DEFAULT '',   -- '' = primary group
  nature         text NOT NULL DEFAULT '' CHECK (nature IN ('', 'asset', 'liability', 'income', 'expense')),
  tally_guid     text NOT NULL DEFAULT '',
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, name)
);

CREATE TABLE ledgers (
  id             bigserial PRIMARY KEY,
  company_id     text NOT NULL REFERENCES companies(id),
  name           text NOT NULL,
  group_name     text NOT NULL DEFAULT '',
  gstin          text NOT NULL DEFAULT '',
  state          text NOT NULL DEFAULT '',
  pincode        text NOT NULL DEFAULT '',
  address        text[] NOT NULL DEFAULT '{}',
  mobile         text NOT NULL DEFAULT '',
  credit_days    integer,
  billwise       boolean NOT NULL DEFAULT false,
  customer_id    text,                        -- the app customer this ledger belongs to
  tally_guid     text NOT NULL DEFAULT '',
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, name)
);
CREATE INDEX ledgers_group ON ledgers (company_id, group_name);
CREATE INDEX ledgers_customer ON ledgers (customer_id);

CREATE TABLE ledger_openings (
  ledger_id  bigint NOT NULL REFERENCES ledgers(id),
  fy_id      integer NOT NULL REFERENCES financial_years(id),
  amount     numeric(16,2) NOT NULL DEFAULT 0,  -- > 0 Dr
  PRIMARY KEY (ledger_id, fy_id)
);

-- ---------------------------------------------------------------- inventory masters

CREATE TABLE stock_groups (
  company_id  text NOT NULL REFERENCES companies(id),
  name        text NOT NULL,
  parent      text NOT NULL DEFAULT '',
  PRIMARY KEY (company_id, name)
);

CREATE TABLE units (
  company_id  text NOT NULL REFERENCES companies(id),
  name        text NOT NULL,
  PRIMARY KEY (company_id, name)
);

CREATE TABLE godowns (
  company_id  text NOT NULL REFERENCES companies(id),
  name        text NOT NULL,
  parent      text NOT NULL DEFAULT '',
  PRIMARY KEY (company_id, name)
);

CREATE TABLE stock_items (
  id             bigserial PRIMARY KEY,
  company_id     text NOT NULL REFERENCES companies(id),
  name           text NOT NULL,
  group_name     text NOT NULL DEFAULT '',
  unit           text NOT NULL DEFAULT '',
  hsn            text NOT NULL DEFAULT '',
  gst_rate       numeric(5,2),
  selling_price  numeric(16,2),
  product_id     text,                        -- the app product this item is
  tally_guid     text NOT NULL DEFAULT '',
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, name)
);

-- ---------------------------------------------------------------- vouchers

CREATE TABLE voucher_types (
  company_id   text NOT NULL REFERENCES companies(id),
  name         text NOT NULL,                -- "Haier Sales", "App Receipt"…
  base_type    text NOT NULL,                -- Sales, Purchase, Receipt, Payment, Journal, Contra, Credit Note, Debit Note…
  numbering    text NOT NULL DEFAULT '',
  PRIMARY KEY (company_id, name)
);

CREATE TABLE vouchers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      text NOT NULL REFERENCES companies(id),
  fy_id           integer REFERENCES financial_years(id),
  vtype           text NOT NULL,             -- voucher type as in Tally
  base_type       text NOT NULL DEFAULT '',
  number          text NOT NULL DEFAULT '',
  vdate           date NOT NULL,
  party           text NOT NULL DEFAULT '',  -- party ledger name
  reference       text NOT NULL DEFAULT '',
  reference_date  date,
  narration       text NOT NULL DEFAULT '',
  details         jsonb NOT NULL DEFAULT '{}', -- buyer / consignee / dispatch / e-way bill…
  status          text NOT NULL DEFAULT 'posted' CHECK (status IN ('draft', 'posted', 'cancelled')),
  owner           text NOT NULL CHECK (owner IN ('tally', 'app')),
  tally_guid      text,                      -- Tally's voucher ID, once known
  tally_master_id text,
  entry_key       text UNIQUE,               -- app vouchers: the no-duplicate key
  reverses        uuid REFERENCES vouchers(id),
  is_current      boolean NOT NULL DEFAULT true,
  superseded_by   uuid REFERENCES vouchers(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      text NOT NULL DEFAULT '',
  updated_at      timestamptz NOT NULL DEFAULT now()
);
-- one current version of each Tally voucher per company
CREATE UNIQUE INDEX vouchers_tally_current ON vouchers (company_id, tally_guid) WHERE is_current AND tally_guid IS NOT NULL;
CREATE INDEX vouchers_date ON vouchers (company_id, vdate) WHERE is_current;
CREATE INDEX vouchers_party ON vouchers (company_id, party) WHERE is_current;

CREATE TABLE voucher_entries (
  id          bigserial PRIMARY KEY,
  voucher_id  uuid NOT NULL REFERENCES vouchers(id),
  line        integer NOT NULL,
  ledger      text NOT NULL,
  amount      numeric(16,2) NOT NULL CHECK (amount <> 0),   -- > 0 Dr, < 0 Cr
  is_party    boolean NOT NULL DEFAULT false,
  UNIQUE (voucher_id, line)
);
CREATE INDEX voucher_entries_ledger ON voucher_entries (ledger);

CREATE TABLE bill_allocations (
  id         bigserial PRIMARY KEY,
  entry_id   bigint NOT NULL REFERENCES voucher_entries(id),
  name       text NOT NULL,                 -- bill reference, or 'On Account'
  bill_type  text NOT NULL CHECK (bill_type IN ('New Ref', 'Agst Ref', 'Advance', 'On Account')),
  amount     numeric(16,2) NOT NULL,         -- > 0 Dr
  due_date   date
);
CREATE INDEX bill_allocations_name ON bill_allocations (name);

CREATE TABLE bank_allocations (
  id               bigserial PRIMARY KEY,
  entry_id         bigint NOT NULL REFERENCES voucher_entries(id),
  txn_type         text NOT NULL DEFAULT '', -- Cheque, e-Fund Transfer, Others…
  instrument_no    text NOT NULL DEFAULT '',
  instrument_date  date,
  bank_name        text NOT NULL DEFAULT '',
  cleared_on       date                      -- bank reconciliation
);

CREATE TABLE inventory_entries (
  id          bigserial PRIMARY KEY,
  voucher_id  uuid NOT NULL REFERENCES vouchers(id),
  line        integer NOT NULL,
  item        text NOT NULL,
  godown      text NOT NULL DEFAULT '',
  batch       text NOT NULL DEFAULT '',
  qty         numeric(16,3) NOT NULL DEFAULT 0,   -- > 0 in, < 0 out
  unit        text NOT NULL DEFAULT '',
  rate        numeric(16,4) NOT NULL DEFAULT 0,
  discount    numeric(6,2) NOT NULL DEFAULT 0,    -- %
  amount      numeric(16,2) NOT NULL DEFAULT 0,
  hsn         text NOT NULL DEFAULT '',
  gst_rate    numeric(5,2),
  description text[] NOT NULL DEFAULT '{}',
  UNIQUE (voucher_id, line)
);
CREATE INDEX inventory_entries_item ON inventory_entries (item);

CREATE TABLE voucher_tax_lines (
  voucher_id  uuid NOT NULL REFERENCES vouchers(id),
  hsn         text NOT NULL DEFAULT '',
  gst_rate    numeric(5,2) NOT NULL DEFAULT 0,
  taxable     numeric(16,2) NOT NULL DEFAULT 0,
  cgst        numeric(16,2) NOT NULL DEFAULT 0,
  sgst        numeric(16,2) NOT NULL DEFAULT 0,
  igst        numeric(16,2) NOT NULL DEFAULT 0,
  cess        numeric(16,2) NOT NULL DEFAULT 0,
  PRIMARY KEY (voucher_id, hsn, gst_rate)
);

-- order → invoice, invoice → receipt, invoice → credit note, voucher → reversal
CREATE TABLE voucher_links (
  from_kind  text NOT NULL,          -- 'order', 'voucher', 'receipt'…
  from_id    text NOT NULL,
  to_kind    text NOT NULL,
  to_id      text NOT NULL,
  relation   text NOT NULL,          -- 'invoiced-as', 'paid-by', 'returned-by', 'reverses'
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (from_kind, from_id, to_kind, to_id, relation)
);

-- every import from Tally: what came in and the totals it was checked against
CREATE TABLE sync_runs (
  id          bigserial PRIMARY KEY,
  company_id  text REFERENCES companies(id),
  kind        text NOT NULL,             -- 'masters', 'vouchers', 'balances'…
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  from_date   date,
  to_date     date,
  added       integer NOT NULL DEFAULT 0,
  changed     integer NOT NULL DEFAULT 0,
  totals      jsonb,                     -- our totals vs Tally's
  ok          boolean,
  error       text NOT NULL DEFAULT ''
);

-- ---------------------------------------------------------------- rules

-- 1. a posted voucher's lines must add up to zero (checked at the end of the transaction)
CREATE OR REPLACE FUNCTION voucher_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE vid uuid := COALESCE(NEW.voucher_id, OLD.voucher_id); diff numeric; st text;
BEGIN
  SELECT status INTO st FROM vouchers WHERE id = vid;
  IF st = 'posted' THEN
    SELECT COALESCE(sum(amount), 0) INTO diff FROM voucher_entries WHERE voucher_id = vid;
    IF diff <> 0 THEN
      RAISE EXCEPTION 'Voucher % does not balance (debit and credit differ by %)', vid, diff;
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER voucher_entries_balanced AFTER INSERT OR UPDATE ON voucher_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION voucher_balanced();

-- 2. a posted app voucher is never changed: only cancelled (corrections are new, linked vouchers);
--    a Tally voucher is only ever superseded by its newer version
CREATE OR REPLACE FUNCTION voucher_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'posted' THEN
    IF NEW.status = 'cancelled' AND NEW.vdate = OLD.vdate AND NEW.vtype = OLD.vtype AND NEW.number = OLD.number THEN
      NEW.updated_at := now(); RETURN NEW;
    END IF;
    IF OLD.owner = 'tally' AND OLD.is_current AND NOT NEW.is_current AND NEW.superseded_by IS NOT NULL THEN
      NEW.updated_at := now(); RETURN NEW;
    END IF;
    IF OLD.owner = 'app' AND OLD.tally_guid IS NULL AND NEW.tally_guid IS NOT NULL
       AND (NEW.vdate, NEW.vtype, NEW.party, NEW.status) IS NOT DISTINCT FROM (OLD.vdate, OLD.vtype, OLD.party, OLD.status) THEN
      NEW.updated_at := now(); RETURN NEW;   -- Tally confirmed it: store its voucher ID
    END IF;
    RAISE EXCEPTION 'Posted voucher % % can''t be changed: cancel it and enter a correction', OLD.vtype, OLD.number;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER vouchers_guard BEFORE UPDATE ON vouchers FOR EACH ROW EXECUTE FUNCTION voucher_guard();

-- lines of a posted voucher are fixed too
CREATE OR REPLACE FUNCTION voucher_lines_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st text;
BEGIN
  SELECT status INTO st FROM vouchers WHERE id = OLD.voucher_id;
  IF st IN ('posted', 'cancelled') THEN
    RAISE EXCEPTION 'Lines of a posted voucher can''t be changed';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER voucher_entries_guard BEFORE UPDATE ON voucher_entries FOR EACH ROW EXECUTE FUNCTION voucher_lines_guard();
CREATE TRIGGER inventory_entries_guard BEFORE UPDATE ON inventory_entries FOR EACH ROW EXECUTE FUNCTION voucher_lines_guard();

-- 3. no new app vouchers in a locked month
CREATE OR REPLACE FUNCTION voucher_period_open() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.owner = 'app' AND EXISTS (SELECT 1 FROM period_locks WHERE company_id = NEW.company_id AND month = date_trunc('month', NEW.vdate)::date) THEN
    RAISE EXCEPTION '% is locked for %: no new vouchers', to_char(NEW.vdate, 'Mon YYYY'), NEW.company_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER vouchers_period_open BEFORE INSERT ON vouchers FOR EACH ROW EXECUTE FUNCTION voucher_period_open();

-- 4. nothing is deleted
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['companies','financial_years','account_groups','ledgers','ledger_openings','stock_groups','units','godowns','stock_items',
                           'voucher_types','vouchers','voucher_entries','bill_allocations','bank_allocations','inventory_entries','voucher_tax_lines','voucher_links'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION no_delete()', t || '_no_delete', t);
  END LOOP;
END $$;
CREATE TRIGGER sync_runs_no_delete BEFORE DELETE ON sync_runs FOR EACH ROW EXECUTE FUNCTION no_delete();

-- ---------------------------------------------------------------- reports

-- current, posted vouchers only
CREATE VIEW live_entries AS
  SELECT v.company_id, v.id AS voucher_id, v.vdate, v.vtype, v.base_type, v.number, v.party, e.ledger, e.amount, e.is_party, e.id AS entry_id
  FROM vouchers v JOIN voucher_entries e ON e.voucher_id = v.id
  WHERE v.is_current AND v.status = 'posted';

-- each ledger's balance for a financial year: opening + movements (> 0 Dr)
CREATE VIEW ledger_balances AS
  SELECT l.company_id, fy.id AS fy_id, l.name AS ledger, l.group_name,
         COALESCE(o.amount, 0) AS opening,
         COALESCE((SELECT sum(x.amount) FROM live_entries x WHERE x.company_id = l.company_id AND x.ledger = l.name AND x.vdate BETWEEN fy.starts AND fy.ends), 0) AS movement,
         COALESCE(o.amount, 0) + COALESCE((SELECT sum(x.amount) FROM live_entries x WHERE x.company_id = l.company_id AND x.ledger = l.name AND x.vdate BETWEEN fy.starts AND fy.ends), 0) AS closing
  FROM ledgers l JOIN financial_years fy ON fy.company_id = l.company_id
  LEFT JOIN ledger_openings o ON o.ledger_id = l.id AND o.fy_id = fy.id;

-- trial balance per company and year
CREATE VIEW trial_balance AS
  SELECT company_id, fy_id, group_name, ledger,
         CASE WHEN closing > 0 THEN closing ELSE 0 END AS debit,
         CASE WHEN closing < 0 THEN -closing ELSE 0 END AS credit
  FROM ledger_balances WHERE closing <> 0;

-- pending bills (bill-wise outstanding): New Ref / Advance minus what was adjusted against them
CREATE VIEW bills_outstanding AS
  SELECT x.company_id, x.ledger, b.name AS bill,
         min(x.vdate) FILTER (WHERE b.bill_type IN ('New Ref', 'Advance')) AS bill_date,
         min(b.due_date) AS due_date,
         sum(b.amount) AS pending                       -- > 0 owed to us
  FROM bill_allocations b JOIN live_entries x ON x.entry_id = b.entry_id
  WHERE b.bill_type <> 'On Account'
  GROUP BY x.company_id, x.ledger, b.name
  HAVING sum(b.amount) <> 0;

-- stock on hand by item and godown
CREATE VIEW stock_on_hand AS
  SELECT v.company_id, i.item, i.godown, sum(i.qty) AS qty
  FROM inventory_entries i JOIN vouchers v ON v.id = i.voucher_id
  WHERE v.is_current AND v.status = 'posted'
  GROUP BY v.company_id, i.item, i.godown;
