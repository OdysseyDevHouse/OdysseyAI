-- Exchange at the till: the credit from a return pays for the replacement sale.
--
-- Its own tender, NOT cash: for the netted part of an exchange no money crosses
-- the counter, so banking it as cash would make every exchange-day cash-up
-- claim takings that are not in the drawer. counts_as_drawer_cash = 0 is the
-- load-bearing flag (the ONLINE tender's precedent, 038), and allows_refund = 1
-- is what lets the credit note pay INTO it.
--
-- Per shift the EXCHANGE tender nets to zero across the pair of documents:
-- the credit note refunds −C by EXCHANGE, the new sale tenders +C by EXCHANGE,
-- and the drawer carries only the difference in real money.
INSERT INTO tender_types
  (code, name, posts_to_debtor, requires_customer, counts_as_drawer_cash,
   opens_cash_drawer, allows_change, allows_split, allows_refund,
   requires_reference, reference_label, rounds_to_cash_denomination,
   position, is_active, is_system)
SELECT 'EXCHANGE', 'Exchange credit', 0, 0, 0,
       0, 0, 1, 1,
       1, 'Credit note number', 0,
       95, 1, 1
WHERE NOT EXISTS (SELECT 1 FROM tender_types WHERE code = 'EXCHANGE');
