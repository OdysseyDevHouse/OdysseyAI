'use client'

import { PanelState, usePanelData } from '../usePanelData'
import { loadSystemPanelAction, type SystemPanelState } from './actions'
import ApiScreen from './ApiScreen'

/**
 * System — the store's machine door. Moved from /setup/api.
 *
 * API keys and outbound webhooks: standing access with no person behind it,
 * which is why the tab wears `setup.api` rather than riding on setup.view.
 */
export default function SystemPanel() {
  const { data, error } =
    usePanelData<Omit<Extract<SystemPanelState, { ok: true }>, 'ok'>>(loadSystemPanelAction)

  if (!data) return <PanelState error={error} rows={4} />
  return (
    <ApiScreen
      keys={data.keys}
      endpoints={data.endpoints}
      deliveries={data.deliveries}
      reference={data.reference}
    />
  )
}
