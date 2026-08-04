-- Links sites (stores) into a group that shares products.
--
-- A STORE is a site: its own row in cp2_sites, its own master database
-- (ody10000_master, ody10001_master, …). Linking two of them means the same
-- product exists in both databases and an edit fans out to each.
--
-- This lives in the TICKETING database (odyssey_tickets) alongside cp2_sites,
-- cp2_site_databases and cp2_user_sites — the same database the app connects to
-- for sign-in. A link between two stores is a fact ABOUT sites, and no single
-- store's own master database can own a relationship to another store.
--
-- (This repo's older comments call odyssey_tickets "the control database".
-- Same database, and these tables belong beside the cp2_* ones it already has.)
--
-- NOTE: odyssey_tickets is shared with the v2 backend. These tables are new and
-- prefixed cp2_ to match the existing convention; nothing already there is
-- altered, so the v2 backend is unaffected.

-- ── The group ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cp2_store_groups (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name       VARCHAR(120) NOT NULL,
  -- The store whose data is authoritative when a product is created or when
  -- two stores disagree about a shared value. Also the store the product
  -- screen edits from.
  primary_site_id INT UNSIGNED NULL,
  status     ENUM('active','inactive') NOT NULL DEFAULT 'active',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_sg_primary (primary_site_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Membership ─────────────────────────────────────────────────────────
-- One row per site in a group. A site belongs to at most one group, so the
-- unique key is on site_id rather than the pair.
CREATE TABLE IF NOT EXISTS cp2_store_group_members (
  group_id   INT UNSIGNED NOT NULL,
  site_id    INT UNSIGNED NOT NULL,
  position   INT NOT NULL DEFAULT 0,
  -- Default sharing for products created from now on. Per-product overrides
  -- live in the store's own database (see sql/site/004_store_sharing.sql) —
  -- these are only the starting point.
  shares_cost    TINYINT(1) NOT NULL DEFAULT 1,
  shares_selling TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (group_id, site_id),
  UNIQUE KEY uq_sgm_site (site_id),
  CONSTRAINT fk_sgm_group FOREIGN KEY (group_id) REFERENCES cp2_store_groups (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
