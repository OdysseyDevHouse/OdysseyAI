-- ─────────────────────────────────────────────────────────────────────────
-- A printer knows where it is. One question, asked once.
--
-- ── WHAT 246 GOT WRONG ───────────────────────────────────────────────────
--
-- It split "what the printer is" (shop-wide) from "how THIS machine reaches
-- it" (per-machine), so that a network printer's IP could be edited in one
-- place. The reasoning was sound and the result was confusing: every printer
-- asked the connection question TWICE. You said "USB" when you created it, and
-- then a second card asked "USB or a local queue?" about the same printer.
--
-- That second question earned its keep for exactly one case — a network printer
-- reachable at DIFFERENT addresses from different machines, a second VLAN — and
-- cost a redundant question on every printer a shop will ever add. Bad trade,
-- so it goes.
--
-- ── THE TWO WAYS A PRINTER IS REACHED, AND WHY BOTH STAY ─────────────────
--
--   'queue'    an OS print queue on ONE named machine. Covers a USB printer,
--              and equally a network printer somebody installed in Windows —
--              which is the common case, because that is how you print A4 to
--              it. Picked from a dropdown of the machine's real queues, so
--              nobody types a printer name.
--
--   'network'  raw TCP straight to an address. Needs NO driver installed
--              anywhere, and is reachable from every machine at once — which is
--              how a kitchen printer is usually wired in a restaurant that has
--              never installed a driver on any till.
--
-- Collapsing to only 'queue' would have forced a driver onto every till for a
-- shared kitchen printer. Collapsing to only 'network' would have lost USB
-- entirely. So: two options, one question.
--
-- ── A QUEUE IS PER-MACHINE, WHICH IS WHY device_id LIVES HERE NOW ────────
--
-- "EPSON TM-T70 Receipt" means something only on the machine where that queue
-- exists. So a 'queue' printer names its machine, and the document tables on
-- every OTHER machine simply do not offer it — greyed, with the reason, which
-- is a sentence rather than a puzzle.
--
-- The same physical model plugged into two tills is genuinely two printers.
-- Creating two rows for it is honest, and reads better than one row with a
-- per-machine override table behind it.
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE printers
  -- Which machine's queue, for connection = 'queue'. NULL for a network printer,
  -- which belongs to no machine in particular.
  --
  -- SET NULL rather than CASCADE on delete: forgetting a machine must not delete
  -- the shop's printer and take its product routing with it. The printer becomes
  -- unreachable and says so, which a person can fix by re-picking a queue.
  ADD COLUMN device_id  VARCHAR(64)  NULL AFTER connection,
  -- The Windows SHARE name, for the raw fallback when the helper cannot be
  -- spawned. Read from Get-Printer rather than typed, so it is right or absent.
  ADD COLUMN share_name VARCHAR(190) NOT NULL DEFAULT '' AFTER target,
  -- The cash drawer is wired to the RJ11 on ONE printer. It was on the
  -- per-machine table; with that gone it belongs on the printer itself, which is
  -- where the socket physically is.
  ADD COLUMN drawer_kick TINYINT(1)  NOT NULL DEFAULT 0 AFTER port,
  ADD KEY ix_printer_device (device_id),
  ADD CONSTRAINT fk_printer_device FOREIGN KEY (device_id)
    REFERENCES devices (device_id) ON DELETE SET NULL;

-- 246 wrote 'device' to mean "no shop-wide answer; ask each machine". With the
-- per-machine table gone there is nothing to ask, so those rows become queue
-- printers with no machine named yet — which is exactly what the screen shows
-- as "needs a printer picked", and what a person fixes in one click.
UPDATE printers SET connection = 'queue' WHERE connection <> 'network';

-- Superseded entirely. Its two useful columns (target, share_name) are above,
-- and its third (drawer_kick) with them.
--
-- Nothing to migrate: 246 shipped in this same change set and no shop has run
-- it. Left in place it would be a second, stale answer to "where does this
-- print" — which is how two readings of one fact drift apart.
DROP TABLE IF EXISTS device_printers;
