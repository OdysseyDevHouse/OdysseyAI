-- Signing in at a till with no database.
--
-- ── THE PROBLEM ──────────────────────────────────────────────────────────
--
-- signInWithPin() bcrypt-compares against users.pin_hash. A till that cannot
-- reach the database still has to know who is standing at it — otherwise the shop
-- cannot trade offline at all, and no offline sale can be attributed to anybody.
--
-- ── WHAT WAS REJECTED ────────────────────────────────────────────────────
--
-- Shipping the bcrypt hashes to the browser. It works mechanically — bcryptjs
-- runs client-side — and it is a bad trade: PINs are 4 to 6 digits at cost 10, so
-- ten thousand guesses breaks a 4-digit PIN, and the attacker gets the hash by
-- opening DevTools on the till. It would hand over every manager's
-- supervisor-override PIN in the same move.
--
-- ── WHAT SHIPS INSTEAD ───────────────────────────────────────────────────
--
-- A verifier that is useless anywhere else:
--
--   PBKDF2-SHA256(pin, salt = HMAC(OFFLINE_PIN_KEY, site|user|device), 2.4M)
--
-- It cannot be attacked without a secret that never leaves the server, and it
-- cannot be moved to another machine. See src/lib/offlinePin.ts for the measured
-- cost table — the iteration count was raised from 600k to 2.4M after measuring
-- it, because 600k turned out to be four times cheaper than assumed.
--
-- ── WHEN THESE ARE WRITTEN ───────────────────────────────────────────────
--
-- When the PIN is SET, because that is the only moment the plaintext exists —
-- bcrypt does not give it back. A user whose PIN predates this migration has no
-- verifier and must re-enter it once, online, before they can sign in at an
-- offline till. The catalog ships an `offlineReady` flag per operator so the till
-- can SAY that plainly rather than just refusing them.
CREATE TABLE user_offline_verifiers (
  user_id    INT UNSIGNED NOT NULL,
  -- Which machine this verifier is good for. Part of the key because the salt
  -- binds the device: one operator on three tills has three verifiers, and none
  -- of them works on a fourth.
  device_id  VARCHAR(64)  NOT NULL,
  -- base64 of 32 bytes.
  verifier   VARCHAR(64)  NOT NULL,
  -- Stored rather than assumed, so the cost can be RAISED later without
  -- invalidating every PIN already minted at the old count.
  iterations INT UNSIGNED NOT NULL DEFAULT 2400000,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, device_id),
  -- CASCADE: a deleted user's verifiers are of no use to anybody, and leaving
  -- them behind would let a removed operator keep signing in at an offline till
  -- until its catalog next refreshed.
  CONSTRAINT fk_uov_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
