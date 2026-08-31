-- The advanced filter a person is currently working through.
--
-- ── WHAT PROBLEM THIS SOLVES ─────────────────────────────────────────────
--
-- The filter itself lives in the URL, like every other list filter in this app
-- (see lib/searchParams.ts): that is what makes a filtered list linkable,
-- reloadable and server-rendered, and it is not changing.
--
-- What the URL cannot do is survive a trip that does not carry it. Someone
-- narrows the catalogue to ten products and starts editing them one by one.
-- Every link out of the list now carries the list's own address back (see
-- lib/returnTo.ts), so the round trip holds — but only for links that were
-- built from the list. Arriving at /products any other way — the sidebar, a
-- bookmark, the browser's own history, a redirect after a bulk action — lands
-- on the unfiltered catalogue and the worklist is gone.
--
-- This row is the answer to that: when someone ticks "remember this filter",
-- their filter is stored, and a bare /products rehydrates it.
--
-- ── WHY PER USER, NOT PER STORE ──────────────────────────────────────────
--
-- The opposite call to list_columns (109), and deliberately.
--
-- Which columns the products list shows is a fact about how the SHOP works, so
-- it is decided once for everyone. A filter someone is working through is a
-- fact about what that PERSON is doing this afternoon. Storing it per store
-- would mean one manager's clean-up worklist silently filtered the catalogue
-- for every till operator and every other back-office user — a screen that
-- appears to have lost three thousand products, with no clue as to why, and no
-- indication of who did it.
--
-- ── WHY IT EXPIRES ───────────────────────────────────────────────────────
--
-- A remembered filter means /products is no longer the whole catalogue for
-- that person, which is a genuine trap: forget it is on, and the list looks
-- broken. The screen defends against that by always showing what is applied
-- and offering one-click Clear, but a filter that outlives the task it was for
-- is still a bad default.
--
-- So it is SESSION-scoped in intent and expiring in practice. `expires_at` is
-- set on write and the read ignores anything past it, so a filter left on at
-- five o'clock is gone the next morning without anyone having to clear it.
-- Deliberately not tied to the login session id: the same person on the same
-- day, in a new tab or after a re-login, is still doing the same job.
--
-- ── WHY NOT localStorage ─────────────────────────────────────────────────
--
-- The per-device column picker (useColumnPrefs) uses it, so it was the obvious
-- precedent. It cannot work here: the server has to know the filter to render
-- the first paint of /products with it already applied, and to send someone
-- back to the right list after a save. A browser-only store would mean the
-- page rendering unfiltered and then flickering into the filtered view.

CREATE TABLE IF NOT EXISTS list_filters (
  -- Which screen: 'products', 'customers', 'suppliers'. Same namespace as
  -- list_columns.list_key.
  list_key    VARCHAR(60)  NOT NULL,
  -- The site_users row this belongs to. Not a FK: this is disposable UI state,
  -- and a deleted user's stale filter row is harmless where a failed cascade
  -- on an unrelated table is not.
  user_id     INT UNSIGNED NOT NULL,
  -- The encoded filter set, exactly as it appears in the URL's `f` parameter.
  -- Stored as written rather than as JSON so there is ONE format: what the URL
  -- carries, what this column holds and what the panel parses are the same
  -- string, and there is no second encoder to drift.
  --
  -- TEXT rather than VARCHAR for the same reason list_columns.columns is: a
  -- dozen conditions with typed values runs past 255 bytes, and MySQL outside
  -- strict mode truncates rather than refusing.
  filters     TEXT         NOT NULL,
  -- Past this, the read ignores the row. See above.
  expires_at  DATETIME     NOT NULL,
  updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  -- One remembered filter per person per list. Writing a new one replaces it,
  -- which is what "remember THIS filter" means.
  PRIMARY KEY (list_key, user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
