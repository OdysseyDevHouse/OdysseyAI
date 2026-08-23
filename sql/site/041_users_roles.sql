-- Users, roles and permissions, per site.
--
-- Until now this database had no people in it. A user was a cp2_users row in
-- the control database and a role was one of three values on the link table,
-- which is fine for a back-office login and useless for a till: a cashier who
-- works one shop, has no email address and never opens the back office had
-- nowhere to exist. 015 said as much and chose role-level permissions
-- deliberately, because a per-user table keyed on an upstream id goes stale the
-- day someone is removed upstream with nothing here to notice.
--
-- That reasoning still holds, and this migration is what makes it safe to go
-- further: the user row now lives HERE, so nothing can be removed upstream
-- without the local row still being the thing that decides. A control account
-- becomes a way to LOG IN, not the identity itself.
--
-- TWO KINDS OF USER, one table:
--
--   Back office — has a cp2_users row (email + password, possibly spanning
--   several stores) and a `control_user_id` pointing at it. Also has a PIN, so
--   the same person can work the till without signing out.
--
--   POS only — no email, no password, no control row, `control_user_id` NULL.
--   The PIN is the whole credential. This person cannot reach the back office
--   because there is nothing for them to log in with.
--
-- Roles are per site and user-defined. A shop that wants "Cashier",
-- "Supervisor" and "Bookkeeper" gets exactly those, rather than being made to
-- pick from owner/manager/staff, which named a billing relationship more than a
-- job.

