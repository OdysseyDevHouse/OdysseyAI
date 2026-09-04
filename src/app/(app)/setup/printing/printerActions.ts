'use server'

import { revalidatePath } from 'next/cache'
import { actorFor } from '@/lib/auth'
import {
  createPrinter,
  updatePrinter,
  setPrinterActive,
  type PrinterInput,
} from '@/lib/site/printers'

/**
 * The shop's printer LIST — site-wide writes.
 *
 * Everything here is a fact about the business rather than about a machine:
 * that this restaurant has a grill, what paper is loaded in it, and — when it
 * is on the network — where it lives. Kept apart from deviceActions.ts for that
 * reason, because the two answer to different people: a manager owns the list,
 * and whoever is standing at a machine owns how that machine reaches it.
 *
 * The one that earns the separation is the address. A network printer's IP is
 * here, once, so moving it is one edit rather than one per till — which is the
 * whole reason the site half exists at all. See sql/site/246.
 */

export type ActionResult = { ok: true; message: string } | { ok: false; error: string }

export async function createPrinterAction(input: PrinterInput): Promise<ActionResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx

  const result = await createPrinter(ctx.siteId, input)
  if (!result.ok) return result

  revalidatePath('/setup/printing')
  return { ok: true, message: `Added ${input.name.trim()}.` }
}

export async function updatePrinterAction(id: number, input: PrinterInput): Promise<ActionResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx

  const result = await updatePrinter(ctx.siteId, id, input)
  if (!result.ok) return result

  revalidatePath('/setup/printing')
  return {
    ok: true,
    message:
      input.connection === 'network'
        ? `${input.name.trim()} is at ${input.target.trim()}.`
        : `${input.name.trim()} saved.`,
  }
}

/**
 * Turns a printer off, or back on.
 *
 * Never deletes — `kitchen_sends` holds an ON DELETE RESTRICT foreign key, so a
 * printer that has ever cooked anything cannot be removed without taking its
 * history with it. Deactivating keeps every routing rule and every document
 * assignment intact, so switching it back on restores the shop's setup rather
 * than asking somebody to re-tick four hundred products.
 */
export async function setPrinterActiveAction(id: number, active: boolean): Promise<ActionResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx

  await setPrinterActive(ctx.siteId, id, active)
  revalidatePath('/setup/printing')
  return { ok: true, message: active ? 'Printer switched on.' : 'Printer switched off.' }
}
