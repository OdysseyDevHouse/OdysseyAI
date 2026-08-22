'use client'

import { useActionState, useState } from 'react'
import { useFormStatus } from 'react-dom'
import {
  Accordion,
  Badge,
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  Field,
  Icons,
  Input,
  SettingRow,
  Switch,
} from '@/components/ui'
import type { GroupMember } from '@/lib/storeGroups'
import {
  refreshBranchPinsAction,
  setBranchPinAction,
  setGroupStorefrontAction,
  type GroupFormState,
} from './actions'

/**
 * One online shop for the whole group.
 *
 * With this on, the primary store's catalogue is what every shopper browses, and
 * the order they place goes to the branch nearest them — that branch's stock,
 * its delivery charges, its order queue. With it off, each store keeps its own
 * separate storefront, which is where they all start.
 *
 * The pins are what "nearest" means. They are typed in by hand because this app
 * talks to no mapping service, and a branch left unpinned is still perfectly
 * choosable from the list — it just cannot be sorted by distance.
 */

export type BranchRow = {
  siteId: number
  displayName: string
  latitude: number | null
  longitude: number | null
  acceptsOnline: boolean
  syncedAt: string | null
}

function SubmitButton({ children, variant = 'secondary' }: { children: string; variant?: 'primary' | 'secondary' }) {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" variant={variant} disabled={pending}>
      {pending ? 'Saving…' : children}
    </Button>
  )
}

function PinForm({ branch }: { branch: BranchRow }) {
  const [state, formAction] = useActionState<GroupFormState, FormData>(setBranchPinAction, {
    error: null,
  })

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="siteId" value={branch.siteId} />
      {state.error && <Callout tone="danger">{state.error}</Callout>}

      {/* No example coordinates as placeholders. A real-looking pair in an empty
          field reads as a value that is already set — and the one place that
          matters is the unpinned branch, where somebody could save head office's
          coordinates onto a shop in another suburb without noticing. */}
      <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <Field label="Latitude">
          <Input
            name="latitude"
            defaultValue={branch.latitude ?? ''}
            inputMode="decimal"
            className="numeric"
          />
        </Field>
        <Field label="Longitude">
          <Input
            name="longitude"
            defaultValue={branch.longitude ?? ''}
            inputMode="decimal"
            className="numeric"
          />
        </Field>
        <SubmitButton>Save pin</SubmitButton>
      </div>
    </form>
  )
}

export default function GroupStorefront({
  enabled,
  primaryName,
  branches,
  members,
}: {
  enabled: boolean
  /** Null when the group has no primary — the switch cannot be used yet. */
  primaryName: string | null
  branches: BranchRow[]
  members: GroupMember[]
}) {
  const [on, setOn] = useState(enabled)
  /*
   * Which branch is being pinned, or null for none.
   *
   * One at a time, and shut by default. Twenty branches is a normal size for a
   * chain and twenty open coordinate forms is most of this screen — which is
   * fine on a page about the group and wrong on a page that is mostly about
   * THIS shop's own settings. Folded, the list reads as what it is: a roll of
   * branches with a state each, that you open when you have a pair to type in.
   */
  const [pinning, setPinning] = useState<number | null>(null)
  const [toggleState, toggleAction] = useActionState<GroupFormState, FormData>(
    setGroupStorefrontAction,
    { error: null },
  )
  const [refreshState, refreshAction] = useActionState<GroupFormState, FormData>(
    refreshBranchPinsAction,
    { error: null },
  )

  const byId = new Map(branches.map((b) => [b.siteId, b]))
  const rows = members
    .filter((m) => m.hasDatabase)
    .map((m) => byId.get(m.siteId) ?? {
      siteId: m.siteId,
      displayName: m.displayName,
      latitude: null,
      longitude: null,
      acceptsOnline: false,
      syncedAt: null,
    })

  const unpinned = rows.filter((r) => r.latitude === null || r.longitude === null).length
  const openOnline = rows.filter((r) => r.acceptsOnline).length

  return (
    <Card>
      <CardHeader
        title="One online shop for the group"
        description={
          primaryName
            ? `Shoppers browse ${primaryName}'s products and order from the branch nearest them.`
            : 'Choose which store owns the shared product file before switching this on.'
        }
        action={
          <form action={refreshAction}>
            <Button type="submit" variant="ghost" size="sm">
              <Icons.Refresh size={14} />
              Refresh
            </Button>
          </form>
        }
      />
      <CardBody>
        <div className="flex flex-col gap-5">
          {toggleState.error && <Callout tone="danger">{toggleState.error}</Callout>}
          {refreshState.error && <Callout tone="warning">{refreshState.error}</Callout>}

          <form action={toggleAction}>
            {/* The switch posts through a hidden field so the form carries its
                value: Switch is a controlled component, not an <input>. */}
            <input type="hidden" name="enabled" value={on ? 'on' : 'off'} />
            <SettingRow
              icon={<Icons.Store size={16} />}
              label="Run one storefront for every branch"
              description="Off means each store keeps its own separate online shop."
            >
              <div className="flex items-center gap-3">
                <Switch
                  checked={on}
                  onChange={setOn}
                  ariaLabel="Run one storefront for every branch"
                  disabled={!primaryName}
                />
                {on !== enabled && <SubmitButton variant="primary">Apply</SubmitButton>}
              </div>
            </SettingRow>
          </form>

          {on && openOnline === 0 && (
            <Callout tone="warning" title="No branch is taking online orders">
              Switch the online shop on in at least one branch, then press Refresh. Until then
              shoppers have nowhere to order from.
            </Callout>
          )}

          {on && unpinned > 0 && (
            <Callout tone="warning" title={`${unpinned} branch${unpinned === 1 ? '' : 'es'} not on the map`}>
              They still appear in the list for shoppers to choose by name — they just cannot be
              sorted by distance. Add coordinates below to include them.
            </Callout>
          )}

          <div className="flex flex-col gap-2">
            {rows.map((branch) => (
              <Accordion
                key={branch.siteId}
                title={branch.displayName}
                open={pinning === branch.siteId}
                onToggle={() =>
                  setPinning((cur) => (cur === branch.siteId ? null : branch.siteId))
                }
                /* The two things worth knowing without opening the row: is this
                   branch taking orders at all, and can it be sorted by distance.
                   Both are the reason somebody would open it. */
                badge={
                  <span className="flex items-center gap-2">
                    {branch.latitude === null && <Badge tone="warning">Not on the map</Badge>}
                    {branch.acceptsOnline ? (
                      <Badge tone="success">Taking online orders</Badge>
                    ) : (
                      <Badge tone="neutral">Online shop off</Badge>
                    )}
                  </span>
                }
              >
                <PinForm branch={branch} />
              </Accordion>
            ))}
          </div>

          <p className="text-sm text-muted">
            Coordinates come from the store&rsquo;s main stock location. Right-click a spot in
            Google Maps and copy the pair to fill these in.
          </p>
        </div>
      </CardBody>
    </Card>
  )
}
