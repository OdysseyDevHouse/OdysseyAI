'use server'

import { revalidatePath } from 'next/cache'
import { actorFor } from '@/lib/auth'
import { setSetting } from '@/lib/site/settings'

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

export async function saveStockTrackingSettingsAction(
  input: StockTrackingSettings,
): Promise<{ ok: true; message: string; settings: StockTrackingSettings } | { ok: false; error: string }> {
  const ctx = await actorFor('setup.edit')
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

  revalidatePath('/setup/stock-tracking')

  return {
    ok: true,
    message: 'Stock tracking settings saved.',
    settings: { ...input, lotCaptureStrict: strict === '1' },
  }
}
