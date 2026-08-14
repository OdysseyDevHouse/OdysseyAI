-- ── The customer portal ─────────────────────────────────────────────────────
--
-- A customer signs in and sees their own jobs, quotes and invoices.
--
-- ── ONE TABLE, AND IT IS ONLY FOR THE MAGIC LINKS ───────────────────────────
--
-- The portal itself needs no schema. Everything it shows already exists: jobs,
-- appointments, quotes, invoices, comments and attachments are all tables with
-- a customer_id on them or reachable through one. Adding a portal_jobs would be
-- a second copy of the job list that could disagree with the first.
--
-- What DOES need a table is the sign-in. A magic link has to be single-use and
-- has to expire, and neither can be done with a signed token alone: a JWT is
-- valid until it expires no matter how many times it is used, and a link sitting
-- in an inbox that still works after somebody clicked it is a spare key.
--
-- ── WHY SINGLE USE MATTERS MORE THAN THE EXPIRY ─────────────────────────────
--
-- Email is forwarded, quoted in replies, synced to phones and left in shared
-- inboxes. The expiry limits how long a leaked link is a key; consuming it on
-- first use limits it to one person. Both, because either alone is thin.
--
-- The token is stored HASHED, for the same reason a password is: this table is
-- in every backup and on every developer laptop, and a plain-text row would be
-- a working key to somebody's account for as long as it lives.

CREATE TABLE IF NOT EXISTS customer_login_links (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  customer_id INT UNSIGNED NOT NULL,

  /*
   * SHA-256 of the token in the URL. Never the token itself.
   *
   * Not bcrypt, and the difference from a password is worth stating: this value
   * is 32 random bytes rather than something a person chose, so there is nothing
   * to guess and no rainbow table to defend against. A fast hash is right here
   * and a slow one would only make every sign-in slower.
   */
  token_hash  CHAR(64) NOT NULL,

  expires_at  DATETIME NOT NULL,

  /*
   * When it was used. NULL means it still works.
   *
   * Kept rather than deleted so that "somebody signed in from a link at 09:14"
   * is answerable, and so a second click can say "already used" rather than the
   * same words as a forged link.
   */
  used_at     DATETIME NULL,
  used_ip     VARCHAR(45) NULL,

  /*
   * Who asked for it, and from where.
   *
   * A link is requested by typing an email address into a public form, so this
   * is the one place an unauthenticated stranger causes a row to be written.
   * The IP is for triage when somebody hammers the form.
   */
  requested_ip VARCHAR(45) NULL,

  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  -- The lookup on the way back in. Unique so a hash collision cannot resolve to
  -- two customers, which would be catastrophic rather than merely wrong.
  UNIQUE KEY uq_login_link_hash (token_hash),
  -- The rate check: how many did this customer ask for recently.
  KEY ix_login_link_customer (customer_id, created_at),
  KEY ix_login_link_expiry (expires_at),
  /*
   * CASCADE. A deleted customer has no sign-in links worth keeping, and leaving
   * one behind would be a live key to an account that no longer exists.
   */
  CONSTRAINT fk_login_link_customer FOREIGN KEY (customer_id)
    REFERENCES customers (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Settings ────────────────────────────────────────────────────────────────

INSERT INTO settings (setting_key, setting_value)
SELECT 'portal_enabled', '0'
WHERE NOT EXISTS (SELECT 1 FROM settings WHERE setting_key = 'portal_enabled');

-- Off by default. This one shows a customer their own commercial history, so it
-- is the most consequential switch in the whole module.

INSERT INTO settings (setting_key, setting_value)
SELECT 'portal_allow_comments', '1'
WHERE NOT EXISTS (SELECT 1 FROM settings WHERE setting_key = 'portal_allow_comments');

INSERT INTO settings (setting_key, setting_value)
SELECT 'portal_allow_uploads', '1'
WHERE NOT EXISTS (SELECT 1 FROM settings WHERE setting_key = 'portal_allow_uploads');

-- Accepting a quote is legally meaningful, so it is off until a business says
-- otherwise. The other two only add words and pictures to a job.
INSERT INTO settings (setting_key, setting_value)
SELECT 'portal_allow_quote_accept', '0'
WHERE NOT EXISTS (SELECT 1 FROM settings WHERE setting_key = 'portal_allow_quote_accept');

-- How many files, and how big, per job. A public upload path with no ceiling is
-- somebody elses free storage.
INSERT INTO settings (setting_key, setting_value)
SELECT 'portal_max_uploads_per_job', '10'
WHERE NOT EXISTS (SELECT 1 FROM settings WHERE setting_key = 'portal_max_uploads_per_job');
