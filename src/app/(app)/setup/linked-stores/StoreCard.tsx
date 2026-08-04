'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import { Badge, Button, Card, Checkbox, SectionTitle } from '@/components/ui'
import { Store, StatusError, StatusWarning, Trash } from '@/components/ui/icons'
import type { GroupMember, StoreContents } from '@/lib/storeGroups'
import { updateSharingAction, unlinkStoreAction, type LinkFormState } from './actions'

/**
 * One linked store's sharing settings.
 *
 * "Share products file" is the master switch: with it off the store belongs to
 * the group but exchanges nothing, and the price toggles below have no effect.
 * That is the case for a customer whose fourth branch is run independently.
 *
 * It can only be switched ON while the store is EMPTY. Two stores that each
 * already hold products cannot be merged by a flag — the same code may exist in
 * both with different descriptions and prices, and nothing here could decide
 * which is right. The store is asked, and the toggles are disabled with the
 * counts shown if it is not.
 */

function SaveButton() {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" variant="ghost" size="sm" disabled={pending}>
      {pending ? 'Saving…' : 'Save'}
    </Button>
  )
}

export default function StoreCard({
  member,
  contents,
  isCurrent,
}: {
  member: GroupMember
  /** Null when the store has no database to read. */
  contents: StoreContents | null
  isCurrent: boolean
}) {
  const [state, formAction] = useActionState<LinkFormState, FormData>(updateSharingAction, {
    error: null,
  })

  // Only a store that is not yet sharing has to be empty; one already sharing
  // legitimately fills up and must not become un-saveable.
  const occupied =
    !member.sharesProducts &&
    contents !== null &&
    (contents.products > 0 || contents.departments > 0)

  const blocked = occupied || contents?.readable === false

  return (
    <Card>
      <SectionTitle
        icon={<Store size={16} />}
        action={
          !isCurrent && (
            <form action={unlinkStoreAction}>
              <input type="hidden" name="siteId" value={member.siteId} />
              <Button
                type="submit"
                variant="danger-ghost"
                size="sm"
                title="Unlink — neither store's data is changed"
              >
                <Trash size={14} />
                De-link store
              </Button>
            </form>
          )
        }
      >
        {member.siteCode} — {member.displayName}
        {isCurrent && (
          <Badge tone="brand" className="ml-2">
            This store
          </Badge>
        )}
        {!member.hasDatabase && (
          <Badge tone="danger" className="ml-2">
            no database
          </Badge>
        )}
      </SectionTitle>

      <form action={formAction} className="flex flex-col gap-4 p-6">
        <input type="hidden" name="siteId" value={member.siteId} />

        {state.error && (
          <p
            role="alert"
            className="flex items-start gap-2 rounded-control bg-danger-soft px-3 py-2 text-sm text-danger-ink"
          >
            <StatusError size={15} className="mt-0.5 shrink-0" />
            {state.error}
          </p>
        )}

        {blocked && (
          <p className="flex items-start gap-2 rounded-control bg-warning-soft px-3 py-2 text-sm text-warning-ink">
            <StatusWarning size={15} className="mt-0.5 shrink-0" />
            {contents?.readable === false ? (
              <span>This store&apos;s database could not be read, so sharing cannot be changed.</span>
            ) : (
              <span>
                This store currently has <strong>{contents?.products} product(s)</strong> and{' '}
                <strong>{contents?.departments} department(s)</strong>. Please delete all products
                and departments to start using this feature.
              </span>
            )}
          </p>
        )}

        <div className="flex flex-col gap-3">
          <Toggle
            name="sharesProducts"
            label="Share products file"
            hint="Share product data between all your stores. Manage all stores’ products from one location."
            defaultChecked={member.sharesProducts}
            disabled={blocked}
          />
          <Toggle
            name="sharesDepartments"
            label="Share departments"
            hint="Keep the department structure the same across all shared stores."
            defaultChecked={member.sharesDepartments}
            disabled={blocked}
          />
          <Toggle
            name="sharesSelling"
            label="Share selling prices"
            hint="Automatically update selling prices to all shared stores."
            defaultChecked={member.sharesSelling}
            disabled={blocked}
          />
          <Toggle
            name="sharesCost"
            label="Share cost prices"
            hint="Automatically update cost prices to all shared stores."
            defaultChecked={member.sharesCost}
            disabled={blocked}
          />
        </div>

        <div>
          <SaveButton />
        </div>
      </form>
    </Card>
  )
}

function Toggle({
  name,
  label,
  hint,
  defaultChecked,
  disabled,
}: {
  name: string
  label: string
  hint: string
  defaultChecked: boolean
  disabled?: boolean
}) {
  return (
    <div className={disabled ? 'opacity-50' : ''}>
      <Checkbox name={name} label={label} defaultChecked={defaultChecked} disabled={disabled} />
      <p className="ml-6 text-xs text-muted">{hint}</p>
    </div>
  )
}
