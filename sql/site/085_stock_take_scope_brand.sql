-- ── Stock take scope: brand, not category ────────────────────────────────
--
-- 081 shipped with scope ENUM(...,'category',...). Products carry no category
-- column -- 001 gives them department_id and brand_id and nothing else -- so a
-- category scope is a filter that can only ever match nothing.
--
-- This exists as its own file rather than as an edit to 081 because a migration
-- is recorded by NAME once it has run. Editing an applied file changes what a
-- fresh site gets while leaving every existing site exactly as it was, which is
-- the worst of both: the schema silently disagrees with itself across sites and
-- nothing reports it.
--
-- Safe on a site that never saw the earlier enum: the target definition is the
-- same either way, so this is a no-op rewrite rather than a change.
--
-- No rows can be lost. `category` was never selectable from any screen -- 081
-- and this file landed in the same session, before the module had a UI -- so
-- there is nothing to migrate before narrowing the enum.
--
-- NOTE: no apostrophes in comments anywhere in this file. The runner sends it
-- as one multipleStatements batch, and MariaDB reads a lone ' inside a `--`
-- comment as opening a string literal, swallowing the SQL that follows.
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE stock_takes
  MODIFY COLUMN scope ENUM('full','department','brand','supplier','manual')
    NOT NULL DEFAULT 'manual';
