'use client'

import { useState } from 'react'
import { Modal, PinPad } from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import type { Capability } from '@/lib/site/permissions'
import { tillOverrideAction } from './pinActions'
import { overrideOffline } from '@/lib/posOffline/signInOffline'

/**
 * "Ask a manager" — the PIN pad that turns a refusal into an authorised act.
 *
 * The cashier STAYS signed in. The manager's PIN authorises exactly one
 * action: online it mints a two-minute single-capability token the till
 * attaches to the very next server call; offline it verifies against the
 * stored PBKDF2 verifiers and the authorisation rides the queued sale, where
 * the server re-derives the manager's rights at sync. Either way the audit
 * trail names the manager — a client-typed name is never what the server
 * trusts.
 */
export default function OverrideModal({
  open,
  siteId,
  online,
  capability,
  actionLabel,
  amount,
  documentId,
  terminalCode,
  cashierName,
  onClose,
  onAuthorised,
}: {
  open: boolean
  siteId: number
  online: boolean
  capability: Capability
  /** The sentence on the pad AND in the audit row: "25% discount on Bread". */
  actionLabel: string
  amount?: number
  documentId?: number | null
  terminalCode?: string | null
  cashierName: string
  onClose: () => void
  /** Token is '' offline — the authorisation rides the queued sale instead. */
  onAuthorised: (auth: { userId: number; name: string; token: string }) => void
}) {
  const [error, setError] = useState<string | null>(null)
  const [rejectedAt, setRejectedAt] = useState(0)
  const [busy, setBusy] = useState(false)

  async function submit(pin: string) {
    setBusy(true)
    setError(null)
    try {
      if (online) {
        const result = await tillOverrideAction(pin, capability, {
          action: actionLabel,
          amount,
          documentId,
          terminalCode,
          cashierName,
        })
        if (!result.ok) {
          setError(result.error)
          setRejectedAt(Date.now())
          return
        }
        onAuthorised({ userId: result.userId, name: result.authorisedBy, token: result.token })
      } else {
        const result = await overrideOffline(siteId, pin, capability)
        if (!result.ok) {
          setError(result.error)
          setRejectedAt(Date.now())
          return
        }
        onAuthorised({ userId: result.userId, name: result.name, token: '' })
      }
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Ask a manager" size="sm">
      <p className="mb-1 text-center text-sm text-ink-2">
        A manager's PIN approves:
      </p>
      <p className="mb-4 text-center text-sm font-semibold text-ink">
        {actionLabel}
        {amount !== undefined ? ` · ${formatMoney(amount)}` : ''}
      </p>
      <PinPad
        onSubmit={submit}
        onCancel={onClose}
        error={error ?? undefined}
        busy={busy}
        rejectedAt={rejectedAt}
        submitLabel="Approve"
      />
      <p className="mt-3 text-center text-xs text-muted">
        The approval covers this one action and is recorded under the manager's name.
      </p>
    </Modal>
  )
}
