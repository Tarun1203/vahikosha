-- 005 · Opening stock (as Tally keeps it, on the stock items, not on a ledger)
-- and a trial balance that reads like Tally's: ledger balances, plus
-- "Opening Stock" and "Difference in opening balances" in the first year of the books.

CREATE TABLE stock_openings (
  company_id  text NOT NULL REFERENCES companies(id),
  fy_id       integer NOT NULL REFERENCES financial_years(id),
  item        text NOT NULL,
  qty         numeric(16,3) NOT NULL DEFAULT 0,
  value       numeric(16,2) NOT NULL DEFAULT 0,   -- > 0 Dr
  PRIMARY KEY (company_id, fy_id, item)
);
CREATE TRIGGER stock_openings_no_delete BEFORE DELETE ON stock_openings FOR EACH ROW EXECUTE FUNCTION no_delete();
CREATE TRIGGER stock_openings_no_truncate BEFORE TRUNCATE ON stock_openings FOR EACH STATEMENT EXECUTE FUNCTION no_truncate();

CREATE VIEW trial_balance_tally AS
  WITH first_fy AS (SELECT DISTINCT ON (company_id) company_id, id FROM financial_years ORDER BY company_id, starts),
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
    -- whatever the openings leave unbalanced, as Tally shows it
    SELECT b.company_id, b.fy_id, ''::text AS group_name, 'Difference in opening balances'::text AS ledger,
           GREATEST(sum(b.credit) - sum(b.debit), 0) AS debit, GREATEST(sum(b.debit) - sum(b.credit), 0) AS credit, 3 AS sort
    FROM combined b JOIN first_fy f ON f.company_id = b.company_id AND f.id = b.fy_id
    GROUP BY b.company_id, b.fy_id
    HAVING abs(sum(b.debit) - sum(b.credit)) >= 0.01
  )
  SELECT company_id, fy_id, group_name, ledger, debit, credit, sort FROM combined
  UNION ALL SELECT company_id, fy_id, group_name, ledger, debit, credit, sort FROM diff;
