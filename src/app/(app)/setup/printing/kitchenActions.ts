'use server'

import { revalidatePath } from 'next/cache'
import { actorFor } from '@/lib/auth'
import { setSetting } from '@/lib/site/settings'

/**
 * Kitchen printing — what is left that is genuinely about food.
 *
 * Creating a printer, naming it and saying how a machine reaches it used to
 * live here. None of those turned out to be kitchen questions: every document
 * has a printer and every machine reaches it somehow, so 246 generalised them
 * into printerActions.ts and deviceActions.ts.
 *
 * What stays is the one switch that only a kitchen has — whether saving a tab
 * fires the food automatically. Product routing lives on the product.
 */

export type ActionResult = { ok: true; message: string } | { ok: false; error: string }

/** The site-wide switch for firing food automatically when a tab is saved. */
export async function setAutoPrintKitchenAction(enabled: boolean): Promise<ActionResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx

  const result = await setSetting(ctx.siteId, 'pos_auto_print_kitchen', enabled ? '1' : '0')
  if (!result.ok) return result

  revalidatePath('/setup/printing')
  return {
    ok: true,
    message: enabled
      ? 'Saving a tab will send new items to the kitchen.'
      : 'Automatic sending is off — use the Send to kitchen key.',
  }
}
