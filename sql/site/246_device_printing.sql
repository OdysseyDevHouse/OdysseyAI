-- ─────────────────────────────────────────────────────────────────────────
-- Printing — the shop's printers, how each MACHINE reaches them, and what
-- each machine prints where.
--
-- ── WHAT THIS GENERALISES ────────────────────────────────────────────────
--
-- 229_kitchen_printing.sql split "where does this food go" into three facts
-- that change at three different rates, and its reasoning was right about
-- more than food. Every document has the same three:
--
--   1. WHAT the printers are     — "Front counter", "Grill", "Office laser".
--                                  One list per shop.
--   2. WHERE each one actually IS — an IP on the LAN, or a USB queue whose
--                                  name only ONE machine knows.
--   3. WHAT COMES OUT OF WHICH   — the till slip here, the A4 invoice there,
--                                  and DIFFERENT ANSWERS ON EVERY MACHINE.
--
-- 229 solved this for kitchen tickets alone, keyed on the terminal. This file
-- widens it to every printable document and re-keys it on the machine, and
-- kitchen printing becomes one consumer of it rather than a parallel system.
--
-- ── (2) IS SPLIT IN TWO, AND THAT IS THE WHOLE DESIGN ────────────────────
--
-- A network printer at 192.168.1.50:9100 is reached IDENTICALLY from every
-- machine on the LAN. Held per-machine, moving it means editing every till.
-- So the address is site-wide, on the printer row: one IP change, one edit.
--
-- A USB printer has no site-wide answer at all — it is plugged into one
-- machine, and only that machine's row can say what the queue is called.
--
-- Hence `printers.connection` says which kind of answer exists, and
-- `device_printers` holds the answers only a machine can give. Resolution is
-- one sentence: A DEVICE ROW WINS; WITH NO DEVICE ROW THE SITE ANSWER
-- APPLIES; NEITHER MEANS THIS MACHINE CANNOT REACH IT.
--
-- ── WHY THE KEY IS A UUID AND NOT terminals.id ───────────────────────────
--
-- A back-office PC prints invoices, statements and purchase orders. It rings
-- up nothing, so it has no `terminals` row and never will — and it is exactly
-- the machine that needs to disagree with the till about where an A4 document
-- goes. What EVERY machine has is the id from lib/deviceId.ts: Electron's
-- userData UUID, or a generated one in this browser's localStorage.
-- user_offline_verifiers (067) already keys a site table on that same string
-- for the same reason, and this matches its VARCHAR(64).
--
-- ── THIS REPLACES 229's TABLES OUTRIGHT ──────────────────────────────────
--
-- Dropped and recreated rather than renamed-and-altered. There is no
-- production data on this feature yet, and the alternative is the 229 shape
-- with six ALTERs bolted on top — two readings of "the shop's printers" in
-- one schema is how they drift apart. A development site loses its product
-- routing; that is the price, and it is stated rather than discovered.
-- ─────────────────────────────────────────────────────────────────────────

-- Children first: every one of these holds a foreign key into the next.
DROP TABLE IF EXISTS kitchen_send_lines;
DROP TABLE IF EXISTS kitchen_sends;
DROP TABLE IF EXISTS terminal_kitchen_printers;   -- superseded by device_printers
DROP TABLE IF EXISTS product_kitchen_printers;
DROP TABLE IF EXISTS kitchen_printers;            -- becomes `printers`

