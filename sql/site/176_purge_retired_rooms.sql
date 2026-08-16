-- Retired floor-plan rooms held their names hostage. Let them go.
--
-- ── THE BUG THIS CLEARS ────────────────────────────────────────────────────
--
-- `retireRoom` used to set `is_active = 0` and keep the row. But `uq_room_name` is a
-- plain UNIQUE index on `name`, and a UNIQUE index does not care about a flag — so a
-- retired room went on reserving its name forever, while `listRooms` filtered it out
-- of every screen that could have shown it.
--
-- The result was a dead end with no way out from the UI: remove "Main", try to create
-- "Main" again, and the screen says "There is already a room by that name" directly
-- above an empty state reading "No rooms yet". Nothing visible explains it, and no
-- action available to a manager fixes it.
--
-- `retireRoom` now DELETEs. This clears the rows that were stranded before that
-- change, so an existing site is not left carrying the old problem.
--
-- ── WHY DELETING THESE IS SAFE ─────────────────────────────────────────────
--
-- A retired room owns nothing that outlives it, and 086's own foreign keys say so:
--
--   · pos_tables.room_id is ON DELETE SET NULL, so tables survive as unplaced. Any
--     open bill on them is untouched — that is precisely why 086 chose SET NULL over
--     CASCADE, so tidying the floor plan can never destroy a live document.
--   · pos_floor_features is ON DELETE CASCADE, because a wall has no existence apart
--     from the room it stands in.
--
-- Tables are detached FIRST so no row is left holding coordinates for a room that has
-- gone. The FK would blank `room_id` on its own, but `pos_x`/`pos_y` are not part of
-- the constraint and would survive as numbers pointing into nothing.
--
-- ONLY inactive rooms are touched. An active room is somebody's live floor plan.
UPDATE pos_tables
   SET room_id = NULL, pos_x = NULL, pos_y = NULL
 WHERE room_id IN (SELECT id FROM pos_floor_rooms WHERE is_active = 0);

DELETE FROM pos_floor_rooms WHERE is_active = 0;
