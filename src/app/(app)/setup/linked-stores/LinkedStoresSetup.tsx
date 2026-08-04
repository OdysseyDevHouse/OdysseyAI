'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Field,
  Input,
  Select,
} from '@/components/ui'
import { StatusError, Plus, Store } from '@/components/ui/icons'
import type { GroupMember, StoreContents } from '@/lib/storeGroups'
import StoreCard from './StoreCard'
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
    <Button type="submit" variant="primary" disabled={pending}>
      <Plus size={15} />
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
}: {
  currentSiteId: number
  currentSiteName: string
  groupName: string | null
  members: GroupMember[]
  /** What each store already holds, for the empty-store gate. */
  contents: Record<number, StoreContents | null>
  available: { id: number; code: string; name: string }[]
}) {
  const [state, formAction] = useActionState<LinkFormState, FormData>(linkStoreAction, {
    error: null,
  })

  const others = members.filter((m) => m.siteId !== currentSiteId)

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader
          title={groupName ?? 'Not linked yet'}
          description={
            others.length
              ? `${currentSiteName} shares products with ${others.length} other store${others.length === 1 ? '' : 's'}.`
              : `${currentSiteName} is standalone. Link another store to share products with it.`
          }
        />

        {others.length === 0 && (
          <CardBody>
            <EmptyState
              icon={<Store size={22} />}
              title="No linked stores"
              hint="Link another Odyssey store and products edited here can be written to it as well."
            />
          </CardBody>
        )}
      </Card>

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
              {state.error && (
                <p
                  role="alert"
                  className="flex items-center gap-2 rounded-control bg-danger-soft px-3 py-2 text-sm text-danger-ink"
                >
                  <StatusError size={15} />
                  {state.error}
                </p>
              )}

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
