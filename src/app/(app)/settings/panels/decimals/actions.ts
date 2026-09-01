'use server'

import { revalidatePath } from 'next/cache'
import { actorFor } from '@/lib/auth'
import { getSettings, setSetting } from '@/lib/site/settings'

/**
 * How many decimals this shop shows on quantities and on costs.
 *
 * ── WHY THE TWO SHARE A SCREEN ──────────────────────────────────────────────
 *
 * They are one question — "how precise are the numbers on my screens" — asked
 * of the two figures where the answer differs by trade. A greengrocer weighs
 * everything and buys in round rands; a distributor counts whole cases and buys
 * at 0.0875 a unit. Splitting them across the stock and purchasing screens
 * would hide from each shop the half it actually needs.
 *
 * ── AND WHY THIS CHANGES NOTHING STORED ─────────────────────────────────────
 *
 * Both are DISPLAY rules. Quantities stay DECIMAL(12,3) and costs stay
 * DECIMAL(12,4), so lowering either hides precision rather than destroying it
 * — a shop that lowers one by mistake has lost nothing, and raising it again
 * returns its own figures rather than zeros.
 */

export type ActionResult = { ok: true; message: string } | { ok: false; error: string }

export type DecimalSettings = { qty: string; cost: string }

export async function saveDecimalSettingsAction(
  input: DecimalSettings,
): Promise<{ ok: true; message: string; settings: DecimalSettings } | { ok: false; error: string }> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx

  /* setSetting validates both — 0–3 for a quantity, matching DECIMAL(12,3),
     and 2–4 for a cost, matching DECIMAL(12,4). Offering a digit the column
     cannot hold would be a promise the database breaks. */
  const qty = await setSetting(siteId, 'qty_decimals', input.qty)
  if (!qty.ok) return qty

  const cost = await setSetting(siteId, 'cost_decimals', input.cost)
  if (!cost.ok) return cost

  /*
   * The whole authenticated tree. These two numbers are read once per request
   * in the layout and set on the formatters for every screen below it, so
   * nothing narrower than the layout would take effect — see lib/decimals.ts.
   */
  revalidatePath('/', 'layout')

  const saved = await getSettings(siteId, ['qty_decimals', 'cost_decimals'])
  return {
    ok: true,
    message: 'Display precision saved.',
    settings: { qty: saved.qty_decimals, cost: saved.cost_decimals },
  }
}

/**
 * The two settings this panel renders.
 *
 * New with the move out of /setup: the screen used to be a route whose page.tsx
 * read them on the server. As a TAB of /settings there is no page of its own,
 * so the panel asks when it is opened — see `usePanelData`.
 */
export type DecimalPanelState =
  | { ok: true; settings: DecimalSettings }
  | { ok: false; error: string }

export async function loadDecimalSettingsAction(): Promise<DecimalPanelState> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx

  const settings = await getSettings(ctx.siteId, ['qty_decimals', 'cost_decimals'])
  return { ok: true, settings: { qty: settings.qty_decimals, cost: settings.cost_decimals } }
}
