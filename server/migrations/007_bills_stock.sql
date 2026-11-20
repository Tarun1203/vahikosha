-- 007 · Bills carried in from before the books began (Tally keeps them on the
-- ledger, not in vouchers), and Tally's own closing stock per item (Tally's
-- stock rules — delivery notes, tracking — decide it, so it's taken as Tally says).

CREATE TABLE opening_bills (
  company_id  text NOT NULL REFERENCES companies(id),
  ledger      text NOT NULL,
  name        text NOT NULL,
  bill_date   date,
  due_date    date,
  amount      numeric(16,2) NOT NULL,      -- > 0 Dr
  PRIMARY KEY (company_id, ledger, name)
);
CREATE TRIGGER opening_bills_no_delete BEFORE DELETE ON opening_bills FOR EACH ROW EXECUTE FUNCTION no_delete();
CREATE TRIGGER opening_bills_no_truncate BEFORE TRUNCATE ON opening_bills FOR EACH STATEMENT EXECUTE FUNCTION no_truncate();

ALTER TABLE stock_items ADD COLUMN closing_qty numeric(16,3), ADD COLUMN closing_value numeric(16,2), ADD COLUMN closing_at timestamptz;

CREATE OR REPLACE VIEW bills_outstanding AS
  WITH alloc AS (
    SELECT x.company_id, x.ledger, b.name, b.bill_type, b.amount, b.due_date, x.vdate
      FROM bill_allocations b JOIN live_entries x ON x.entry_id = b.entry_id
      WHERE b.bill_type <> 'On Account'
    UNION ALL
    SELECT company_id, ledger, name, 'New Ref', amount, due_date, bill_date FROM opening_bills
  )
  SELECT company_id, ledger, name AS bill,
         min(vdate) FILTER (WHERE bill_type IN ('New Ref', 'Advance')) AS bill_date,
         min(due_date) AS due_date,
         sum(amount) AS pending
  FROM alloc
  GROUP BY company_id, ledger, name
  HAVING sum(amount) <> 0;
