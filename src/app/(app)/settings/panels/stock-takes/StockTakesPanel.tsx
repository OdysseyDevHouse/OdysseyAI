'use client'

import { PanelState, usePanelData } from '../usePanelData'
import { loadStockTakeSettingsAction, type StockTakeSettings } from './actions'
import StockTakeSettingsClient from './StockTakeSettingsClient'

/**
 * Stock takes — when a counted difference needs a second signature.
 * Moved from /setup/stock-takes.
 */
export default function StockTakesPanel() {
  const { data, error } = usePanelData<{ settings: StockTakeSettings }>(
    loadStockTakeSettingsAction,
  )

  if (!data) return <PanelState error={error} rows={2} />
  return <StockTakeSettingsClient settings={data.settings} />
}
