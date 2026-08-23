-- ─────────────────────────────────────────────────────────────────────────
-- Kitchen printing — where a product goes, and what has already gone there.
--
-- ── THE THREE LAYERS, AND WHY THEY ARE SEPARATE ──────────────────────────
--
-- A restaurant says "the Bar prints the drinks". That one sentence hides
-- three different facts that change at three different rates:
--
--   1. WHAT the printers are      — "Bar", "Kitchen", "Grill". One list per
--                                   shop. Changes when the shop is rebuilt.
--   2. WHICH products go to each  — Castle Lager to the Bar. Changes whenever
--                                   the menu changes, which is weekly.
--   3. WHERE the Bar actually IS  — TILL01 spools to EPSON-BAR on the back
--                                   office PC. Changes when a printer is
--                                   replaced, and DIFFERS ON EVERY TILL.
--
-- Held as one thing, (3) poisons the other two: a shop that re-images a till
-- would have to re-assign every product on the menu. So the logical printer
-- is a row here, the routing is a link table, and the physical address is
-- per-terminal — three tables, each changed by the person who owns it.
--
-- ── WHY NOT REUSE THE BRIDGE'S localStorage SLOTS ────────────────────────
--
-- printBridge.ts held exactly two names, `receiptPrinter` and
-- `kitchenPrinter`, in the machine's own localStorage. Two literal fields
-- cannot express a shop with a bar and a grill; and localStorage means a
-- manager cannot see — let alone fix — a till's routing from the back office,
-- while a re-imaged machine silently forgets where its food goes. The mapping
-- therefore lives on the terminal ROW, beside pos_mode and stock_location_id,
-- which are per-till for exactly the same reason.
-- ─────────────────────────────────────────────────────────────────────────

