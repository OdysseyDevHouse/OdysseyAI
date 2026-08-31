'use client'

import { PanelState, usePanelData } from '../usePanelData'
import { loadOnlineBookingsAction, type OnlineBookingsState } from './actions'
import OnlineBookingsForm from './OnlineBookingsForm'

/**
 * Online bookings — whether guests can book a table, and the times offered.
 * Moved from /setup/reservations, and renamed with the move.
 *
 * "Reservations" was ambiguous in this codebase: it also names the stock a job
 * card claims (job_stock_reservations), which is an unrelated thing. "Online
 * bookings" says which of the two this is.
 */
export default function OnlineBookingsPanel() {
  const { data, error } =
    usePanelData<Omit<Extract<OnlineBookingsState, { ok: true }>, 'ok'>>(
      loadOnlineBookingsAction,
    )

  if (!data) return <PanelState error={error} rows={4} />
  return <OnlineBookingsForm settings={data.settings} reservePath={data.reservePath} />
}
