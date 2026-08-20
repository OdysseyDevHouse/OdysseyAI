'use client'

import { useActionState, useState } from 'react'
import { useFormStatus } from 'react-dom'
import {
  Badge,
  Button,
  Callout,
  Card,
  CardBody,
  CardFooter,
  Field,
  Icons,
  SectionTitle,
  Select,
} from '@/components/ui'
import type { GroupMember } from '@/lib/storeGroups'
import { setPrimaryAction, type LinkFormState } from './actions'

/**
 * Which store is head office.
 *
 * ── WHY THIS SCREEN NEEDED A CARD AT ALL ─────────────────────────────────
 *
 * `cp2_store_groups.primary_site_id` has always decided this, and everything
 * built on it reads that column — the shared customer file resolver, the
 * sharing gates, the group storefront. But it was written ONCE, when the first
 * store was linked, and no screen ever showed it or let anybody change it.
 *
 * So a required setting was invisible: you could not tell which store held the
 * group's files, and could not move it if the wrong one had been picked.
 *
 * ── IT SAYS WHAT HEAD OFFICE DOES, NOT JUST WHICH ONE IT IS ──────────────
 *
 * "Primary store" means nothing to somebody setting this up. The consequences
 * do: its database holds the shared customer and supplier files, it serves the
 * group storefront, and shared products are edited from it. A person choosing
 * between two shops needs to know that the choice decides where the debtors
 * book physically lives.
 */

function SaveButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" variant="secondary" disabled={disabled || pending}>
      {pending ? 'Moving…' : 'Move head office'}
    </Button>
  )
}

export default function HeadOfficeCard({
  members,
  primarySiteId,
}: {
  members: GroupMember[]
  /** Null while no store has been named — the group cannot share files yet. */
  primarySiteId: number | null
}) {
  const [state, formAction] = useActionState<LinkFormState, FormData>(setPrimaryAction, {
    error: null,
  })
  // Re-synced when the saved value changes, for the reason spelled out in
  // LegalEntityCard: useState reads its initial value once, and this component
  // never unmounts, so after a save the picker would still show the old store.
  const [choice, setChoice] = useState(primarySiteId ? String(primarySiteId) : '')
  const [savedPrimary, setSavedPrimary] = useState(primarySiteId)
  if (savedPrimary !== primarySiteId) {
    setSavedPrimary(primarySiteId)
    setChoice(primarySiteId ? String(primarySiteId) : '')
  }

  const primary = members.find((m) => m.siteId === primarySiteId) ?? null
  const sharing = members.filter((m) => m.sharesCustomers || m.sharesSuppliers)

  return (
    <Card>
      <SectionTitle
        icon={<Icons.Building2 size={16} />}
        action={
          primary ? (
            <Badge tone="brand">{primary.displayName}</Badge>
          ) : (
            <Badge tone="warning">Not chosen</Badge>
          )
        }
      >
        Head office
      </SectionTitle>

      <form action={formAction}>
        <CardBody className="flex flex-col gap-4">
          {state.error && <Callout tone="danger">{state.error}</Callout>}

          <div className="text-sm text-muted">
            <p>Head office is where the group&apos;s shared records physically live:</p>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              <li>
                Its database holds the <strong>shared customer and supplier files</strong>,
                so every other store reads and writes them there.
              </li>
              <li>Its shop is the one a group storefront serves.</li>
              <li>Shared products are edited from it.</li>
            </ul>
          </div>

          {!primarySiteId && (
            <Callout tone="warning">
              Choose a store before switching on any shared customer or supplier file.
            </Callout>
          )}

          {sharing.length > 0 && (
            <Callout tone="warning">
              {sharing.length} store{sharing.length === 1 ? '' : 's'} currently share a
              customer or supplier file, which lives in {primary?.displayName ?? 'head office'}
              &apos;s database. Switch that sharing off before moving head office —
              otherwise those stores would be reading a database that no longer holds
              their customers.
            </Callout>
          )}

          <Field
            label="Which store is head office?"
            hint="Only stores with a database can hold the group's files."
          >
            <Select
              name="primarySiteId"
              value={choice}
              onChange={(e) => setChoice(e.target.value)}
              disabled={sharing.length > 0}
            >
              <option value="">Choose a store…</option>
              {members
                .filter((m) => m.hasDatabase)
                .map((m) => (
                  <option key={m.siteId} value={m.siteId}>
                    {m.siteCode} — {m.displayName}
                  </option>
                ))}
            </Select>
          </Field>
        </CardBody>

        <CardFooter>
          <SaveButton
            disabled={
              choice === '' || choice === String(primarySiteId ?? '') || sharing.length > 0
            }
          />
        </CardFooter>
      </form>
    </Card>
  )
}