-- ── 1. The logical printers ──────────────────────────────────────────────
-- A LIBRARY, in the same spirit as instruction_groups: "Bar" is defined once
-- and pointed at by every drink, so opening a second bar is one row rather
-- than an edit to four hundred products.
CREATE TABLE kitchen_printers (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  -- What staff call it. This is the name that prints at the top of the
  -- ticket, so it is the shop's word rather than a code.
  name       VARCHAR(60)  NOT NULL,
  sort_order INT          NOT NULL DEFAULT 0,
  -- Deactivated rather than deleted: tickets already sent point at this row,
  -- and a closed-down grill must not erase what it cooked last year.
  is_active  TINYINT(1)   NOT NULL DEFAULT 1,
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_kitchen_printer_name (name),
  KEY ix_kitchen_printer_active (is_active, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── 2. Which products go where ───────────────────────────────────────────
-- MANY per product, deliberately: a shop with a service bar wants the food
-- runner's docket AND the bar's copy of the same round, and the answer is two
-- tickets rather than one shared queue.
--
-- NO ROWS IS THE ORDINARY CASE AND MEANS "NEVER PRINTS". There is no default
-- printer and no fallback. A retail line on a hospitality till — a bag of ice,
-- a T-shirt — has nothing to tell a kitchen, and inventing a destination for
-- it would put paper in front of a chef for every till roll sold.
CREATE TABLE product_kitchen_printers (
  product_id INT UNSIGNED NOT NULL,
  printer_id INT UNSIGNED NOT NULL,
  PRIMARY KEY (product_id, printer_id),
  KEY ix_pkp_printer (printer_id),
  CONSTRAINT fk_pkp_product FOREIGN KEY (product_id)
    REFERENCES products (id) ON DELETE CASCADE,
  -- CASCADE here, unlike the send history below: this row is a live routing
  -- rule, and a deleted printer routes nowhere. Nothing is lost that was not
  -- already meaningless.
  CONSTRAINT fk_pkp_printer FOREIGN KEY (printer_id)
    REFERENCES kitchen_printers (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── 3. Where each till actually sends it ─────────────────────────────────
-- `bridge_printer` is the print bridge's own name for a spool queue, as
-- reported by its /health endpoint. Free text because it is THEIR string, not
-- ours — we never validate it against a list we do not own.
--
-- A missing row means this till cannot reach that printer. That is a real
-- state rather than a misconfiguration: the patio till has no business
-- printing to the grill, and the send path skips what it cannot reach rather
-- than failing the whole ticket.
CREATE TABLE terminal_kitchen_printers (
  terminal_id    INT UNSIGNED NOT NULL,
  printer_id     INT UNSIGNED NOT NULL,
  bridge_printer VARCHAR(190) NOT NULL,
  updated_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (terminal_id, printer_id),
  KEY ix_tkp_printer (printer_id),
  CONSTRAINT fk_tkp_terminal FOREIGN KEY (terminal_id)
    REFERENCES terminals (id) ON DELETE CASCADE,
  CONSTRAINT fk_tkp_printer FOREIGN KEY (printer_id)
    REFERENCES kitchen_printers (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── 4. What has already been sent ────────────────────────────────────────
--
-- ── WHY THIS REPLACES sales_document_lines.kitchen_sent_qty ──────────────
--
-- 142_kitchen_send.sql held one scalar per line: qty sent, delta = qty minus
-- it. That was right while every ticket went to one printer, and becomes
-- WRONG the moment a line can go to two. A steak routed to Grill and Kitchen
-- is sent twice, and the scalar can only count one of them — so either the
-- second printer never gets it, or marking the first blinds the second.
--
-- The delta is therefore per LINE PER PRINTER: qty − SUM(sent to that
-- printer). One scalar cannot say that; rows can.
--
-- The rows earn themselves twice over. "Did the bar ever get this round" is a
-- question a manager asks during an argument, and a ticket that can be
-- identified can be reprinted exactly as it went out — neither of which a
-- counter that only goes up can answer.
CREATE TABLE kitchen_sends (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  document_id  INT UNSIGNED NOT NULL,
  printer_id   INT UNSIGNED NOT NULL,
  -- Which till put it on paper, and who pressed the key. The runner delivers
  -- to whoever sent it, so this is the SENDER rather than the tab's owner.
  terminal_id  INT UNSIGNED NULL,
  sent_by      INT UNSIGNED NULL,
  sent_by_name VARCHAR(120) NOT NULL DEFAULT '',
  -- How the ticket was raised:
  --   'auto'   the automatic send when a tab is saved, closed or finalised
  --   'manual' a waiter pressing send-to-kitchen, possibly for one course
  --   'cancel' a VOID telling the kitchen to stop — see the qty note below
  -- Worth keeping apart twice over: "the kitchen got it twice" is a different
  -- bug depending on which fired, and anything counting what was ORDERED must
  -- exclude cancellations or it will net them out silently.
  source       VARCHAR(16)  NOT NULL DEFAULT 'auto',
  sent_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_kitchen_sends_doc (document_id, printer_id),
  CONSTRAINT fk_ks_document FOREIGN KEY (document_id)
    REFERENCES sales_documents (id) ON DELETE CASCADE,
  -- RESTRICT, unlike the routing table: this is history. A printer that has
  -- cooked food cannot be deleted out from under the record of it — the
  -- screen deactivates instead.
  CONSTRAINT fk_ks_printer FOREIGN KEY (printer_id)
    REFERENCES kitchen_printers (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE kitchen_send_lines (
  id      INT UNSIGNED NOT NULL AUTO_INCREMENT,
  send_id INT UNSIGNED NOT NULL,
  line_id INT UNSIGNED NOT NULL,
  -- What went on THAT ticket, not the line's total. Summing this column per
  -- (line, printer) is the whole delta rule.
  --
  -- SIGNED, and deliberately so: a cancellation is a send of a NEGATIVE
  -- quantity (source='cancel'). That is what lets the delta stay one SUM with
  -- no special case anywhere — an item sent then cancelled nets to zero, so the
  -- kitchen is owed it again if the customer changes their mind back, and
  -- cancelling 2 of 5 leaves the 3 they legitimately had. The cancel path
  -- clamps to what was actually sent, so the net can never go below zero.
  qty     DECIMAL(12,3) NOT NULL,
  PRIMARY KEY (id),
  KEY ix_ksl_line (line_id),
  CONSTRAINT fk_ksl_send FOREIGN KEY (send_id)
    REFERENCES kitchen_sends (id) ON DELETE CASCADE,
  CONSTRAINT fk_ksl_line FOREIGN KEY (line_id)
    REFERENCES sales_document_lines (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The scalar this supersedes. Dropped rather than left in place: two readings
-- of "what has the kitchen seen" is how they drift apart, and there is no
-- production data to preserve.
ALTER TABLE sales_document_lines
  DROP COLUMN IF EXISTS kitchen_sent_qty,
  DROP COLUMN IF EXISTS kitchen_sent_at;
