-- A special's window is a WALL CLOCK, not an instant.
--
-- ── WHY THESE ARE NOT DATETIME ──────────────────────────────────────────
--
-- The site pools connect with `timezone: 'Z'`, so mysql2 treats every
-- DATETIME as UTC and converts it to local on the way out. That is right for
-- an EVENT — a sale happened at a moment in time, and everyone should agree
-- which moment.
--
-- A special is the opposite. "The happy hour starts at five" means five on the
-- shop's own clock; it does not describe an instant, and it must not move when
-- the server's timezone differs from the shop's. Stored as DATETIME the window
-- came back two hours out in South Africa: a special written to start at 07:30
-- read back as 09:30 and simply never ran.
--
-- So the window is stored as the text a shopkeeper typed. VARCHAR sorts
-- correctly for 'YYYY-MM-DDTHH:mm', which is all the comparison this needs —
-- the daily band and day mask beside it are already text for the same reason.

ALTER TABLE specials
  MODIFY COLUMN starts_at VARCHAR(16) NOT NULL,
  MODIFY COLUMN ends_at   VARCHAR(16) NOT NULL;

-- Anything written before this migration went in through the shifting path,
-- so normalise the separator. The two-hour offset on existing rows is not
-- corrected: there are none in the wild yet, and guessing which way to shift a
-- row whose origin is unknown would be worse than leaving it visible.
UPDATE specials SET starts_at = REPLACE(starts_at, ' ', 'T') WHERE starts_at LIKE '% %';
UPDATE specials SET ends_at   = REPLACE(ends_at,   ' ', 'T') WHERE ends_at   LIKE '% %';
