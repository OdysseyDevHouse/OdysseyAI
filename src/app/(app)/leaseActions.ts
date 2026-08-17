'use server'

import { requireSession } from '@/lib/auth'
import { readLease, leaseUnlockSecret, applyUnlock } from '@/lib/licence/lease'
import { verifyResponse, challengeFor, UNLOCK_GRANT_DAYS } from '@/lib/licence/unlockCode'

/**
 * Redeeming an unlock code, on the machine that is locked.
 *
 * ── THE WHOLE THING HAPPENS LOCALLY ─────────────────────────────────────────
 *
 * No network call. The secret was planted while this machine was online, the
 * challenge is derived from state it already holds, and the verification is an
 * HMAC — so this works on a machine whose line has been dead for a month, which
 * is the only kind of machine that ever gets here.
 *
 * ── WHY IT NEEDS A SESSION BUT NOT A CAPABILITY ─────────────────────────────
 *
 * requireSession, so a passer-by at an unattended till cannot type codes into
 * it. But deliberately NOT a capability check: the person holding the phone is
 * whoever is in the shop, and a rule that only a manager may unlock would mean
 * a Sunday morning cashier cannot open the shop even with support on the line.
 *
 * The code itself is the authority. It is machine-specific, single-use and
 * time-boxed, and it comes from a supervisor who has already decided to grant
 * it — so requiring a second permission here would only add a way to fail.
 */

export type UnlockResult = { ok: true; days: number } | { ok: false; error: string }

export async function redeemUnlockAction(supplied: string): Promise<UnlockResult> {
  const session = await requireSession()
  if (!session || !session.siteId) {
    return { ok: false, error: 'Please sign in before unlocking this machine.' }
  }
  const siteId = session.siteId

  const trimmed = String(supplied || '').trim()
  if (!trimmed) return { ok: false, error: 'Enter the code support gave you.' }

  const lease = await readLease(siteId)
  if (!lease) {
    /* No lease to extend. A machine here has never checked in, so it is not
       locked by the lease either — it should not have reached this screen. */
    return { ok: false, error: 'This machine has no licence record to unlock.' }
  }

  const secret = await leaseUnlockSecret(siteId)
  if (!secret) {
    return {
      ok: false,
      error: 'This machine cannot accept an unlock code. Support will need to register it again.',
    }
  }

  /* Recomputed rather than trusted from the client: the challenge is derived
     from the lease's own counter, so a client that sent a stale or invented one
     would be verifying against a code this machine never displayed. */
  const challenge = challengeFor(secret, {
    siteId,
    deviceSerial: lease.deviceSerial,
    unlockCounter: lease.unlockCounter,
  })

  if (!verifyResponse(secret, challenge, trimmed)) {
    /* Deliberately unspecific, and deliberately not rate-limited beyond this.
       There is no oracle to grind against — the machine is offline, the code is
       nine characters from a 24-letter alphabet, and a wrong guess leaves the
       counter untouched so the challenge does not move. */
    return { ok: false, error: 'That code was not accepted. Please check it and try again.' }
  }

  const applied = await applyUnlock(siteId, UNLOCK_GRANT_DAYS)
  if (!applied) {
    return { ok: false, error: 'The unlock could not be saved. Please try again.' }
  }

  return { ok: true, days: UNLOCK_GRANT_DAYS }
}
