-- 008 · Open bills exactly as Tally's Bills Receivable report shows them
-- (the same report the Windows app has always read). A new snapshot is kept
-- only when something changed; the newest one is used.
CREATE TABLE tally_bill_snapshots (
  id          bigserial PRIMARY KEY,
  company_id  text NOT NULL REFERENCES companies(id),
  taken_at    timestamptz NOT NULL DEFAULT now(),
  hash        text NOT NULL,
  bills       jsonb NOT NULL      -- [{ p: party, n: bill, d: date, due, a: amount (> 0 owed to us), od: days overdue }]
);
CREATE INDEX tally_bill_snapshots_latest ON tally_bill_snapshots (company_id, id DESC);
CREATE TRIGGER tally_bill_snapshots_no_delete BEFORE DELETE ON tally_bill_snapshots FOR EACH ROW EXECUTE FUNCTION no_delete();
CREATE TRIGGER tally_bill_snapshots_no_truncate BEFORE TRUNCATE ON tally_bill_snapshots FOR EACH STATEMENT EXECUTE FUNCTION no_truncate();

-- the year whose openings are stored (the one being mirrored): the latest year with any opening
CREATE OR REPLACE VIEW openings_year AS
  SELECT DISTINCT ON (l.company_id) l.company_id, o.fy_id
  FROM ledger_openings o JOIN ledgers l ON l.id = o.ledger_id JOIN financial_years f ON f.id = o.fy_id
  WHERE o.amount <> 0
  ORDER BY l.company_id, f.starts DESC;

CREATE OR REPLACE VIEW trial_balance_tally AS
  WITH first_fy AS (SELECT company_id, fy_id AS id FROM openings_year),
  ledgers AS (
    SELECT company_id, fy_id, group_name, ledger, debit, credit, 1 AS sort FROM trial_balance
  ),
  stock AS (
    SELECT s.company_id, s.fy_id, 'Stock-in-Hand'::text AS group_name, 'Opening Stock'::text AS ledger,
           GREATEST(sum(s.value), 0) AS debit, GREATEST(-sum(s.value), 0) AS credit, 2 AS sort
    FROM stock_openings s JOIN first_fy f ON f.company_id = s.company_id AND f.id = s.fy_id
    GROUP BY s.company_id, s.fy_id
  ),
  combined AS (SELECT * FROM ledgers UNION ALL SELECT * FROM stock),
  diff AS (
    SELECT b.company_id, b.fy_id, ''::text AS group_name, 'Difference in opening balances'::text AS ledger,
           GREATEST(sum(b.credit) - sum(b.debit), 0) AS debit, GREATEST(sum(b.debit) - sum(b.credit), 0) AS credit, 3 AS sort
    FROM combined b JOIN first_fy f ON f.company_id = b.company_id AND f.id = b.fy_id
    GROUP BY b.company_id, b.fy_id
    HAVING abs(sum(b.debit) - sum(b.credit)) >= 0.01
  )
  SELECT company_id, fy_id, group_name, ledger, debit, credit, sort FROM combined
  UNION ALL SELECT company_id, fy_id, group_name, ledger, debit, credit, sort FROM diff;
