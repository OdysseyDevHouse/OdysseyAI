'use server'

import { revalidatePath } from 'next/cache'
import { actorForModule } from '@/lib/auth'
import { getSettings, setSetting } from '@/lib/site/settings'
import { lotCaptureFor } from '@/lib/gs1'

/**
 * Lot capture and scale-barcode setup.
 *
 * Guarded like every other setup screen. A server action is a public endpoint
 * regardless of who can see the page, and this one decides whether a pharmacy's
 * till refuses an untraceable sale — so the guard is the real boundary.
 */

export type StockTrackingSettings = {
  lotCaptureMode: 'fefo' | 'barcode' | 'prompt'
  lotCaptureStrict: boolean
  barcodePrefix: string
  barcodePluLength: string
  barcodeValueDivisor: string
}

/**
 * What this panel renders, in one read.
 *
 * New with the move out of /setup: the screen used to be a route whose page.tsx
 * did this read on the server. As a TAB of /settings there is no page of its
 * own, so the panel asks for its own state when opened — see `usePanelData`.
 *
 * Guarded on the MODULE as well as the capability, exactly as the page it
 * replaces was. The settings shell hides the tab from a shop without Advanced
 * Inventory, but a hidden tab is still a `?tab=` somebody can type, and this is
 * the boundary that actually holds.
 */
export async function loadStockTrackingSettingsAction(): Promise<
  { ok: true; settings: StockTrackingSettings } | { ok: false; error: string }
> {
  const ctx = await actorForModule('inventory_advanced', 'setup.edit')
  if ('ok' in ctx) return ctx

  const settings = await getSettings(ctx.siteId, [
    'lot_capture_mode',
    'lot_capture_strict',
    'barcode_variable_prefix',
    'barcode_plu_length',
    'barcode_value_divisor',
  ])

  // Resolved through the same function the tills use, so the screen shows the
  // rule actually in force rather than the raw pair — a stored strict=1 under
  // 'fefo' is not what the till does, and must not be what the switch shows.
  const capture = lotCaptureFor(settings)

  return {
    ok: true,
    settings: {
      lotCaptureMode: capture.mode,
      lotCaptureStrict: capture.strict,
      barcodePrefix: settings.barcode_variable_prefix ?? '2',
      barcodePluLength: settings.barcode_plu_length ?? '5',
      barcodeValueDivisor: settings.barcode_value_divisor ?? '100',
    },
  }
}

export async function saveStockTrackingSettingsAction(
  input: StockTrackingSettings,
): Promise<{ ok: true; message: string; settings: StockTrackingSettings } | { ok: false; error: string }> {
  /* The module as well as the capability, matching the load beside it and the
     page this screen used to be. Previously `setup.edit` alone, which was safe
     only because the screen behind it was module-gated — as a tab of /settings
     that page no longer exists, so the guard has to carry the module itself. */
  const ctx = await actorForModule('inventory_advanced', 'setup.edit')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx

  /*
   * Strict is stored as 0 whenever the mode is 'fefo'.
   *
   * `lotCaptureFor` already forces it off at the point of use, so this is not
   * what makes the behaviour right — it is what stops the DATABASE holding a
   * combination that reads as a promise the till never keeps. Somebody reading
   * the settings table later should not have to know the resolver's rule to
   * understand what the shop does.
   */
  const strict = input.lotCaptureMode === 'fefo' ? '0' : input.lotCaptureStrict ? '1' : '0'

  // Each is validated by setSetting, and the FIRST refusal is returned rather
  // than saving what passed: a half-saved policy is worse than none, because
  // the shop would believe the whole of it applied.
  for (const [key, value] of [
    ['lot_capture_mode', input.lotCaptureMode],
    ['lot_capture_strict', strict],
    ['barcode_variable_prefix', input.barcodePrefix.trim()],
    ['barcode_plu_length', input.barcodePluLength.trim()],
    ['barcode_value_divisor', input.barcodeValueDivisor.trim()],
  ] as const) {
    const result = await setSetting(siteId, key, value)
    if (!result.ok) return result
  }

  revalidatePath('/settings')

  return {
    ok: true,
    message: 'Stock tracking settings saved.',
    settings: { ...input, lotCaptureStrict: strict === '1' },
  }
}
