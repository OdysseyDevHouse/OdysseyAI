'use client'

import { bridgeConfig, printRaw } from '@/lib/printBridge'
import { renderReceipt, renderKitchenTicket, type KitchenTicketData } from '@/lib/escpos/slips'
import { EscPos } from '@/lib/escpos/encoder'
import { renderSlipSpec } from '@/lib/escpos/slipSpec'
import { parseSlip, validateSlip } from '@/lib/stationery/slip'
import type { ReceiptData } from '@/lib/receiptData'

/**
 * The till's printing decisions, out of PosShell so the shell stays wiring.
 *
 * Policy, stated once: the DRAWER KICK fires the moment a qualifying sale
 * posts (a cashier owed change cannot wait for a print decision), while PAPER
 * prints on the modal's Print tap — shops that hate paper exist, and
 * auto-print-every-sale is a future setting, not a default.
 */

export function hasBridgeSlipPrinter(): boolean {
  const config = bridgeConfig()
  return !!config && !!config.receiptPrinter
}

export function hasBridgeKitchenPrinter(): boolean {
  const config = bridgeConfig()
  return !!config && !!config.kitchenPrinter
}

/**
 * Kicks the drawer, alone — the payoff of `tender_types.opens_cash_drawer`.
 * Quietly a no-op when this machine has no bridge or turned kicking off:
 * a shop without a wired drawer must not see an error on every cash sale.
 */
export async function kickDrawer(): Promise<void> {
  const config = bridgeConfig()
  if (!config || !config.drawerKick || !config.receiptPrinter) return
  const job = new EscPos().init().drawerKick().build()
  await printRaw('receipt', job).catch(() => {})
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

/** Prints a slip through the bridge. The caller falls back to the browser. */
export async function printSlipViaBridge(
  receipt: ReceiptData,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const config = bridgeConfig()
  if (!config || !config.receiptPrinter) {
    return { ok: false, error: 'No print bridge is set up on this machine.' }
  }

  /*
   * A designed slip, when the shop has one. parseSlip drops anything this
   * build no longer understands and returns null if the JSON is unreadable, so
   * a design written by a later version costs a block rather than the sale.
   */
  const design = await activeSlipDesign()
  if (design) {
    const spec = parseSlip(design)
    if (spec && validateSlip(spec).ok) {
      return printRaw('receipt', renderSlipSpec(spec, receipt, { columns: config.columns }))
    }
  }

  return printRaw('receipt', renderReceipt(receipt, { columns: config.columns }))
}

/** Prints a kitchen ticket. The caller already checked a printer exists. */
export async function printKitchenViaBridge(
  ticket: KitchenTicketData,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const config = bridgeConfig()
  if (!config || !config.kitchenPrinter) {
    return { ok: false, error: 'Set up the kitchen printer on this till first — Setup → Printing.' }
  }
  return printRaw('kitchen', renderKitchenTicket(ticket, { columns: config.columns }))
}
