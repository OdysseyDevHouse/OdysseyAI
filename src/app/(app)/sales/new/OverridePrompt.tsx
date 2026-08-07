'use client'

import { useState, useTransition } from 'react'
import { Modal, PinPad, Icons } from '@/components/ui'
import { tillOverrideAction } from './pinActions'
import type { Capability } from '@/lib/site/permissions'

/**
 * A supervisor authorising one thing, without taking over the till.
 *
 * The alternative — making the cashier sign out so a manager can sign in — is
 * how a queue forms. It also attributes the sale to the wrong person, because
 * whoever is signed in when the sale posts is who it belongs to.
 *
 * So this deliberately does NOT change the till session. It asks for a PIN,
 * checks that person holds the capability, and hands back their name. The
 * cashier stays signed in and the sale stays theirs.
 */
export default function OverridePrompt({
  capability,
  title,
  reason,
  onAuthorised,
  onCancel,
}: {
  capability: Capability
  title: string
  /** What is being authorised, in the words the cashier just saw. */
  reason: string
  onAuthorised: (authorisedBy: string) => void
  onCancel: () => void
}) {
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  function submit(pin: string) {
    setError(null)
    startTransition(async () => {
      const result = await tillOverrideAction(pin, capability)
      if (!result.ok) {
        setError(result.error)
        return
      }
      onAuthorised(result.authorisedBy)
    })
  }

  return (
    <Modal
      open
      onClose={onCancel}
      title={title}
      description="A supervisor's PIN authorises this one line. It does not sign anybody in or out."
      closeOnBackdrop={false}
    >
      <div className="flex flex-col items-center gap-5 py-2">
        <div className="flex items-start gap-2 self-stretch rounded-control bg-warning-soft px-3 py-2.5 text-sm">
          <Icons.StatusWarning size={16} className="mt-0.5 shrink-0 text-warning" />
          <span className="text-ink">{reason}</span>
        </div>

        <PinPad
          onSubmit={submit}
          onCancel={onCancel}
          error={error}
          busy={pending}
          submitLabel="Authorise"
        />
      </div>
    </Modal>
  )
}
