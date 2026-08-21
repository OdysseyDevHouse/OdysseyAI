'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Button, Card, CardBody, EmptyState, Callout, useToast, Icons } from '@/components/ui'
import { enrolMemberAction } from '@/app/(app)/loyalty/actions'

/**
 * What the Loyalty tab shows for a customer who has not joined.
 *
 * ── WHY THIS IS NOT AN ERROR ─────────────────────────────────────────────
 *
 * It used to be. The tab rendered "Loyalty could not be loaded for this
 * customer" whenever the lookup came back empty, which was reasonable when
 * every customer WAS a member — an empty result then really did mean something
 * had gone wrong.
 *
 * Joining is now deliberate, so "not a member" is the ordinary state of most
 * customers and the commonest thing this tab will ever show. A warning callout
 * for the normal case trains people to ignore warnings, and it offered nothing
 * to do about it.
 *
 * ── WHY THE NAME IS NOT ASKED FOR ────────────────────────────────────────
 *
 * The customer has one. Re-typing it here would let the two drift apart on the
 * screen that exists to link them, so enrolment takes the account's name and
 * phone as they stand. Someone who wants the membership under a different name
 * — a business account collecting on one person's card — can edit it after,
 * which is rarer than the case this optimises for.
 */
export function JoinLoyaltyPanel({
  customerId,
  customerName,
  customerPhone,
  customerEmail,
  enabled,
  canAdjust,
}: {
  customerId: number
  customerName: string
  customerPhone: string
  customerEmail: string
  /** Whether the programme is running at all. */
  enabled: boolean
  canAdjust: boolean
}) {
  const toast = useToast()
  const router = useRouter()
  const [pending, start] = useTransition()
  const [done, setDone] = useState(false)

  function join() {
    start(async () => {
      const result = await enrolMemberAction({
        name: customerName,
        phone: customerPhone || undefined,
        email: customerEmail || undefined,
        customerId,
      })
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(result.message)
      // Marked done as well as refreshed: the refresh re-runs the server
      // component and replaces this panel with the real tab, but the button
      // must not invite a second press while that is in flight.
      setDone(true)
      router.refresh()
    })
  }

  if (!enabled) {
    return (
      <Card>
        <CardBody>
          <EmptyState
            icon={<Icons.Gem />}
            title="The loyalty programme is not running"
            hint="Turn it on under Loyalty → Programme, and customers can start earning on their next sale."
          />
        </CardBody>
      </Card>
    )
  }

  return (
    <Card>
      <CardBody>
        <EmptyState
          icon={<Icons.Gem />}
          title={`${customerName} has not joined`}
          hint="Joining creates a membership linked to this account, so their points follow them across every store on the programme. Nothing about the account itself changes."
          action={
            canAdjust ? (
              <Button onClick={join} disabled={pending || done}>
                {pending ? 'Joining…' : done ? 'Joined' : 'Add to the programme'}
              </Button>
            ) : undefined
          }
        />
        {!canAdjust && (
          <Callout tone="brand" className="mt-3">
            Somebody with permission to adjust loyalty can enrol this customer.
          </Callout>
        )}
      </CardBody>
    </Card>
  )
}
