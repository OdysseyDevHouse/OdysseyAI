-- The tender a held deposit becomes when the sale finally posts.
--
-- Its own tender, NOT cash, for exactly the reason 141 gives the EXCHANGE
-- tender: the money crossed the counter on an EARLIER day and was counted in
-- that days cash-up. Banking it as cash again would make the posting days
-- drawer claim takings that are not in it, while the deposit days drawer was
-- already right. counts_as_drawer_cash = 0 is the load-bearing flag.
--
-- allows_change = 0 is the other one. A deposit larger than the sale must never
-- hand back cash from a drawer that never received it, which is why
-- depositRules.tenderAtFinalise caps the tender at the document total and
-- leaves the excess to be refunded as its own event.
--
-- is_system = 1 so it cannot be renamed or switched off from the setup screen.
-- A store that turned this off would silently break every deposit already held.
--
-- Separate migration rather than an edit to 172, because 172 is already
-- recorded as applied and an edited .sql is never re-run.
INSERT INTO tender_types
  (code, name, posts_to_debtor, requires_customer, counts_as_drawer_cash,
   opens_cash_drawer, allows_change, allows_split, allows_refund,
   requires_reference, reference_label, rounds_to_cash_denomination,
   position, is_active, is_system)
SELECT 'DEPOSIT', 'Deposit paid', 0, 0, 0,
       0, 0, 1, 1,
       0, NULL, 0,
       96, 1, 1
WHERE NOT EXISTS (SELECT 1 FROM tender_types WHERE code = 'DEPOSIT');
