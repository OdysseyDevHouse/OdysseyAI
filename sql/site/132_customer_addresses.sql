-- ============================================================================
-- 132 — Customer addresses: billing and delivery, several of each
--
-- WHY
--
-- customers carries ONE address (012), and it is the BILLING address — every
-- invoice, statement and document snapshot reads it, which is exactly why it
-- stays where it is. What the master could not say is "deliver here, invoice
-- head office", or a customer with three branches. This table holds the
-- ADDITIONAL addresses: extra billing addresses and every delivery address.
--
-- Jobs already solved their half of this with service_addresses ("where the
-- work happens, which is not where the invoice goes"). This is the SALES
-- half: where the goods go. The two stay separate for the same reason
-- service addresses are not stock locations — different questions, and a
-- shared table would need a discriminator everybody must remember to filter.
--
-- Documents SNAPSHOT address text (sales_documents.customer_address), never
-- a pointer to these rows — so deletion cannot orphan a document, and the
-- FK cascades with the customer like customer_contacts (031).
--
-- One default PER KIND, enforced in code inside the save transaction —
-- MariaDB has no partial unique index, the service_addresses precedent.
-- ============================================================================

CREATE TABLE IF NOT EXISTS customer_addresses (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  customer_id INT UNSIGNED NOT NULL,
  kind        ENUM('billing','delivery') NOT NULL DEFAULT 'delivery',
  -- "Warehouse", "Head office", "Mrs Naidoo's flat" — how the picker names it.
  label       VARCHAR(120) NOT NULL,
  line1       VARCHAR(190) NULL,
  line2       VARCHAR(190) NULL,
  city        VARCHAR(120) NULL,
  postal_code VARCHAR(20)  NULL,
  province    VARCHAR(80)  NULL,
  country     CHAR(2)      NOT NULL DEFAULT 'ZA',
  notes       VARCHAR(400) NULL,
  is_default  TINYINT(1)   NOT NULL DEFAULT 0,
  is_active   TINYINT(1)   NOT NULL DEFAULT 1,
  sort_order  INT          NOT NULL DEFAULT 0,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_caddr_customer (customer_id, kind, is_default, sort_order),
  CONSTRAINT fk_caddr_customer FOREIGN KEY (customer_id)
    REFERENCES customers (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
