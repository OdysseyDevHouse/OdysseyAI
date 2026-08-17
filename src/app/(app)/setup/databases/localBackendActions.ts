'use server'

import { actorFor, requireSession } from '@/lib/auth'
import { revealDbPassword } from '@/lib/licence/grantUnlock'
import { execute } from '@/lib/db'

/**
 * Revealing a shop's own database password.
 *
 * ── THIS IS THE MOST PRIVILEGED READ IN THE PRODUCT ─────────────────────────
 *
 * The password opens the shop's live trading database with full rights. It is
 * generated on the customer's machine precisely so the customer never learns
 * it: a shop owner who can edit sales rows directly is a shop whose figures
 * mean nothing, and every control that depends on those figures — VAT, stock
 * valuation, commission, the audit trail — quietly stops meaning anything too.
 *
 * So it is escrowed for exactly one purpose: support recovering a machine that
 * cannot recover itself. Anything else is a misuse, and the log below is what
 * makes a misuse visible afterwards.
 *
 * ── WHY setup.edit AND NOT SOMETHING STRONGER ───────────────────────────────
 *
 * Because there is nothing stronger in this product. Capabilities describe what
 * a person may do in a shop, and this is an act performed BY us, ON a shop.
 * There is no platform-administrator role today (auth.ts has no such concept),
 * so inventing a capability here would be inventing a role nobody holds.
 *
 * setup.edit is the highest bar available and it is the same bar that claims a
 * device licence next door. The accountability is the recording, not the gate —
 * which is stated plainly here so nobody mistakes this for a strong boundary.
 */

export type RevealResult =
  | { ok: true; password: string; port: number | null; dbName: string | null }
  | { ok: false; error: string }

export async function revealDbPasswordAction(
  deviceSerial: string,
  reason: string,
): Promise<RevealResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx

  const serial = String(deviceSerial || '').trim()
  if (!serial) return { ok: false, error: 'Which machine?' }

  /* A reason is REQUIRED, and it is not decoration. The log entry is the only
     thing standing between "support recovered a machine" and "somebody read a
     customer's password", and an entry with no reason cannot tell them apart
     six months later when it matters. */
  const why = String(reason || '').trim()
  if (why.length < 5) {
    return { ok: false, error: 'Say why this is needed — it is recorded against your name.' }
  }

  const found = await revealDbPassword(siteId, serial)
  if (!found || !found.password) {
    return {
      ok: false,
      error: 'No password is escrowed for that machine. It may not have reached us since it was installed.',
    }
  }

  /* Recorded BEFORE it is returned, and a failure to record refuses the
     reveal. An unlogged read of this credential is the only kind that defeats
     the point of escrowing it in the first place.

     Its own table, deliberately: cp2_unlock_grants answers "how often has this
     shop been let off a licence check", and putting reveals there would make
     every report against it silently count two different things. */
  const session = await requireSession()
  try {
    await execute(
      `INSERT INTO cp2_credential_reveals
         (site_id, device_serial, credential, revealed_by, reason)
       VALUES (?, ?, 'db_password', ?, ?)`,
      [siteId, serial, session?.userId ?? null, why.slice(0, 255)],
    )
  } catch {
    return {
      ok: false,
      error: 'This could not be recorded, so nothing was revealed. Please try again.',
    }
  }

  return {
    ok: true,
    password: found.password,
    port: found.port,
    dbName: found.dbName,
  }
}
