'use client'

import { PanelState, usePanelData } from '../usePanelData'
import { loadDecimalSettingsAction, type DecimalSettings } from './actions'
import DecimalSettingsClient from './DecimalSettingsClient'

/**
 * Decimal places — how precise the numbers on this shop's screens are.
 * Moved from /setup/decimals.
 */
export default function DecimalsPanel() {
  const { data, error } = usePanelData<{ settings: DecimalSettings }>(
    loadDecimalSettingsAction,
  )

  if (!data) return <PanelState error={error} rows={2} />
  return <DecimalSettingsClient initial={data.settings} />
}
