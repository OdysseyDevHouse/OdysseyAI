'use client'

import { useState, useTransition } from 'react'
import { Card, CardHeader, CardBody, Button, Checkbox, Callout, useToast } from '@/components/ui'
import { setOfflineAccountSalesAction } from './actions'

/**
 * Whether a till with no connection may still sell on account.
 *
 * ── THE DECISION THIS PUTS IN FRONT OF AN OWNER ───────────────────────────
 *
 * A till offline cannot check a credit limit — the balance lives on the server,
 * and `creditRefusal` runs before any write precisely so a stale figure can
 * never authorise credit. So an account sale is refused when the line is down.
 *
 * For a counter shop that costs almost nothing: most invoices carry no account
 * tender at all and go through offline as normal. But a TRADE counter is the
 * other case — its account customers are the regulars with a vehicle outside,
 * and a shop that can serve cash walk-ins while turning those people away is a
 * shop that has effectively closed.
 *
 * Software cannot settle that. It is a credit judgement about a shop's own
 * customers, so it is a setting, and the copy says what the owner is accepting
 * rather than what the checkbox does.
 *
 * ── WHY THERE IS NO RAND CEILING ──────────────────────────────────────────
 *
 * It was the obvious refinement and it is deliberately absent. A per-sale cap
 * reads as protection while providing very little — nothing stops the same
 * customer making four sales under it — and a limit the till cannot verify is
 * not made verifiable by adding a second number it also cannot check. The
 * honest question has two answers, so this has two states.
 */
export default function OfflineAccountPanel({
  offlineAccountSales,
}: {
  offlineAccountSales: boolean
}) {
  const toast = useToast()
  const [on, setOn] = useState(offlineAccountSales)
  const [pending, startTransition] = useTransition()

  const dirty = on !== offlineAccountSales

  function save() {
    startTransition(async () => {
      const result = await setOfflineAccountSalesAction(on)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(result.message)
    })
  }

  return (
    <Card id="offline-account-sales">
      <CardHeader
        title="Account sales when the line is down"
        description="Whether a till with no connection may still put a sale on a customer's account."
      />
      <CardBody>
        <div className="flex flex-wrap items-center gap-4">
          <Checkbox
            label="Allow account sales while offline"
            checked={on}
            onChange={(e) => setOn(e.target.checked)}
          />
          <Button variant="primary" onClick={save} disabled={!dirty || pending}>
            Save
          </Button>
        </div>

        {/* Shown only when it is being turned ON, and worded as the risk rather
            than as a warning about the feature: an owner who has decided this
            deliberately does not need talking out of it, but they do need to
            know exactly what they have accepted. */}
        {on && (
          <Callout tone="warning" title="What this accepts" className="mt-3">
            The till will sell against the balance it last saw. A customer who was already at
            their limit when the connection dropped can keep buying, and the shop only finds
            out when the queued sales reach the server. Turn this on if you know your account
            customers.
          </Callout>
        )}

        <p className="pt-3 text-sm text-muted">
          Cash and card are never affected — they work offline either way. Loyalty and gift
          cards stay refused whatever this is set to: those balances can be drained from two
          tills at once, which is a correctness problem rather than a credit one.
        </p>
      </CardBody>
    </Card>
  )
}
