-- A credit note against an online-paid order records its refund on the
-- ONLINE tender (the 141 exchange-tender precedent). Recording only: the
-- actual gateway refund is a person in the PayFast dashboard in v1, and the
-- reference field on the credit note is where its confirmation goes.
UPDATE tender_types SET allows_refund = 1 WHERE code = 'ONLINE';
