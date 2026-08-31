'use server'

import { revalidatePath } from 'next/cache'
import { actorFor } from '@/lib/auth'
import { logActivity } from '@/lib/site/activityLog'
import { setSetting } from '@/lib/site/settings'

/**
 * Switching the customer account portal on and off.
 *
 * ── IT IS AUDITED, AND THE SWITCH GETS ITS OWN LINE ───────────────────────
 *
 * Turning this on publishes every customer's financial history to anyone who
 * can pass a mailed sign-in link. That is precisely the kind of change a shop
 * needs to be able to look back at and say who made it and when — so opening
 * and closing the portal is recorded as its own event rather than as an
 * anonymous "settings changed".
 */

export type PortalAccountSettingsInput = {
  accountsEnabled: boolean
  showTransactions: boolean
  showStatement: boolean
  allowPay: boolean
}

type Result = { ok: true } | { ok: false; error: string }

export async function savePortalAccountSettingsAction(
  input: PortalAccountSettingsInput,
): Promise<Result> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const { getSetting } = await import('@/lib/site/settings')
  const wasEnabled = (await getSetting(siteId, 'portal_accounts_enabled').catch(() => '0')) === '1'

  for (const [key, value] of [
    ['portal_accounts_enabled', input.accountsEnabled ? '1' : '0'],
    /*
     * The three sub-switches are stored even when the portal is off, so
     * switching it back on restores the choices somebody made rather than
     * resetting them. The READ (portalSettings) is what forces them false
     * while the portal is closed — one place decides, and it is the place
     * every guard already asks.
     */
    ['portal_show_transactions', input.showTransactions ? '1' : '0'],
    ['portal_show_statement', input.showStatement ? '1' : '0'],
    ['portal_allow_pay', input.allowPay ? '1' : '0'],
  ] as const) {
    const saved = await setSetting(siteId, key, value)
    if (!saved.ok) return saved
  }

  await logActivity(siteId, actor, {
    entity: 'customer',
    entityId: null,
    action:
      wasEnabled === input.accountsEnabled
        ? 'settings_update'
        : input.accountsEnabled
          ? 'opened'
          : 'closed',
    detail:
      wasEnabled === input.accountsEnabled
        ? 'Customer portal settings changed'
        : input.accountsEnabled
          ? 'Customer account portal switched on'
          : 'Customer account portal switched off',
  })

  revalidatePath('/setup/customer-portal')
  return { ok: true }
}
