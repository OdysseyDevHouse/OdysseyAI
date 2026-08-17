'use server'

import { actorFor, requireSession } from '@/lib/auth'
import { grantUnlock, recordGrant, listGrants } from '@/lib/licence/grantUnlock'
import { normaliseCode } from '@/lib/licence/unlockCode'

/**
 * Issuing an unlock code to a customer on the telephone.
 *
 * ── WHY setup.edit ──────────────────────────────────────────────────────────
 *
 * Same reasoning as claiming a licence next door in actions.ts: this is an act
 * with a commercial consequence, so it belongs to whoever administers the shop
 * rather than to whoever happens to be on the till. The person on the phone at
 * the OTHER end needs no permission at all — the code itself is the authority
 * there, and demanding a manager to type it in would strand a Sunday cashier.
 *
 * ── WHAT THIS DOES NOT DO ───────────────────────────────────────────────────
 *
 * It does not verify that the customer deserves an unlock. Nothing here can:
 * the whole scheme grants access without a network, so the only real control is
 * that every grant is written down against the person who issued it. The ledger
 * is not a formality — it is the entire mechanism, which is why the write
 * happens before the code is returned and a failure to write refuses the grant.
 */

export type IssueResult =
  | {
      ok: true
      response: string
      deviceSerial: string
      days: number
      /** Unlocks this machine has already had. Shown to the agent, deliberately. */
      priorGrants: number
    }
  | { ok: false; error: string }

export async function issueUnlockAction(
  challenge: string,
  reason: string,
): Promise<IssueResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx

  /* cp2_unlock_grants.granted_by names a CONTROL user, because that is who a
     supervisor is — the site-level actor id would point at a different table
     and read as the wrong person entirely. */
  const session = await requireSession()

  const found = await grantUnlock(siteId, challenge)
  if (!found.ok) return found

  /* Recorded BEFORE the code is handed over. A grant that could not be written
     down must not happen at all: an unrecorded unlock is exactly the kind this
     ledger exists to make impossible. */
  try {
    await recordGrant({
      siteId,
      deviceSerial: found.deviceSerial,
      challenge,
      response: found.response,
      unlockCounter: found.priorGrants,
      grantedDays: found.days,
      grantedBy: session?.userId ?? null,
      reason: reason.trim() || null,
    })
  } catch {
    return {
      ok: false,
      error: 'The unlock could not be recorded, so no code was issued. Please try again.',
    }
  }

  return {
    ok: true,
    response: found.response,
    deviceSerial: found.deviceSerial,
    days: found.days,
    priorGrants: found.priorGrants,
  }
}

/** The history, for the panel that shows whether this is becoming a habit. */
export async function listUnlockGrantsAction() {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return { ok: false as const, error: ctx.error }
  return { ok: true as const, grants: await listGrants(ctx.siteId) }
}

/** Exported for the panel's input, so both ends agree on what a code looks like. */
export async function normaliseUnlockCode(raw: string): Promise<string> {
  return normaliseCode(raw)
}
