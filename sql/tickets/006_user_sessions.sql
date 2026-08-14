-- ============================================================================
-- 006_user_sessions.sql — one live back-office session per user
-- ============================================================================
--
-- A shop buys one back-office licence and ten people share the login. Nothing
-- stopped them: the session is a stateless JWT — signed, self-contained, twelve
-- hours, with no server-side record that it was ever issued. Signing in on a
-- second machine minted a second valid token and the first kept working.
--
-- There was no revocation of any kind. signOut() deleted a cookie while the
-- token itself stayed valid; the only global kill-switch was rotating
-- SESSION_SECRET, which nukes every session, every till session, every calendar
-- feed and every pay link at once.
--
-- This table is the missing record: which session is the CURRENT one for each
-- user. A token whose id is not this row's has been superseded, and the guard in
-- requireSession() turns that into a redirect back to the login screen.
--
-- ── WHY user_id IS THE PRIMARY KEY ──────────────────────────────────────────
--
-- Because "one live session per user" IS the schema, rather than a rule the code
-- has to remember to apply. One row per user means sign-in is a single
-- INSERT ... ON DUPLICATE KEY UPDATE that atomically replaces whatever was
-- there, so eviction needs no separate DELETE and two simultaneous sign-ins
-- cannot race into two live rows. A table keyed on session_id would need a
-- delete-then-insert, and the window between them is exactly when the second
-- sign-in arrives.
--
-- The cost is that this cannot grow into "your last five devices" without a
-- schema change. That is the right trade: the feature is a LIMIT, and a table
-- shaped like a history would invite one.
--
-- ── NO FOREIGN KEY ON user_id, DELIBERATELY ─────────────────────────────────
--
-- cp2_users belongs to the v2 backend and this codebase does not alter it — the
-- same rule cp2_signin_log (003) follows and for the same reason: a v2 user
-- purge must not fail on rows it knows nothing about. A stale row here is
-- harmless, because a session id that no longer matches simply reads as "not
-- current", which is what a deleted user should be anyway.
--
-- ── WHAT IS DELIBERATELY NOT HERE ───────────────────────────────────────────
--
-- No expiry column. The JWT already carries its own twelve-hour exp and is
-- verified on every read, so a second copy of that deadline here would be a
-- second thing to keep in step — and the one that drifts is the one that lets a
-- dead session through.

CREATE TABLE IF NOT EXISTS cp2_user_sessions (
  user_id      INT UNSIGNED NOT NULL,

  -- The `sid` claim carried inside the session JWT. A token presenting anything
  -- else has been superseded by a newer sign-in.
  session_id   CHAR(36)     NOT NULL,

  issued_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- Touched by the guard, but throttled to about once a minute: a page load
  -- fires several server actions in parallel and each one runs the check, so an
  -- unconditional write here would turn one page view into a dozen updates of
  -- the same row — and they would queue on each other's locks.
  last_seen_at DATETIME     NULL,

  -- Who and where, for the person asking "why was I signed out?". Snapshots
  -- rather than a join: this answers a support question, not a report.
  ip           VARCHAR(45)  NULL,
  user_agent   VARCHAR(255) NULL,

  PRIMARY KEY (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
