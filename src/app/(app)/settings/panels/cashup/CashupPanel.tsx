'use client'

import { PanelState, usePanelData } from '../usePanelData'
import { loadCashupPanelAction, type CashupPanelState } from './actions'
import CashupSettingsClient from './CashupSettingsClient'

/** Cash up — what a drawer is counted against. Moved from /setup/cashup. */
export default function CashupPanel() {
  const { data, error } =
    usePanelData<Omit<Extract<CashupPanelState, { ok: true }>, 'ok'>>(loadCashupPanelAction)

  if (!data) return <PanelState error={error} rows={4} />
  return (
    <CashupSettingsClient
      settings={data.settings}
      mode={data.mode}
      openShiftCount={data.openShiftCount}
      currency={data.currency}
      denominations={data.denominations}
      currencies={data.currencies}
    />
  )
}
