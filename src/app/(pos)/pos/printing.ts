'use client'

import { renderReceipt, renderBill, renderKitchenTicket, type KitchenTicketData } from '@/lib/escpos/slips'
import { EscPos } from '@/lib/escpos/encoder'
import { renderSlipSpec } from '@/lib/escpos/slipSpec'
import { parseSlip, validateSlip } from '@/lib/stationery/slip'
import { hasSlipPrinter as configHasSlipPrinter, planForDoc, slipColumns } from '@/lib/print/deviceConfig'
import { sendRawFor, sendToSlipPrinter, type SendResult } from '@/lib/print/send'
import { shellCanPrint, shellSendRaw, shellTargetFor } from '@/lib/print/shell'
import type { PrinterConnection } from '@/lib/printing/resolve'
import type { ReceiptData } from '@/lib/receiptData'
import type { BillData } from '@/lib/billData'

/**
 * The till's printing decisions, out of PosShell so the shell stays wiring.
 *
 * Policy, stated once: the DRAWER KICK fires the moment a qualifying sale
 * posts (a cashier owed change cannot wait for a print decision), while PAPER
 * prints on the modal's Print tap — shops that hate paper exist, and
 * auto-print-every-sale is a future setting, not a default.
 *
 * ── WHAT CHANGED WHEN THE BRIDGE WENT ─────────────────────────────────────
 *
 * These used to be `…ViaBridge`, and the names lied the moment a machine could
 * reach a printer four different ways. What they always meant was "print this
 * without a dialog", so that is what they are called now. Where the bytes
 * actually go is decided by lib/print/deviceConfig from the shop's own setup,
 * and the transport by the desktop shell's engine.
 *
 * The contract with the caller is unchanged and is the important part: these
 * return a failure the caller may fall back from, they never throw, and a
 * fallback is always to the (print) route the browser can handle on its own.
 */

/** Whether a slip can print without a dialog. Synchronous — see deviceConfig. */
export function hasSlipPrinter(): boolean {
  return configHasSlipPrinter()
}

/*
 * `hasBridgeKitchenPrinter` went with the bridge's `kitchenPrinter` slot.
 *
 * Whether a kitchen ticket can print is not a property of this machine alone:
 * it depends on which printers the PRODUCTS route to and whether this machine
 * can reach each of those — both of which live on the server. The send path
 * answers it per ticket and names the printer it cannot reach, which is the
 * thing somebody can actually act on.
 */

/**
 * Kicks the drawer, alone — the payoff of `tender_types.opens_cash_drawer`.
 *
 * Quietly a no-op when this machine has no printer or has drawer kicking turned
 * off: a shop without a wired drawer must not see an error on every cash sale.
 *
 * ── IT CANNOT WORK ON A DRIVER-PRINTED JOB ────────────────────────────────
 *
 * `ESC p 0 25 250` is raw ESC/POS. A GDI printer driver renders it as
 * characters or drops it, so a machine whose slip printer is reached only
 * through a driver has no drawer kick from Odyssey at all. The usual fix is a
 * second, raw target for the same physical printer — which is another reason
 * printTransports serialises per printer, because the drawer job and the
 * receipt then hit one head milliseconds apart.
 *
 * The no-op is LOGGED rather than silent, so "the drawer stopped opening" is
 * answerable from the console instead of by elimination.
 */
export async function kickDrawer(): Promise<void> {
  const plan = planForDoc('slip')
  if (plan.kind !== 'printer' || !plan.printer.drawerKick) {
    if (plan.kind === 'printer') {
      console.info('[print] drawer kick skipped — not switched on for', plan.printer.name)
    }
    return
  }
  const job = new EscPos().init().drawerKick().build()
  await sendToSlipPrinter(job).catch(() => undefined)
}

/**
 * This site's designed slip, or null for the shipped layout.
 *
 * Cached for the life of the page: a till prints many slips a shift and the
 * design changes about once a year, so re-asking on every print would be a
 * round trip between a tender and paper for an answer that never moves.
 *
 * Every failure resolves to null and the shipped layout prints. A slip that
 * will not come out because a settings lookup hiccupped is a queue at the
 * counter, and the fallback is the exact slip this till printed last week.
 */
