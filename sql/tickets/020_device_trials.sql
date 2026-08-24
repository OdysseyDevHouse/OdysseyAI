-- ============================================================================
-- 020_device_trials.sql — a machine may licence itself once, for thirty days
-- ============================================================================
--
-- Until now a till could only ever be REFUSED. Registering one was a
-- supervisor's act in Setup → Tills, against a licence somebody at Odyssey had
-- already provisioned, and the refusal screen's whole job was to tell the person
-- standing at the counter to go and fetch that supervisor.
--
-- That is the right shape for a shop that has PAID for tills. It is the wrong
-- shape for one that has not yet — a new customer, or an existing one who bought
-- back-office modules and no POS, has nothing to be linked TO, so the screen
-- sends them to a panel that is empty and a supervisor who cannot help.
--
-- So the door now has two things it can offer, both of which stay inside the
-- entitlement the shop already has:
--
--   1. A FREE PAID SLOT. The shop pays for N tills and fewer than N are in use;
--      this machine takes one. Creates nothing the shop is not already billed
--      for, which is why it needs no approval.
--   2. A TRIAL. No paid slot is free (often because N is zero), and this machine
--      has never had one. It gets a row with `is_paid = 0` and an `expiry_date`
--      thirty days out, and trades until that day passes.
--
-- The trial needs no new entitlement code: `entitlement()` in
-- src/lib/control/devices.ts has always read "unpaid but inside its evaluation
-- period" as allowed. What was missing was any way for a row like that to come
-- into existence without somebody at Odyssey typing it.
--
-- ── WHY A SEPARATE TABLE AND NOT JUST "LOOK FOR A TRIAL ROW" ────────────────
--
-- Because the licence row is not permanent. A trial that lapses gets unlinked,
-- retired, or reassigned to a paid slot, and every one of those either clears
-- `serial_number` or changes the row out of recognition. Deciding "has this
-- machine already had its thirty days" from a mutable register means the answer
-- changes when somebody tidies up, and the machine gets a second trial for free.
--
-- This table is therefore APPEND-ONLY and nothing deletes from it. It is not the
-- licence — cp2_devices is — it is the record that the offer was made.
--
-- ── SCOPED (site, serial), NOT SERIAL ALONE ─────────────────────────────────
--
-- The same scope every other licence question in this system uses: a machine may
-- hold one licence in each store it works, because an operator with two linked
-- stores runs both from one back-office PC and each store's licence is
-- separately sold. A trial keyed on the serial alone would give that operator
-- thirty days across both stores rather than thirty days in each, which is a
-- different product to the one being described.
--
-- The cost, stated plainly: a shop willing to create a second site can take a
-- second trial, and a machine whose device id is wiped looks like a new machine.
-- Neither is worth defending against here — the serial arrives from the client
-- and was never a credential (see the note in deviceActions.ts). What this DOES
-- stop is the ordinary case: pressing the button again next month.

CREATE TABLE IF NOT EXISTS cp2_device_trials (
  site_id       INT UNSIGNED NOT NULL,
  -- The machine that took it. Matches cp2_devices.serial_number at the moment
  -- the trial started; it is NOT kept in step afterwards, deliberately — this
  -- records what happened, not what is currently true.
  serial_number VARCHAR(100) NOT NULL,
  -- The licence row this created, for tracing one back to the other. Nullable
  -- and never enforced: the device row may legitimately be retired later, and a
  -- foreign key would either block that or delete the evidence.
  device_id     INT UNSIGNED NULL,
  started_on    DATE NOT NULL,
  ends_on       DATE NOT NULL,
  -- Who was signed in when it was taken. A trial is free, so this is for support
  -- to read rather than anything to enforce against.
  started_by    VARCHAR(120) NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- One trial per machine per store, forever. This is the whole enforcement.
  PRIMARY KEY (site_id, serial_number),
  KEY ix_cp2_device_trials_serial (serial_number)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── THE TWO PAID NUMBERS, RECONCILED ────────────────────────────────────────
--
-- `cp2_sites.paid_device_count` is what the customer's subscription actually
-- covers, written by the v2 backend when they pay.
-- `cp2_site_device_orders.requested` is what the billing screen in THIS app
-- recorded, and is what `provisionDevices` creates licences from.
--
-- They already disagree, and not because anybody changed one: migration 009
-- seeded `requested` by counting cp2_devices, which was empty, so every site got
-- the floor of 1 — including a site whose subscription says 2. Leaving that
-- would mean a shop paying for two tills being offered one.
--
-- So `requested` is re-seeded from the subscription HERE, and from this point
-- the flow runs the other way: the billing screen sets `requested`, and
-- `provisionDevices` mirrors it back onto `paid_device_count` when payment
-- confirms. One number, one direction, no drift.
--
-- Only rows migration 009 wrote are touched. Anybody who has since used the
-- billing screen has made a real decision, and this must not overwrite it.
UPDATE cp2_site_device_orders o
  JOIN cp2_sites s ON s.id = o.site_id
   SET o.requested  = COALESCE(s.paid_device_count, 0),
       o.updated_by = 'migration 020'
 WHERE o.updated_by = 'migration 009';

-- A site the v2 backend created after 009 ran has a subscription and no order
-- row. Give it one that matches, so the billing screen and the till door read
-- the same number the day the site is opened.
INSERT INTO cp2_site_device_orders (site_id, requested, updated_by)
SELECT s.id, COALESCE(s.paid_device_count, 0), 'migration 020'
  FROM cp2_sites s
 WHERE s.status IN ('active', 'suspended')
ON DUPLICATE KEY UPDATE requested = requested;

-- ── ZERO IS NOW A LEGAL ANSWER ──────────────────────────────────────────────
--
-- 009 refused it: "the Starter Pack includes a till, so nobody is billed for it
-- either way, and 0 would read as 'this shop cannot sell'". That reasoning
-- assumed every customer has a POS. Some buy jobs, or invoicing, or stock, and
-- never ring up a sale — and telling one of those they are entitled to a till
-- they have not bought is how a shop ends up trading on a licence nobody sold.
--
-- Zero is now what the trial exists to answer: no paid slot, so the door offers
-- thirty days instead. The floor is dropped in setRequestedDevices(); the
-- billing screen already prices max(0, requested - 1), so it needs no change.
