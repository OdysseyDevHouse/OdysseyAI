'use server'

import { revalidatePath } from 'next/cache'
import { actorFor } from '@/lib/auth'
import { setSetting } from '@/lib/site/settings'
import {
  createKitchenPrinter,
  renameKitchenPrinter,
  setKitchenPrinterActive,
  setTerminalPrinter,
} from '@/lib/site/kitchenPrinters'

/**
 * Kitchen printers — the setup half.
 *
 * Two kinds of write live here, and the split is the point. Creating and
 * naming a printer is a SITE fact ("this restaurant has a bar"); mapping one
 * onto a spool queue is a TILL fact ("on the patio till, the bar is
 * EPSON-TM20-2"). Both are server actions because both belong to the shop
 * rather than to a browser — which is what lets a manager set up a till's
 * routing without walking to it. See sql/site/229.
 */

export type ActionResult = { ok: true; message: string } | { ok: false; error: string }

export async function createKitchenPrinterAction(name: string): Promise<ActionResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx

  const result = await createKitchenPrinter(ctx.siteId, name)
  if (!result.ok) return result

  revalidatePath('/setup/printing')
  return { ok: true, message: `Added ${name.trim()}.` }
}

export async function renameKitchenPrinterAction(id: number, name: string): Promise<ActionResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx

  const result = await renameKitchenPrinter(ctx.siteId, id, name)
  if (!result.ok) return result

  revalidatePath('/setup/printing')
  return { ok: true, message: 'Renamed.' }
}

/**
 * Turns a printer off, or back on.
 *
 * Never deletes — kitchen_sends holds an ON DELETE RESTRICT foreign key, so a
 * printer that has ever cooked anything cannot be removed without taking its
 * history with it. Deactivating keeps every routing rule intact, so switching
 * it back on restores the shop's setup rather than asking somebody to re-tick
 * four hundred products.
 */
export async function setKitchenPrinterActiveAction(
  id: number,
  active: boolean,
): Promise<ActionResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx

  await setKitchenPrinterActive(ctx.siteId, id, active)
  revalidatePath('/setup/printing')
  return { ok: true, message: active ? 'Printer switched on.' : 'Printer switched off.' }
}

/**
 * Points one till's logical printer at one of its spool queues.
 *
 * An empty `bridgePrinter` CLEARS the mapping, which is how a shop says "this
 * till cannot reach the grill" — a real answer rather than a gap, and the send
 * path skips what it cannot reach instead of failing the whole ticket.
 */
export async function setTerminalPrinterAction(
  terminalId: number,
  printerId: number,
  bridgePrinter: string,
): Promise<ActionResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx

  await setTerminalPrinter(ctx.siteId, terminalId, printerId, bridgePrinter)
  revalidatePath('/setup/printing')
  return {
    ok: true,
    message: bridgePrinter.trim() ? 'Printer mapped for this till.' : 'Mapping cleared.',
  }
}

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
