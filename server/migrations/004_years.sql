-- 004 · Balances across financial years, the way Tally carries them:
--   balance-sheet ledgers (parties, cash, bank…) carry their closing into the next year;
--   income and expense ledgers start each year at zero.
-- ledger_openings holds each ledger's opening at the start of the books (Tally's
-- "Opening Balance"); later years are worked out from it.

-- a changed Tally voucher is replaced in one transaction: the old version points
-- to the new one, which is inserted just after it
ALTER TABLE vouchers ALTER CONSTRAINT vouchers_superseded_by_fkey DEFERRABLE INITIALLY DEFERRED;

-- is the ledger's group income/expense (resets yearly)?
CREATE OR REPLACE VIEW ledger_kind AS
  SELECT l.id, l.company_id, l.name, l.group_name,
         COALESCE(g.nature, '') AS nature,
         COALESCE(g.nature IN ('income', 'expense'), false) AS revenue
  FROM ledgers l LEFT JOIN account_groups g ON g.company_id = l.company_id AND g.name = l.group_name;

DROP VIEW IF EXISTS trial_balance;
DROP VIEW IF EXISTS ledger_balances;

CREATE VIEW ledger_balances AS
  WITH books AS (SELECT company_id, min(starts) AS starts FROM financial_years GROUP BY company_id)
  SELECT k.company_id, fy.id AS fy_id, fy.starts, fy.ends, k.name AS ledger, k.group_name, k.nature,
         -- opening of this year
         CASE WHEN k.revenue THEN 0
              ELSE COALESCE((SELECT sum(o.amount) FROM ledger_openings o WHERE o.ledger_id = k.id), 0)
                 + COALESCE((SELECT sum(x.amount) FROM live_entries x WHERE x.company_id = k.company_id AND x.ledger = k.name AND x.vdate < fy.starts), 0)
         END AS opening,
         COALESCE((SELECT sum(x.amount) FROM live_entries x WHERE x.company_id = k.company_id AND x.ledger = k.name AND x.vdate BETWEEN fy.starts AND fy.ends), 0) AS movement
  FROM ledger_kind k JOIN financial_years fy ON fy.company_id = k.company_id;

CREATE VIEW ledger_closing AS
  SELECT company_id, fy_id, starts, ends, ledger, group_name, nature, opening, movement, opening + movement AS closing FROM ledger_balances;

CREATE VIEW trial_balance AS
  SELECT company_id, fy_id, group_name, ledger,
         CASE WHEN closing > 0 THEN closing ELSE 0 END AS debit,
         CASE WHEN closing < 0 THEN -closing ELSE 0 END AS credit
  FROM ledger_closing WHERE closing <> 0;
