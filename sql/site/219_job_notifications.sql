-- ─────────────────────────────────────────────────────────────────────────
-- Job notifications: what was sent, to whom, on which channel.
--
-- ── WHY THIS TABLE EXISTS ────────────────────────────────────────────────
--
-- Before this, jobPeople.mailAbout() returned a NotifyOutcome — a count and a
-- skip reason — and every caller threw it away. So the honest answer to "did
-- the customer ever get told their part arrived?" was that nobody could say.
-- PRD 36 asks for outbound customer communication to be logged against the job
-- INCLUDING delivery status, and rule 13 wants the important ones auditable.
--
-- It is also what makes duplicate suppression possible. Suppression needs to
-- know what already went out, and a count returned to a caller that discards it
-- cannot answer that. The dedupe window reads this table.
--
-- ── ONE ROW PER RECIPIENT PER CHANNEL, NOT PER SEND ──────────────────────
--
-- A status change that emails four people and texts one writes five rows, not
-- one. The alternative — one row per event with a recipients string, as
-- alert_rule_runs does — is right THERE because a rule names its audience once
-- and the run either happened or did not.
--
-- Here the question being asked is different: "was this person told, on this
-- channel". A packed string cannot answer it without LIKE, and LIKE over a
-- comma list is how a dedupe check matches 'jo@x.co' inside 'bojo@x.co' and
-- silently suppresses a message that was never sent.
--
-- ── STATUS IS WHAT WE KNOW, NOT WHAT HAPPENED ────────────────────────────
--
-- 'sent' means the provider accepted it. It does NOT mean anybody read it, and
-- for email it does not even mean it was delivered — a bounce arrives minutes
-- later at a mailbox nothing here watches. The column is named for what it can
-- honestly assert. 'failed' carries the provider's reason in error_text so a
-- dead SMS token is diagnosable without turning on logging and waiting.
--
-- 'suppressed' is deliberately distinct from 'skipped'. Skipped means we chose
-- not to send (consent withheld, quiet hours, channel off); suppressed means we
-- WOULD have sent and did not, because the same message went recently. Rolling
-- them together would hide a dedupe window set too wide, which presents exactly
-- as "the notifications stopped working" and is otherwise very hard to see.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS job_notifications (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,

  job_card_id  INT UNSIGNED NOT NULL,

  -- What happened, in the sender's vocabulary: 'assigned', 'status', 'closed',
  -- and whatever later events are added. Deliberately VARCHAR and not an ENUM —
  -- adding an event should not need a migration, and this column is read for
  -- display and for the dedupe key rather than switched on.
  event        VARCHAR(40)  NOT NULL,

  channel      ENUM('bell','email','sms','whatsapp','push') NOT NULL,

  -- Who it went to. BOTH are nullable and at most one is set: staff are users,
  -- customer contacts are not, and a row is one or the other.
  --
  -- No foreign key on either. A notification is a historical fact — it is not
  -- untrue because the person has since left, and ON DELETE CASCADE would erase
  -- the evidence that they were told. Same reasoning as the activity log.
  user_id      INT UNSIGNED NULL,
  contact_id   INT UNSIGNED NULL,

  -- The address as it was used, so the log still reads correctly after somebody
  -- changes their number. Empty for the bell, which has no address.
  destination  VARCHAR(190) NOT NULL DEFAULT '',

  status       ENUM('sent','failed','skipped','suppressed') NOT NULL,

  -- Why it did not go, or why it failed. Provider text for a failure; a short
  -- reason ('no consent', 'quiet hours', 'duplicate') otherwise.
  reason       VARCHAR(300) NOT NULL DEFAULT '',

  -- The subject line, kept short. Enough to recognise the message in an audit
  -- without turning this table into a copy of every email body ever sent.
  summary      VARCHAR(190) NOT NULL DEFAULT '',

  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),

  -- The job's own communication history, newest first. The one read the job
  -- card itself performs.
  KEY ix_jobnotif_job (job_card_id, created_at),

  -- The dedupe probe: "has this exact message gone to this person on this
  -- channel recently". Column order matters — equality columns first, the range
  -- scan on created_at last, or the index stops being usable for the window.
  KEY ix_jobnotif_dedupe (job_card_id, event, channel, user_id, contact_id, created_at),

  CONSTRAINT fk_jobnotif_job FOREIGN KEY (job_card_id)
    REFERENCES job_cards (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
