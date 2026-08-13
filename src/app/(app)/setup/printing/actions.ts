'use server'

import { revalidatePath } from 'next/cache'
import { actorFor } from '@/lib/auth'
import { setSetting } from '@/lib/site/settings'

/**
 * Printing settings — the SITE half.
 *
 * Only the slip footer lives on the server; everything about printers is a
 * property of one MACHINE (which bridge, which printer names, how many
 * columns) and lives in that browser's localStorage, saved by the client
 * component directly. A server action for per-machine state would store one
 * machine's cabling as everyone's.
 */

export type ActionResult = { ok: true; message: string } | { ok: false; error: string }

export async function savePrintingSettingsAction(input: {
  footerText: string
}): Promise<ActionResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx

  const result = await setSetting(ctx.siteId, 'receipt_footer_text', input.footerText.trim())
  if (!result.ok) return result

  revalidatePath('/setup/printing')
  return { ok: true, message: 'Printing settings saved.' }
}
