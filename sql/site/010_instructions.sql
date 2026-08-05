-- Instructions — the questions a till asks when an item is sold.
--
-- "English Breakfast" prompts for a bread and an egg style; a burger prompts
-- for a cooking temperature and up to three toppings. Each question is an
-- instruction GROUP, each answer an OPTION, and a product is linked to the
-- groups it should ask.
--
-- Groups are a shared LIBRARY rather than per-product rows: "Choice of bread"
-- is defined once and attached to every breakfast and sandwich that needs it,
-- so adding "Sourdough" is one edit instead of forty.

CREATE TABLE instruction_groups (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name        VARCHAR(120) NOT NULL,
  -- What the cashier is asked, e.g. "How would you like your eggs?". Falls back
  -- to `name` in the UI when blank, so a simple group needs only one field.
  prompt      VARCHAR(190) NOT NULL DEFAULT '',

  -- The till must ask before the line can be completed.
  is_required TINYINT(1)   NOT NULL DEFAULT 0,

  -- How many options may be chosen. min_choices > 0 implies required; the two
  -- are kept separate so "required, pick any number" stays expressible.
  -- max_choices 1 renders as radio buttons, above 1 as checkboxes, and 0 means
  -- no ceiling.
  min_choices SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  max_choices SMALLINT UNSIGNED NOT NULL DEFAULT 1,

  sort_order  INT          NOT NULL DEFAULT 0,
  is_active   TINYINT(1)   NOT NULL DEFAULT 1,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_instruction_group_name (name),
  KEY ix_instruction_group_active (is_active, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE instruction_options (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  group_id   INT UNSIGNED NOT NULL,
  name       VARCHAR(120) NOT NULL,

  -- Added to the line price when chosen, INCLUSIVE of VAT to match
  -- product_prices.selling_price_incl — that is the figure on the till. Signed,
  -- so an option can also discount ("no cheese -R2.00").
  price_adjust DECIMAL(12,4) NOT NULL DEFAULT 0.0000,

  -- Optional link to a stocked product, so choosing "Extra bacon" can deduct a
  -- bacon portion. NULL is the ordinary case: most options are just text.
  -- SET NULL rather than CASCADE — deleting a product must not silently delete
  -- the option and change what the till asks.
  product_id INT UNSIGNED NULL,
  -- How much of the linked product one choice consumes. Ignored when
  -- product_id is NULL.
  quantity   DECIMAL(12,3) NOT NULL DEFAULT 1.000,

  -- Pre-ticked when the group is first shown, e.g. the usual bread.
  is_default TINYINT(1)   NOT NULL DEFAULT 0,
  sort_order INT          NOT NULL DEFAULT 0,
  is_active  TINYINT(1)   NOT NULL DEFAULT 1,
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_instruction_option_group (group_id, sort_order),
  KEY ix_instruction_option_product (product_id),
  -- CASCADE here is right: an option has no meaning without its group.
  CONSTRAINT fk_option_group   FOREIGN KEY (group_id)   REFERENCES instruction_groups (id) ON DELETE CASCADE,
  CONSTRAINT fk_option_product FOREIGN KEY (product_id) REFERENCES products (id)           ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Which groups a product asks, and in what order. The order is per-product:
-- a breakfast may ask about eggs first, a sandwich about bread.
CREATE TABLE product_instruction_groups (
  product_id INT UNSIGNED NOT NULL,
  group_id   INT UNSIGNED NOT NULL,
  sort_order INT          NOT NULL DEFAULT 0,
  PRIMARY KEY (product_id, group_id),
  KEY ix_pig_group (group_id),
  CONSTRAINT fk_pig_product FOREIGN KEY (product_id) REFERENCES products (id)            ON DELETE CASCADE,
  CONSTRAINT fk_pig_group   FOREIGN KEY (group_id)   REFERENCES instruction_groups (id)  ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
