-- ─────────────────────────────────────────────────────────────────────────
-- What money this shop takes.
--
-- `formatMoney` has always defaulted to 'R' and `productJsonLd` has always
-- said 'ZAR', neither of them reading anything. That is a ceiling on who can
-- buy the product rather than a bug in it — but it is the kind of ceiling that
-- gets more expensive every month it stays, because the default is now written
-- into a thousand call sites across invoices, statements, printed documents
-- and the till.
--
-- ── THE STOREFRONT ONLY, AND THAT IS SAID OUT LOUD ───────────────────────
--
-- These two columns are read by the SHOP and by nothing else. The back office,
-- the POS and every printed document keep the Rand default, because threading
-- a currency through their thousand call sites is a different piece of work
-- with a different risk profile — it touches what a till prints on a slip and
-- what an invoice says it is owed.
--
-- So this is honest rather than complete: a shop can sell in another currency
-- to its online customers, and its own paperwork still says R. Anyone widening
-- it later starts here.
--
-- ── A SYMBOL AND A CODE, BECAUSE THEY ARE DIFFERENT ANSWERS ──────────────
--
-- The symbol is what a shopper reads on a tile: "R", "$", "£". The code is what
-- a machine reads — schema.org's priceCurrency, and a payment gateway's
-- expectation — and it is an ISO 4217 three-letter code. Deriving one from the
-- other is guesswork in both directions: "$" is eight different currencies, and
-- nothing about "ZAR" says the symbol goes before the number.
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE online_store_settings
  -- ISO 4217. Read by structured data and, later, by a payment gateway.
  ADD COLUMN IF NOT EXISTS currency_code VARCHAR(3) NOT NULL DEFAULT 'ZAR',
  -- What a shopper sees. Short, because it sits against a number.
  ADD COLUMN IF NOT EXISTS currency_symbol VARCHAR(4) NOT NULL DEFAULT 'R';
