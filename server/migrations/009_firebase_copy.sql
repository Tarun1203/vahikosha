-- 009 · While Firebase is still the live database, the server keeps PostgreSQL
-- an up-to-date copy of it (records, history, and the Tally figures the
-- Windows app uploads). Nothing here is ever deleted.

-- the Tally figures exactly as the Windows app uploads them to Firebase
-- (balances / tallyVouchers / tallyBills / tallyStock, one row per company,
-- plus balances/status), so every company the Windows app syncs is included
CREATE TABLE fb_tally (
  kind       text NOT NULL CHECK (kind IN ('balances', 'tallyVouchers', 'tallyBills', 'tallyStock')),
  key        text NOT NULL,              -- company key ("business", "cash", "co…") or "status"
  data       jsonb NOT NULL,
  copied_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, key)
);
CREATE TRIGGER fb_tally_no_delete BEFORE DELETE ON fb_tally FOR EACH ROW EXECUTE FUNCTION no_delete();

-- how far each Firebase collection has been copied (its newest change time)
CREATE TABLE fb_copy_state (
  coll       text PRIMARY KEY,
  last_seen  timestamptz,                -- newest updatedAt / at copied
  last_run   timestamptz,
  copied     integer NOT NULL DEFAULT 0  -- records copied in total
);
CREATE TRIGGER fb_copy_state_no_delete BEFORE DELETE ON fb_copy_state FOR EACH ROW EXECUTE FUNCTION no_delete();
