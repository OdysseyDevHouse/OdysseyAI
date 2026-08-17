'use server'

import { revalidatePath } from 'next/cache'
import { actorFor, requireSession, type Denied } from '@/lib/auth'
import { listSitesForUser } from '@/lib/sites'
import {
  accountForSite,
  addModule,
  scheduleRemoval,
  sitesForAccount,
  BASE_MODULE,
  DEVICE_MODULE_KEY,
  MODULE_KEYS,
  type ModuleKey,
} from '@/lib/control/modules'
import { safeBillingDay } from '@/lib/billing/period'

export type BillingChange = { siteId: number; moduleKey: string; want: boolean }

/**
 * Apply a set of module changes.
 *
 * ── THE CLIENT'S SITE LIST IS A SUGGESTION ──────────────────────────────────
 *
 * The permitted set is re-derived here from the account and from the sites this
 * user may open — never taken from the payload. Without that, this action reads
 * "change any store's modules by posting its id", and the id of a store you do
 * not own is a number between 1 and a few thousand.
 *
 * That is the same reasoning the checkout in the previous system used when it
 * re-derived prices rather than trusting a posted amount, and it is the line
 * that makes the rest of this file safe.
 */
export async function applyModuleChangesAction(
  changes: BillingChange[],
): Promise<{ ok: true; applied: number } | Denied> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx

  const session = await requireSession()
  const account = await accountForSite(ctx.siteId)
  if (!account) {
    return { ok: false, error: 'This store is not attached to a billing account yet.' }
  }

  // The two sets that decide what may be touched: on the bill, AND openable.
  const [onAccount, permitted] = await Promise.all([
    sitesForAccount(account.id),
    listSitesForUser(session.userId),
  ])
  const permittedIds = new Set(permitted.map((s) => s.id))
  const editable = new Set(
    onAccount.map((s) => s.siteId).filter((id) => permittedIds.has(id)),
  )

  const actor = { name: ctx.actor.userName, email: session.email }
  const billingDay = safeBillingDay(account.billingDay)

  let applied = 0
  const refusals: string[] = []

  for (const change of changes) {
    if (!editable.has(change.siteId)) {
      refusals.push('One of those stores is not on this billing account.')
      continue
    }
    if (change.moduleKey === BASE_MODULE) {
      refusals.push('The Starter Pack is part of every store’s plan.')
      continue
    }
    if (change.moduleKey === DEVICE_MODULE_KEY) {
      // Deliberately not editable here: the billed count IS the enforced count,
      // and a second way to change it would let the two drift apart again.
      refusals.push('Till licences are added under Setup → Tills.')
      continue
    }
    if (!isModuleKey(change.moduleKey)) {
      refusals.push('Unknown module.')
      continue
    }

    const result = change.want
      ? await addModule(change.siteId, change.moduleKey, actor, account.id)
      : await scheduleRemoval(change.siteId, change.moduleKey, actor, account.id, billingDay)

    if (result.ok) applied++
    else refusals.push(result.error)
  }

  /* A partial failure reports as a failure, and says how far it got. Reporting
     "done" after writing three of five changes would leave the customer
     believing they bought something they did not. */
  if (refusals.length > 0) {
    return {
      ok: false,
      error:
        applied > 0
          ? `${applied} change${applied === 1 ? '' : 's'} applied. ${refusals[0]}`
          : refusals[0],
    }
  }

  revalidatePath('/setup/billing')
  return { ok: true, applied }
}

function isModuleKey(value: string): value is ModuleKey {
  return (MODULE_KEYS as readonly string[]).includes(value)
}