-- ── 1. The shop's printers ───────────────────────────────────────────────
-- A LIBRARY, in the same spirit as instruction_groups: "Grill" is defined once
-- and pointed at by every steak, so opening a second grill is one row rather
-- than an edit to four hundred products.
CREATE TABLE printers (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  -- What staff call it. This is the name that prints at the top of a kitchen
  -- ticket, so it is the shop's word rather than a code.
  name         VARCHAR(60)  NOT NULL,
  -- Which pickers offer it. 'kitchen' rows are the ones a product's Kitchen tab
  -- lists; a back-office laser has no business in that picker. A FILTER, not a
  -- boundary — VARCHAR rather than ENUM for the same reason
  -- stationery_templates.doc_type is one: the set grows without a per-site ALTER.
  purpose      VARCHAR(16)  NOT NULL DEFAULT 'general',
  -- What is loaded in it: 'slip80' | 'slip58' | 'a4' | 'label'.
  --
  -- A PROPERTY OF THE HEAD, which is why it is here and not on the device. It
  -- lived per-machine as `columns: 42|48` in localStorage, so replacing one
  -- 80mm printer with a 58mm one meant editing every till that could reach it,
  -- and nothing in the back office could see the answer.
  paper        VARCHAR(16)  NOT NULL DEFAULT 'slip80',
  -- Overrides the width implied by `paper` (48 for slip80, 32 for slip58) for
  -- the heads that disagree with their own spec sheet. NULL is the ordinary case.
  slip_columns TINYINT UNSIGNED NULL,
  -- ── The site-wide way in ───────────────────────────────────────────────
  -- 'network'  raw TCP to target:port. THE SAME FROM EVERY MACHINE, which is
  --            the entire reason it lives here.
  -- 'device'   there is no site-wide answer; each machine says. A USB printer.
  connection   VARCHAR(16)  NOT NULL DEFAULT 'device',
  target       VARCHAR(190) NOT NULL DEFAULT '',   -- host or IP, for 'network'
  port         SMALLINT UNSIGNED NULL,             -- 9100 when omitted
  sort_order   INT          NOT NULL DEFAULT 0,
  -- Deactivated rather than deleted: tickets already sent point at this row,
  -- and a closed-down grill must not erase what it cooked last year.
  is_active    TINYINT(1)   NOT NULL DEFAULT 1,
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_printer_name (name),
  KEY ix_printer_active (is_active, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── 2. The machines ──────────────────────────────────────────────────────
--
-- NOT cp2_devices. That is the LICENCE record: it lives in the control
-- database, it is owned by the v2 backend, and a packaged desktop install
-- cannot reach it at all — pool() throws ControlDbUnavailableOnDesktop. This
-- table is a SITE fact about a machine standing in this shop, and the two are
-- joined by nothing. Do not one day write that join.
--
-- A surrogate INT id was rejected: every writer is a client that knows its own
-- UUID and nothing else, and an offline till has to resolve its own printing
-- config with the server gone.
--
-- No foreign key to `terminals`. The relationship runs the other way and is
-- optional — `terminals.device_id` already carries it, and a back-office PC has
-- no terminal at all. Readers LEFT JOIN so a till shows its code.
CREATE TABLE devices (
  device_id     VARCHAR(64)  NOT NULL,
  -- What a person calls it. Seeded from deviceLabel() — 'Desktop (win32)' — and
  -- renameable, because "Office PC" and "Back counter" are what a manager picks
  -- from when setting up a machine they are not sitting at.
  label         VARCHAR(120) NOT NULL DEFAULT '',
  -- 'desktop' | 'browser' | 'android' | 'unknown'. Decides whether this machine
  -- can reach a printer directly at all, which is what the screen has to say.
  kind          VARCHAR(16)  NOT NULL DEFAULT 'unknown',
  platform      VARCHAR(32)  NOT NULL DEFAULT '',
  -- 'backoffice' | 'pos' | 'database', from window.odyssey.role.
  app_role      VARCHAR(16)  NOT NULL DEFAULT '',
  -- Where this machine's PDFs land. Blank means the shell's own default
  -- (Documents\Odyssey). A directory rather than a per-document setting: it is
  -- a fact about the machine's disk, not about any one document.
  pdf_dir       VARCHAR(255) NOT NULL DEFAULT '',
  is_active     TINYINT(1)   NOT NULL DEFAULT 1,
  first_seen_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (device_id),
  KEY ix_devices_seen (is_active, last_seen_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── 3. How a machine reaches a printer ───────────────────────────────────
--
-- Only the things a MACHINE knows. A row here OVERRIDES the site answer above;
-- no row INHERITS it.
CREATE TABLE device_printers (
  device_id   VARCHAR(64)  NOT NULL,
  printer_id  INT UNSIGNED NOT NULL,
  -- 'usb'      an OS spool queue on this machine ('EPSON TM-T20III Receipt')
  -- 'network'  this machine reaches it at a DIFFERENT address (a second VLAN)
  -- 'none'     explicitly unreachable from here
  --
  -- 'none' is not the same as no row, and the difference is load-bearing: the
  -- patio till has no business printing to the grill, and "inherits the shop's
  -- answer" cannot say that. 229 expressed it as a MISSING row, which worked
  -- only because there was no site-wide answer to inherit.
  connection  VARCHAR(16)  NOT NULL,
  -- Their string, never ours — a spool name or a hostname. Free text for the
  -- reason 229 gave for bridge_printer: we do not validate against a list we do
  -- not own. What DOES validate it is the print engine, against the names the
  -- operating system itself reported.
  target      VARCHAR(190) NOT NULL DEFAULT '',
  -- The Windows SHARE name, for the fallback path when the raw-print helper is
  -- unavailable. Normally blank. Deliberately its own column rather than reusing
  -- `target`: the share name and the printer name are different strings, and a
  -- shop that conflates them gets an ENOENT that explains nothing.
  share_name  VARCHAR(190) NOT NULL DEFAULT '',
  port        SMALLINT UNSIGNED NULL,
  -- The cash drawer is wired to ONE printer on ONE machine, so it belongs on
  -- this pair rather than on the printer or on the device.
  drawer_kick TINYINT(1)   NOT NULL DEFAULT 0,
  updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (device_id, printer_id),
  KEY ix_dp_printer (printer_id),
  CONSTRAINT fk_dp_device  FOREIGN KEY (device_id)  REFERENCES devices (device_id) ON DELETE CASCADE,
  CONSTRAINT fk_dp_printer FOREIGN KEY (printer_id) REFERENCES printers (id)       ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── 4. What each machine prints where ────────────────────────────────────
--
-- The table the shop actually reads.
--
-- NO ROW IS THE ORDINARY STARTING STATE and means "not set" — the document
-- falls back to the browser's print dialog, which is what it does today. An
-- implicit "use the only slip printer" default was rejected for the reason
-- 229's screen already states about unmapped tills: a gap that silently works
-- is a gap nobody fixes until the day it stops.
CREATE TABLE device_document_printers (
  device_id  VARCHAR(64)  NOT NULL,
  -- A key from lib/printing/documents.ts. VARCHAR(40) matches
  -- stationery_templates.doc_type, and for the same stated reason: the set of
  -- documents grows, and it must grow without a schema change on every site.
  -- What keeps it honest is setDocumentPrinter(), which refuses a key the
  -- catalogue does not know.
  doc_key    VARCHAR(40)  NOT NULL,
  -- 'printer'  one of this shop's printers (printer_id set)
  -- 'pdf'      make a PDF and open it in the viewer (printer_id NULL)
  -- 'browser'  the browser's own print dialog — today's behaviour, and the only
  --            thing a browser or Android till can do
  -- 'off'      never print this here. A real answer rather than an absence: an
  --            office PC has no business printing kitchen tickets, and a blank
  --            row cannot say it.
  --
  -- PDF is a MODE and not a printer row. A `printers` row called "PDF" would
  -- appear in the kitchen picker, in every machine's connection list and in
  -- every rename dialog. One representation, in the place that decides.
  mode       VARCHAR(16)  NOT NULL DEFAULT 'printer',
  printer_id INT UNSIGNED NULL,
  copies     TINYINT UNSIGNED NOT NULL DEFAULT 1,
  updated_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (device_id, doc_key),
  KEY ix_ddp_printer (printer_id),
  CONSTRAINT fk_ddp_device  FOREIGN KEY (device_id)  REFERENCES devices (device_id) ON DELETE CASCADE,
  -- CASCADE, like the routing table below and unlike the send history: this is
  -- a live rule, and a deleted printer routes nowhere. Nothing is lost that was
  -- not already meaningless.
  CONSTRAINT fk_ddp_printer FOREIGN KEY (printer_id) REFERENCES printers (id)       ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── 5. Kitchen routing, recreated against `printers` ─────────────────────
--
-- Unchanged from 229 in shape and in reasoning — only the printer table it
-- points at has a new name. The comments there explain why routing is many per
-- product and why no rows means "never prints"; both still hold.
--
-- These keep their `kitchen_` names because they are genuinely kitchen-specific:
-- a product routes to a KITCHEN printer, and a send is a KITCHEN send. Only the
-- printer LIST was ever general, and that is the one that got renamed.
CREATE TABLE product_kitchen_printers (
  product_id INT UNSIGNED NOT NULL,
  printer_id INT UNSIGNED NOT NULL,
  PRIMARY KEY (product_id, printer_id),
  KEY ix_pkp_printer (printer_id),
  CONSTRAINT fk_pkp_product FOREIGN KEY (product_id)
    REFERENCES products (id) ON DELETE CASCADE,
  CONSTRAINT fk_pkp_printer FOREIGN KEY (printer_id)
    REFERENCES printers (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── 6. What has already been sent ────────────────────────────────────────
--
-- Verbatim from 229 but for the FK target. The delta rule it exists for — what
-- a printer is owed is `qty − SUM(what it has been sent)`, per LINE PER PRINTER,
-- with a cancellation written as a NEGATIVE send — is unchanged and is
-- documented at length in 229 and in lib/site/kitchenPrinters.ts.
CREATE TABLE kitchen_sends (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  document_id  INT UNSIGNED NOT NULL,
  printer_id   INT UNSIGNED NOT NULL,
  -- Which till put it on paper, and who pressed the key. The runner delivers to
  -- whoever sent it, so this is the SENDER rather than the tab's owner.
  terminal_id  INT UNSIGNED NULL,
  sent_by      INT UNSIGNED NULL,
  sent_by_name VARCHAR(120) NOT NULL DEFAULT '',
  -- 'auto' | 'manual' | 'cancel'. Worth keeping apart twice over: "the kitchen
  -- got it twice" is a different bug depending on which fired, and anything
  -- counting what was ORDERED must exclude cancellations or it nets them out.
  source       VARCHAR(16)  NOT NULL DEFAULT 'auto',
  sent_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_kitchen_sends_doc (document_id, printer_id),
  CONSTRAINT fk_ks_document FOREIGN KEY (document_id)
    REFERENCES sales_documents (id) ON DELETE CASCADE,
  -- RESTRICT, unlike the routing tables: this is history. A printer that has
  -- cooked food cannot be deleted out from under the record of it — the screen
  -- deactivates instead, which is why setPrinterActive never deletes.
  CONSTRAINT fk_ks_printer FOREIGN KEY (printer_id)
    REFERENCES printers (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE kitchen_send_lines (
  id      INT UNSIGNED NOT NULL AUTO_INCREMENT,
  send_id INT UNSIGNED NOT NULL,
  line_id INT UNSIGNED NOT NULL,
  -- What went on THAT ticket, not the line's total. SIGNED: a cancellation is a
  -- send of a negative quantity, which is what lets the delta stay one SUM with
  -- no special case anywhere. See 229 for the full argument.
  qty     DECIMAL(12,3) NOT NULL,
  PRIMARY KEY (id),
  KEY ix_ksl_line (line_id),
  CONSTRAINT fk_ksl_send FOREIGN KEY (send_id)
    REFERENCES kitchen_sends (id) ON DELETE CASCADE,
  CONSTRAINT fk_ksl_line FOREIGN KEY (line_id)
    REFERENCES sales_document_lines (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
