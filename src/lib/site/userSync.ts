import 'server-only'
import { accountsWithAccessTo } from '../controlUsers'
import { resolveLocalUser } from './users'

/**
 * Makes this store's Users screen agree with the control panel.
 *
 * ── THE DRIFT THIS EXISTS TO CLOSE ──────────────────────────────────────────
 *
 * Two applications write who may sign in. The control panel writes
 * `cp2_user_sites` in the control database; this back office writes `users` in
 * the site's own database. Nothing joins them at write time — they are separate
 * databases with no transaction between them — and the only reconciliation used
 * to happen at SIGN-IN, in `ensureLocalUser`.
 *
 * So a login added in the control panel existed, could open the store, and was
 * absent from "Everyone who may sign in" until the day that person first
 * happened to sign in HERE. An owner reading their own users list was reading a
 * list that did not include everybody who could walk in — which is the one
 * thing that screen is for.
 *
 * Running it when the screen is rendered rather than on a schedule: this is the
 * moment somebody is asking the question, it is a single indexed read on the
 * control database, and the write is guarded by `uq_user_control` so calling it
 * twice at once is harmless.
 *
 * ── WHAT IT DOES NOT DO ─────────────────────────────────────────────────────
 *
 * It never removes or deactivates anybody, and it never overwrites a name or a
 * PIN. A local row whose upstream grant was withdrawn stays exactly as it is:
 * they cannot sign in (the site list is read from `cp2_user_sites` at sign-in),
 * and the row may still be a till user with a PIN, which is a decision for the
 * shop rather than for a sync. The one thing it does correct is a
 * `control_user_id` that points at the wrong person — see resolveLocalUser,
 * which decides by the email address rather than by the link.
 *
 * Fail-soft, and deliberately so. On a local install the control database may
 * be unreachable, and a store must still be able to open its own Users screen
 * to manage its own till operators.
 */
export async function syncControlGrants(siteId: number): Promise<void> {
  try {
    const accounts = await accountsWithAccessTo(siteId)
    for (const account of accounts) {
      await resolveLocalUser(siteId, account.id, account.fullName, account.email)
    }
  } catch {
    /* Nothing to report to the screen: the list it is about to render is still
       correct about everybody this store knows of. */
  }
}
