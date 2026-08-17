-- How many till licences a store is PAYING for.
--
-- ── WHY THIS IS NOT JUST COUNTING cp2_devices ──────────────────────────────
--
-- cp2_devices is the licence register: one row per till that may trade. It is
-- owned by the v2 backend, and this repo never creates rows in it — it reads
-- entitlement and writes a serial when a machine claims a spot. So the billing
-- screen cannot provision a licence by wanting one.
--
-- What it CAN do is record the order. The stepper on the billing screen writes
-- the number here; payment confirms it; and only then does something create the
-- matching cp2_devices row. That ordering is the whole point — a stepper that
-- provisioned on save would let a shop licence extra tills for free by dragging
-- a number, which is the same hole as billing being disconnected from
-- enforcement, just pointing the other way.
--
-- ── THE TWO NUMBERS ARE ALLOWED TO DIFFER, BUT NEVER SILENTLY ──────────────
--
-- requested = what the shop is billed for, here.
-- provisioned = what may actually trade, counted from cp2_devices.
--
-- Between ordering and payment they differ legitimately. The billing screen
-- shows both and flags the gap. What the previous system did — bill one number,
-- enforce another, and reconcile neither — is exactly what this makes visible.
CREATE TABLE IF NOT EXISTS cp2_site_device_orders (
  site_id      INT UNSIGNED NOT NULL,
  -- Tills this store is paying for, including the one the Starter Pack covers.
  -- The billing screen charges for (requested - 1).
  requested    SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  -- Set when the count went UP and has not been paid for yet. Cleared once
  -- payment confirms and the licences are provisioned. A reduction needs no
  -- confirmation — giving a licence back is not a purchase.
  pending_from DATE NULL,
  updated_by   VARCHAR(120) NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  -- One row per site: this is a current count, not a history. What was ordered
  -- and when is in cp2_module_change_log.
  PRIMARY KEY (site_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Seed from what each site already has provisioned, so the screen opens showing
-- the truth rather than every store asking for one till. Sites with no licences
-- get 1: the Starter Pack includes a till, so nobody is billed for it either
-- way, and 0 would read as "this shop cannot sell".
INSERT INTO cp2_site_device_orders (site_id, requested, updated_by)
SELECT s.id,
       GREATEST(1, COALESCE((
         SELECT COUNT(*) FROM cp2_devices d
          WHERE d.site_id = s.id
            AND d.status = 'active'
            AND (d.is_paid = 1 OR (d.expiry_date IS NOT NULL AND d.expiry_date >= CURDATE()))
       ), 0)),
       'migration 009'
  FROM cp2_sites s
 WHERE s.status IN ('active', 'suspended')
ON DUPLICATE KEY UPDATE requested = VALUES(requested);
