'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import {
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  Field,
  Icons,
  Input,
  Select,
} from '@/components/ui'
import type { GroupMember, StoreContents } from '@/lib/storeGroups'
import StoreCard from './StoreCard'
import GroupStorefront, { type BranchRow } from './GroupStorefront'
import { linkStoreAction, type LinkFormState } from './actions'

/**
 * Linking Odyssey stores together.
 *
 * Each store is its own site with its own master database. Linking them means a
 * product edited in one is written to the others as well, matched by product
 * code. The two per-store toggles decide whether cost and selling price travel
 * with that edit or whether each store keeps its own.
 */

function LinkButton() {
  const { pending } = useFormStatus()
  return (
    // The one primary on this screen: linking is the action the page exists
    // for. The per-store Save buttons stay secondary so they don't compete.
    <Button type="submit" variant="primary" disabled={pending}>
      <Icons.Plus size={15} />
      {pending ? 'Linking…' : 'Link store'}
    </Button>
  )
}

export default function LinkedStoresSetup({
  currentSiteId,
  currentSiteName,
  groupName,
  members,
  contents,
  available,
  groupStorefront,
}: {
  currentSiteId: number
  currentSiteName: string
  groupName: string | null
  members: GroupMember[]
  /** What each store already holds, for the empty-store gate. */
  contents: Record<number, StoreContents | null>
  available: { id: number; code: string; name: string }[]
  /** Null when these stores are not a group yet — there is nothing to configure. */
  groupStorefront: {
    enabled: boolean
    primaryName: string | null
    branches: BranchRow[]
  } | null
}) {
  const [state, formAction] = useActionState<LinkFormState, FormData>(linkStoreAction, {
    error: null,
  })

  const others = members.filter((m) => m.siteId !== currentSiteId)

  return (
    <div className="flex flex-col gap-5">
      {/* The card header alone carries the empty state — it already names what
          is missing and what to do next, so an EmptyState under it would just
          say the same thing twice. */}
      <Card>
        <CardHeader
          title={groupName ?? 'Not linked yet'}
          description={
            others.length
              ? `${currentSiteName} shares products with ${others.length} other store${others.length === 1 ? '' : 's'}.`
              : `${currentSiteName} is standalone. Link another store below to share products with it.`
          }
        />
      </Card>

      {/* Above the per-store cards because it decides what the group IS to a
          shopper, where those decide what each store contributes to a product
          edit. Hidden entirely until there is a group to configure. */}
      {groupStorefront && (
        <GroupStorefront
          enabled={groupStorefront.enabled}
          primaryName={groupStorefront.primaryName}
          branches={groupStorefront.branches}
          members={members}
        />
      )}

      {/* Every store in the group, including this one — its own settings decide
          what it contributes, so it needs to be visible and editable too. */}
      {members.map((member) => (
        <StoreCard
          key={member.siteId}
          member={member}
          contents={contents[member.siteId] ?? null}
          isCurrent={member.siteId === currentSiteId}
        />
      ))}

      <Card>
        <CardHeader
          title="Link another store"
          description="Only stores you already have access to are listed."
        />
        <CardBody>
          {available.length === 0 ? (
            <p className="text-sm text-muted">
              Every store you have access to is already linked.
            </p>
          ) : (
            <form action={formAction} className="flex flex-col gap-4">
              {state.error && <Callout tone="danger">{state.error}</Callout>}

              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Store to link">
                  <Select name="siteId" defaultValue="">
                    <option value="">Choose a store…</option>
                    {available.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name} ({s.code})
                      </option>
                    ))}
                  </Select>
                </Field>

                {!groupName && (
                  <Field label="Group name" hint="What this set of stores is called">
                    <Input name="groupName" placeholder="Store group" maxLength={120} />
                  </Field>
                )}
              </div>

              <div>
                <LinkButton />
              </div>
            </form>
          )}
        </CardBody>
      </Card>
    </div>
  )
}
