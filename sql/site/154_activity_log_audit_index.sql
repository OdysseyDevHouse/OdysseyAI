-- The global audit screen filters by entity alone, ordered by date. The 011
-- index is (entity, entity_id, created_at) -- right for one record's own
-- Activity tab, a filesort for "everything that happened to products last
-- week". This one serves the screen-wide filter.
ALTER TABLE activity_log ADD KEY IF NOT EXISTS ix_activity_entity_created (entity, created_at);
