import { requireModuleCapability } from '@/lib/auth'
import { getSettings } from '@/lib/site/settings'
import { lotCaptureFor } from '@/lib/gs1'
import { PageHeader, PageBody } from '@/components/ui'
import StockTrackingClient from './StockTrackingClient'

export const dynamic = 'force-dynamic'

/**
 * Lot capture, and the scale-barcode format beside it.
 *
 * Gated on `inventory_advanced` as well as `setup.edit`, matching the Batches
 * screen: lot capture decides how a feature the shop may not have bought
 * behaves, and offering the choice without the module would be offering
 * something that cannot take effect.
 *
 * The scale-barcode settings live here rather than under Pricing because they
 * are about READING A LABEL, which is the same job as reading a lot off one.
 * They have existed since 015 with no screen at all — only SQL could change
 * them — so this gives them their first one.
 */
export default async function StockTrackingSetupPage() {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireModuleCapability('inventory_advanced', 'setup.edit')

  const settings = await getSettings(siteId, [
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

  return (
    <>
      <PageHeader
        title="Stock tracking"
        subtitle="Which lot a sale comes from, and how a scale label is read"
      />

      <PageBody>
        <StockTrackingClient
          settings={{
            lotCaptureMode: capture.mode,
            lotCaptureStrict: capture.strict,
            barcodePrefix: settings.barcode_variable_prefix ?? '2',
            barcodePluLength: settings.barcode_plu_length ?? '5',
            barcodeValueDivisor: settings.barcode_value_divisor ?? '100',
          }}
        />
      </PageBody>
    </>
  )
}