-- ── Roles ───────────────────────────────────────────────────────────────
--
-- Site-local, so two shops can disagree about what a supervisor may do without
-- either of them being wrong.
CREATE TABLE roles (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name        VARCHAR(60)  NOT NULL,
  description VARCHAR(200) NULL,

  -- The anti-lockout role. Exactly one row has this set, it holds every
  -- capability implicitly (see `capabilitiesFor`), and the UI refuses to
  -- delete it or take permissions off it. Without a role that cannot be
  -- reduced, an owner can tick away their own access to the permissions screen
  -- and the only fix is editing the database by hand.
  is_owner    TINYINT(1)   NOT NULL DEFAULT 0,

  -- Seeded roles a fresh site gets. Renaming or re-permissioning one is fine;
  -- this only stops the delete that would leave a site with no roles at all.
  is_system   TINYINT(1)   NOT NULL DEFAULT 0,

  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_role_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Users ───────────────────────────────────────────────────────────────
CREATE TABLE users (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name            VARCHAR(120) NOT NULL,

  -- cp2_users.id, or NULL for a POS-only user. No FK is possible — that table
  -- is in another database — which is exactly why this is nullable and why the
  -- name above is stored here rather than read across.
  --
  -- UNIQUE because one control account maps to at most one person per site.
  -- MySQL allows any number of NULLs in a unique index, so every POS-only user
  -- coexists happily; only real ids collide.
  control_user_id INT UNSIGNED NULL,

  -- Copied from cp2_users for display and for matching on first sign-in. Not
  -- the credential: the password lives upstream and is verified there.
  email           VARCHAR(190) NULL,

  -- Where a text message reaches this person (PRD 36).
  --
  -- Local to the site, unlike `email`, which is copied from upstream: a mobile
  -- number is how a TECHNICIAN is reached about today's work, and the person who
  -- knows it is the manager standing next to them, not whoever created the
  -- control-panel login.
  --
  -- Free text rather than a normalised form. normaliseSaPhone() in sms/phone.ts
  -- is the one place that decides what dials, and it runs at send time — storing
  -- a normalised copy would mean two representations to disagree, and would
  -- silently discard a number it could not parse at capture time.
  mobile          VARCHAR(40)  NULL,

  -- bcrypt of the PIN. The PIN itself is never stored, exactly like a password.
  --
  -- That means uniqueness cannot be enforced with a UNIQUE index — two
  -- identical PINs produce different hashes because each has its own salt. The
  -- rule is enforced in `users.ts` by checking a new PIN against every active
  -- user's hash before saving. At store scale (tens of users) that is a handful
  -- of bcrypt comparisons on a screen nobody opens hourly; the alternative,
  -- storing something searchable, would mean a reversible or unsalted PIN.
  pin_hash        VARCHAR(60)  NULL,

  -- Who they are at the till, and whether they may open the back office at all.
  -- A back_office user still needs a control_user_id to actually sign in; this
  -- flag is what the UI asks about and what the till uses to decide whether to
  -- offer the back-office button.
  user_type       ENUM('back_office','pos_only') NOT NULL DEFAULT 'pos_only',

  role_id         INT UNSIGNED NULL,

  -- A rep is a commission-earning person and is NOT the same question as who
  -- rang the sale up (033 explains why it is per line). Linking them lets a
  -- till attribute a line to whoever is signed in, without forcing every
  -- cashier to be a rep.
  sales_rep_id    INT UNSIGNED NULL,

  is_active       TINYINT(1)   NOT NULL DEFAULT 1,
  last_login_at   DATETIME     NULL,

  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_user_control (control_user_id),
  KEY ix_user_active (is_active, name),
  KEY ix_user_role (role_id),
  CONSTRAINT fk_user_role FOREIGN KEY (role_id) REFERENCES roles (id) ON DELETE SET NULL,
  CONSTRAINT fk_user_rep  FOREIGN KEY (sales_rep_id) REFERENCES sales_reps (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Role permissions ────────────────────────────────────────────────────
--
-- Replaces role_capabilities, which keyed on the site_role ENUM and therefore
-- could not express a role the shop invented. Same shape otherwise, same
-- deny-by-default rule: a missing row is a no.
CREATE TABLE role_permissions (
  role_id    INT UNSIGNED NOT NULL,
  capability VARCHAR(60)  NOT NULL,
  allowed    TINYINT(1)   NOT NULL DEFAULT 0,
  PRIMARY KEY (role_id, capability),
  CONSTRAINT fk_role_permission_role FOREIGN KEY (role_id) REFERENCES roles (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Seed the roles ──────────────────────────────────────────────────────
--
-- Owner first, so it takes id 1 and the migration below can point the existing
-- control users at it without a lookup.
INSERT INTO roles (name, description, is_owner, is_system) VALUES
  ('Owner',   'Full access to everything, including permissions.', 1, 1),
  ('Manager', 'Runs the shop day to day.',                          0, 1),
  ('Cashier', 'Till only.',                                          0, 1);

-- Carry across whatever the old role grid held, mapping the three ENUM values
-- onto the three seeded roles. A site that ticked nothing gets nothing, which
-- is the same as it had.
INSERT INTO role_permissions (role_id, capability, allowed)
SELECT r.id, rc.capability, rc.allowed
  FROM role_capabilities rc
  INNER JOIN roles r
     ON r.name = CASE rc.site_role
                   WHEN 'owner'   THEN 'Owner'
                   WHEN 'manager' THEN 'Manager'
                   WHEN 'staff'   THEN 'Cashier'
                 END
 WHERE r.is_system = 1
ON DUPLICATE KEY UPDATE allowed = VALUES(allowed);

-- Manager and Cashier get a sensible starting grid so a fresh site is usable
-- before anyone opens the permissions screen. Owner is deliberately absent:
-- it holds everything implicitly and storing rows for it would imply the rows
-- could be removed. Nothing here overwrites a value carried across above.
INSERT INTO role_permissions (role_id, capability, allowed)
SELECT r.id, c.capability, c.allowed
  FROM roles r
  JOIN (
    SELECT 'Manager' AS role_name, 'sales.void'               AS capability, 1 AS allowed UNION ALL
    SELECT 'Manager', 'sales.credit_note',         1 UNION ALL
    SELECT 'Manager', 'sales.discount_override',   1 UNION ALL
    SELECT 'Manager', 'sales.price_override',      1 UNION ALL
    SELECT 'Manager', 'sales.till',                1 UNION ALL
    SELECT 'Manager', 'sales.view',                1 UNION ALL
    SELECT 'Manager', 'products.view',             1 UNION ALL
    SELECT 'Manager', 'products.edit',             1 UNION ALL
    SELECT 'Manager', 'customers.view',            1 UNION ALL
    SELECT 'Manager', 'customers.edit',            1 UNION ALL
    SELECT 'Manager', 'suppliers.view',            1 UNION ALL
    SELECT 'Manager', 'suppliers.edit',            1 UNION ALL
    SELECT 'Manager', 'purchasing.view',           1 UNION ALL
    SELECT 'Manager', 'purchasing.edit',           1 UNION ALL
    SELECT 'Manager', 'stock.view',                1 UNION ALL
    SELECT 'Manager', 'stock.adjust',              1 UNION ALL
    SELECT 'Manager', 'stock.transfer',            1 UNION ALL
    SELECT 'Manager', 'cashbook.view',             1 UNION ALL
    SELECT 'Manager', 'cashbook.edit',             1 UNION ALL
    SELECT 'Manager', 'reports.view',              1 UNION ALL
    SELECT 'Manager', 'dashboard.view',            1 UNION ALL
    SELECT 'Manager', 'online.view',               1 UNION ALL
    SELECT 'Manager', 'online.edit',               1 UNION ALL
    SELECT 'Cashier', 'sales.till',                1 UNION ALL
    SELECT 'Cashier', 'sales.view',                1 UNION ALL
    SELECT 'Cashier', 'products.view',             1 UNION ALL
    SELECT 'Cashier', 'customers.view',            1 UNION ALL
    SELECT 'Cashier', 'customers.edit',            1
  ) AS c ON c.role_name = r.name
 WHERE r.is_system = 1
ON DUPLICATE KEY UPDATE allowed = role_permissions.allowed;

-- ── Adopt the existing control users ────────────────────────────────────
--
-- Every id already written into activity_log, sales_documents, shifts and the
-- rest is a cp2_users.id. Those columns are about to mean users.id instead, so
-- the two must be reconciled — and the only safe way is to give each control
-- user a local row whose id EQUALS the control id. Then every historic
-- user_id is already correct and no audit row has to be rewritten.
--
-- This works because `users` is empty at this point, so there is nothing for
-- the explicit ids to collide with. AUTO_INCREMENT continues above the highest
-- inserted id, so new POS users get fresh ids and never reuse one.
--
-- The names come from the audit trail rather than the control database,
-- because a site database cannot join across to odyssey_tickets. Every id that
-- appears in the history gets a row, so no historic row is left pointing at a
-- user that does not exist. `site-migrate.mjs` refreshes the names and emails
-- from cp2_users immediately after this file runs, where it CAN see both.
--
-- `user_id > 0` is load-bearing, not defensive. Sales taken by the online
-- store carry user_id = 0 with the name "Online payment" — a pseudo-actor
-- standing in for "no person did this", written before there was a users table
-- to be absent from. Inserting it would be actively wrong twice over: it is
-- not a user anyone can log in as, and MySQL reads an explicit 0 in an
-- AUTO_INCREMENT primary key as "give me the next id", so the row would silently
-- take id 1 and collide with whoever genuinely is user 1.
--
-- Those rows keep user_id = 0 and their snapshotted name. Nothing points at a
-- missing user, because 0 never pointed at a user in the first place.
INSERT INTO users (id, name, control_user_id, user_type, role_id, is_active)
SELECT src.user_id,
       COALESCE(NULLIF(MAX(src.user_name), ''), CONCAT('User ', src.user_id)),
       src.user_id,
       'back_office',
       (SELECT id FROM roles WHERE is_owner = 1 LIMIT 1),
       1
  FROM (
    SELECT user_id, user_name FROM activity_log     WHERE user_id > 0
    UNION ALL
    SELECT user_id, user_name FROM sales_documents  WHERE user_id > 0
    UNION ALL
    SELECT user_id, user_name FROM document_audit   WHERE user_id > 0
    UNION ALL
    SELECT user_id, user_name FROM shifts           WHERE user_id > 0
  ) AS src
 GROUP BY src.user_id;

-- ── Retire the old grid ─────────────────────────────────────────────────
--
-- Dropped rather than left in place: two permission tables where one is live
-- and one is stale is how a security check ends up reading the wrong one.
DROP TABLE role_capabilities;