let slipDesign: string | null | undefined
async function activeSlipDesign(): Promise<string | null> {
  if (slipDesign !== undefined) return slipDesign
  try {
    const res = await fetch('/api/pos/slip-design')
    const body = (await res.json()) as { design?: string | null }
    slipDesign = body.design ?? null
  } catch {
    slipDesign = null
  }
  return slipDesign
}

/** Prints a slip. The caller falls back to the browser on a failure. */
export async function printSlip(receipt: ReceiptData): Promise<SendResult> {
  const columns = slipColumns()

  /*
   * A designed slip, when the shop has one. parseSlip drops anything this
   * build no longer understands and returns null if the JSON is unreadable, so
   * a design written by a later version costs a block rather than the sale.
   */
  const design = await activeSlipDesign()
  if (design) {
    const spec = parseSlip(design)
    if (spec && validateSlip(spec).ok) {
      return sendRawFor('slip', renderSlipSpec(spec, receipt, { columns }))
    }
  }

  return sendRawFor('slip', renderReceipt(receipt, { columns }))
}

/**
 * Prints a gift slip — the same sale with the prices left off.
 *
 * Its own doc key so a shop can send it somewhere else, and `defaultsTo: 'slip'`
 * in the catalogue means it follows the till slip unless somebody says
 * otherwise. Nobody should have to configure it twice.
 */
export async function printGiftSlip(receipt: ReceiptData): Promise<SendResult> {
  const columns = slipColumns()
  const design = await activeSlipDesign()
  if (design) {
    const spec = parseSlip(design)
    if (spec && validateSlip(spec).ok) {
      return sendRawFor('gift_slip', renderSlipSpec(spec, receipt, { columns }))
    }
  }
  return sendRawFor('gift_slip', renderReceipt(receipt, { columns }))
}

/**
 * Prints a pro-forma bill. The caller falls back to the print route.
 *
 * No designed-slip branch, unlike `printSlip`: the stationery designer
 * describes a RECEIPT, and a bill is a different document — no number, no
 * tender, and a banner saying nothing has been paid. Running a receipt design
 * over bill data would print a slip claiming to be something it is not.
 */
export async function printBill(bill: BillData): Promise<SendResult> {
  return sendRawFor('bill', renderBill(bill, { columns: slipColumns() }))
}

/**
 * Prints ONE kitchen ticket to ONE printer.
 *
 * `queueName` arrives from the SERVER — this machine's resolved address for a
 * logical printer ("Bar"), which may be the shop's own network address or a
 * queue only this machine knows. The till does not choose it, and that is what
 * lets a manager fix a mis-routed printer from the back office instead of
 * walking to the counter.
 *
 * ── WHY THIS ONE DOES NOT GO THROUGH THE ASSIGNMENT TABLE ─────────────────
 *
 * Every other document has ONE destination on a machine. A kitchen ticket has
 * as many as the basket has stations, chosen per PRODUCT, and the server has
 * already worked out which. So the target is passed in rather than resolved
 * here — and the assignment table shows the row as "Routed per product" rather
 * than pretending otherwise.
 *
 * An unreachable printer names itself in the error. "This till has no printer
 * mapped for Grill" is a sentence somebody can act on; "kitchen printing
 * failed" is not.
 */
export async function printKitchen(
  target: { address: string; connection: PrinterConnection; port: number | null; columns: number | null },
  ticket: KitchenTicketData,
): Promise<SendResult> {
  if (!target.address.trim()) {
    return {
      ok: false,
      reason: 'error' as const,
      error: `This till has no printer set up for ${ticket.printerName || 'the kitchen'} — Setup → Printing.`,
    }
  }
  if (!shellCanPrint()) return { ok: false, reason: 'browser' }

  /* The width comes from the KITCHEN printer's own row, not the slip printer's:
     a shop with a 58mm docket printer at the pass and an 80mm head at the
     counter is ordinary, and one column count for both prints one of them
     wrong. */
  const bytes = renderKitchenTicket(ticket, { columns: target.columns ?? slipColumns() })

  const shellTarget = shellTargetFor({
    connection: target.connection,
    target: target.address,
    port: target.port,
  })
  if (!shellTarget) {
    return { ok: false, reason: 'error', error: `Could not reach ${ticket.printerName || 'the kitchen'}.` }
  }

  const result = await shellSendRaw(shellTarget, bytes)
  return result.ok ? { ok: true } : { ok: false, reason: 'error', error: result.error }
}
