'use client'

import { PanelState, usePanelData } from '../usePanelData'
import { loadStockTrackingSettingsAction, type StockTrackingSettings } from './actions'
import StockTrackingClient from './StockTrackingClient'

/**
 * Stock tracking — which lot a sale comes from, and how a scale label is read.
 * Moved from /setup/stock-tracking.
 */
export default function StockTrackingPanel() {
  const { data, error } = usePanelData<{ settings: StockTrackingSettings }>(
    loadStockTrackingSettingsAction,
  )

  if (!data) return <PanelState error={error} rows={3} />
  return <StockTrackingClient settings={data.settings} />
}
