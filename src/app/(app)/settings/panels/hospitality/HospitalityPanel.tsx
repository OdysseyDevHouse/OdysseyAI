'use client'

import { PanelState, usePanelData } from '../usePanelData'
import { loadTiersAction, type TierRow } from './actions'
import TipsClient from './TipsClient'

/**
 * Hospitality — service charges and where they apply. Moved from /setup/tips.
 *
 * The tab is "Hospitality" rather than "Tips" because service charges are the
 * first of what belongs here, not the whole of it: table service, and what a
 * sit-down bill is charged on top of the goods.
 */
export default function HospitalityPanel() {
  const { data, error } = usePanelData<{
    tiers: TierRow[]
    tablesOnly: boolean
    overlaps: number
  }>(loadTiersAction)

  if (!data) return <PanelState error={error} rows={3} />
  return (
    <TipsClient tiers={data.tiers} tablesOnly={data.tablesOnly} overlaps={data.overlaps} />
  )
}
