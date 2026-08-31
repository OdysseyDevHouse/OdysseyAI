'use client'

import { PanelState, usePanelData } from '../usePanelData'
import { loadPurchasingSettingsAction, type PurchasingSettings } from './actions'
import PurchasingSettingsClient from './PurchasingSettingsClient'

/** Purchasing & cost, as a tab of /settings. Moved from /setup/purchasing. */
export default function PurchasingPanel() {
  const { data, error } = usePanelData<{ settings: PurchasingSettings }>(
    loadPurchasingSettingsAction,
  )

  if (!data) return <PanelState error={error} rows={4} />
  return <PurchasingSettingsClient settings={data.settings} />
}
