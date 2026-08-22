-- ── Who a promotion is for, and where it runs ─────────────────────────────
--
-- Every special applies to everybody, everywhere. There is no way to say
-- "account customers only", "loyalty members only", or "online but not at the
-- counter" -- and all three are ordinary things for a shop to want. A trade
-- discount for account holders is not a discount for walk-ins; a web-only deal
-- is how a shop pushes people to the shop front.
--
-- Both default to the behaviour that exists today: everybody, both channels.

ALTER TABLE specials
  -- everyone -- no restriction, and what every existing row is
  -- account  -- customers with an account attached to the sale
  -- member   -- loyalty members
  -- group    -- one customer group, named below
  ADD COLUMN audience ENUM('everyone','account','member','group')
    NOT NULL DEFAULT 'everyone',

  -- Only read when audience = 'group'. ON DELETE SET NULL rather than CASCADE:
  -- deleting a customer group must not silently delete the promotions aimed at
  -- it. The special falls back to reaching nobody, which is visible on the
  -- screen, where a vanished promotion would not be.
  ADD COLUMN audience_group_id INT UNSIGNED NULL,

  -- ── TWO BOOLEANS, NOT A CHANNEL ENUM ────────────────────────────────────
  --
  -- Following products.visible_in_pos and products.show_online, which have
  -- answered this same question since 006 and 034. The reasoning is spelled
  -- out at 186_alerts.sql:70 -- independent switches, because "both" is the
  -- common case and an enum makes it a third value to remember rather than
  -- simply leaving both on.
  ADD COLUMN runs_in_store TINYINT(1) NOT NULL DEFAULT 1,
  ADD COLUMN runs_online   TINYINT(1) NOT NULL DEFAULT 1;

ALTER TABLE specials
  ADD KEY ix_special_audience (audience, audience_group_id),
  ADD FOREIGN KEY IF NOT EXISTS fk_special_audience_group (audience_group_id)
    REFERENCES customer_groups (id) ON DELETE SET NULL;
