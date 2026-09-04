'use client'

import { PanelState, usePanelData } from '../usePanelData'
import { loadStockTrackingSettingsAction, type StockTrackingSettings } from './actions'
import StockTrackingClient from './StockTrackingClient'

/**
 * Stock tracking — which lot a sale comes from, and when the till asks for it.
 *
 * Scale barcodes used to be the other half of this screen. They are a LIST now,
 * one shape per scale, and live at /setup/scale-barcodes.
 * Moved from /setup/stock-tracking.
 */
export default function StockTrackingPanel() {
  const { data, error } = usePanelData<{ settings: StockTrackingSettings }>(
    loadStockTrackingSettingsAction,
  )

  if (!data) return <PanelState error={error} rows={3} />
  return <StockTrackingClient settings={data.settings} />
}
