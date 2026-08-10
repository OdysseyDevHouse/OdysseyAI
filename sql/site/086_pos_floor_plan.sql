-- The floor, as a shape rather than a list.
--
-- 071 gave tables a `section` and a `sort_order`, which renders as a grid grouped by
-- area. That covers most restaurants and it stays: a manager must be able to add a
-- table without dragging one, and a shop that never opens the designer keeps exactly
-- the screen it has today.
--
-- What a grid cannot do is let a waiter recognise the floor WITHOUT READING. On a
-- busy Friday the useful question is "who is that table by the window" and the answer
-- should be spatial, not alphabetical. That is what these columns buy.
--
-- ── EVERYTHING HERE IS NULLABLE OR DEFAULTED, DELIBERATELY ─────────────────
--
-- A table with no position is not broken; it is a table nobody has placed yet. The
-- gate renders the sectioned grid when a room has no layout and the positioned canvas
-- when it has one, so this migration changes NOTHING for an existing site until
-- somebody opens the designer. There is no backfill and no default arrangement,
-- because a guessed layout that looks nearly right is worse than an honest list.

-- ── 1. Where the table is, and how big ─────────────────────────────────────
--
-- Coordinates are in ROOM UNITS, not pixels: the canvas scales to whatever screen it
-- is on, and pixels would bake one screen's size into the data. A room is 100 units
-- wide by default (see pos_floor_rooms below), so a table at x=50 is halfway across
-- however wide the screen is.
--
-- DECIMAL, not INT. Snapping is a UI choice and may change; storing rounded integers
-- would make a finer grid impossible later without re-placing every table. 2 decimals
-- is finer than any hand can drag.
ALTER TABLE pos_tables
  ADD COLUMN pos_x      DECIMAL(7,2) NULL AFTER sort_order,
  ADD COLUMN pos_y      DECIMAL(7,2) NULL AFTER pos_x,
  -- Size in the same units. Defaulted rather than nullable: a placed table always has
  -- a size, and 8x8 is a comfortable four-seater at the default room scale.
  ADD COLUMN width      DECIMAL(7,2) NOT NULL DEFAULT 8.00 AFTER pos_y,
  ADD COLUMN height     DECIMAL(7,2) NOT NULL DEFAULT 8.00 AFTER width,
  -- Degrees clockwise. A long table against a diagonal wall is the case; 0 is the
  -- overwhelming majority and costs nothing to store.
  ADD COLUMN rotation   SMALLINT NOT NULL DEFAULT 0 AFTER height,
  -- 'rect' | 'round'. An ENUM rather than a boolean because a floor plan grows shapes
  -- (booth, bar stool) and a boolean cannot, while an ENUM extends in one ALTER.
  ADD COLUMN shape      ENUM('rect','round') NOT NULL DEFAULT 'rect' AFTER rotation,
  -- Which room it stands in. NULL means "not placed", which is what makes every
  -- existing row keep working: the grid is what renders an unplaced table.
  ADD COLUMN room_id    INT UNSIGNED NULL AFTER shape;

-- ── 2. Rooms ───────────────────────────────────────────────────────────────
--
-- A separate table rather than reusing `pos_tables.section` as the room name, and this
-- is the one debatable call here — so, plainly:
--
-- `section` is a free-text label a manager typed, and two tables reading 'Patio' and
-- 'patio ' are already two sections today. That is harmless for a grid heading and
-- fatal for a canvas, where the room needs its OWN width, height and background, and
-- where renaming it must not orphan its tables. A room needs identity, and free text
-- has none.
--
-- `section` therefore stays exactly as it is and keeps driving the grid. A room is the
-- spatial concept; a section is the label. A shop can use both, one, or neither.
CREATE TABLE pos_floor_rooms (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name       VARCHAR(60)  NOT NULL,
  -- The room's own extent in room units. A long thin verandah and a square dining
  -- room want different aspect ratios, and the canvas letterboxes to fit whichever it
  -- is given rather than distorting the layout.
  width      DECIMAL(7,2) NOT NULL DEFAULT 100.00,
  height     DECIMAL(7,2) NOT NULL DEFAULT 70.00,
  sort_order INT UNSIGNED NOT NULL DEFAULT 0,
  is_active  TINYINT(1)   NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_room_name (name),
  KEY idx_room_order (is_active, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- SET NULL, not CASCADE. Deleting a room must not delete the TABLES in it — a table
-- is a physical thing with a bill possibly open on it, and a manager reorganising
-- rooms would otherwise destroy live documents through a FK. The tables fall back to
-- unplaced, which the grid still renders.
ALTER TABLE pos_tables
  ADD CONSTRAINT fk_table_room FOREIGN KEY (room_id)
    REFERENCES pos_floor_rooms (id) ON DELETE SET NULL;

-- ── 3. Fixed features: walls, the bar, the pass ─────────────────────────────
--
-- Not tables, and deliberately not modelled as tables with a flag. A wall has no
-- seats, no bill, no occupancy and cannot be tapped — every property `pos_tables`
-- exists to carry is meaningless on it, and the flag would have to be checked in
-- every query that counts or seats a table. Its own table means "how many tables are
-- occupied" needs no `AND is_not_a_wall` clause.
CREATE TABLE pos_floor_features (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  room_id    INT UNSIGNED NOT NULL,
  -- What it is. Drives only how it draws — none of these are interactive.
  kind       ENUM('wall','bar','pass','door','plant','text') NOT NULL DEFAULT 'wall',
  -- Shown for 'text', and as a tooltip otherwise. A floor plan with an unlabelled
  -- rectangle in the corner is a floor plan somebody has to ask about.
  label      VARCHAR(60)  NOT NULL DEFAULT '',
  pos_x      DECIMAL(7,2) NOT NULL DEFAULT 0,
  pos_y      DECIMAL(7,2) NOT NULL DEFAULT 0,
  width      DECIMAL(7,2) NOT NULL DEFAULT 20.00,
  height     DECIMAL(7,2) NOT NULL DEFAULT 2.00,
  rotation   SMALLINT     NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_feature_room (room_id),
  -- CASCADE here, unlike the tables above: a wall belongs to its room and has no
  -- existence without it. Nothing is lost that a manager would miss.
  CONSTRAINT fk_feature_room FOREIGN KEY (room_id)
    REFERENCES pos_floor_rooms (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
