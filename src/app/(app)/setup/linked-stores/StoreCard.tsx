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
  Icons,
  SectionTitle,
  Switch,
} from '@/components/ui'
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
    // Secondary on purpose: the screen's one primary is "Link store" at the
    // bottom, and four cards each shouting Save would drown it out.
    <Button type="submit" variant="secondary" disabled={pending}>
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
        icon={<Icons.Store size={16} />}
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
                <Icons.Trash size={14} />
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
            No database
          </Badge>
        )}
      </SectionTitle>

      <form action={formAction}>
        <input type="hidden" name="siteId" value={member.siteId} />

        <CardBody className="flex flex-col gap-4">
          {state.error && <Callout tone="danger">{state.error}</Callout>}

          {blocked && (
            <Callout tone="warning">
              {contents?.readable === false ? (
                <>This store&apos;s database could not be read, so sharing cannot be changed.</>
              ) : (
                <>
                  This store currently has <strong>{contents?.products} product(s)</strong> and{' '}
                  <strong>{contents?.departments} department(s)</strong>. Please delete all
                  products and departments to start using this feature.
                </>
              )}
            </Callout>
          )}

          <div className="flex flex-col gap-3">
            <SharingSwitch
              name="sharesProducts"
              label="Share products file"
              hint="Share product data between all your stores. Manage all stores’ products from one location."
              defaultChecked={member.sharesProducts}
              disabled={blocked}
            />
            <SharingSwitch
              name="sharesDepartments"
              label="Share departments"
              hint="Keep the department structure the same across all shared stores."
              defaultChecked={member.sharesDepartments}
              disabled={blocked}
            />
            <SharingSwitch
              name="sharesSelling"
              label="Share selling prices"
              hint="Automatically update selling prices to all shared stores."
              defaultChecked={member.sharesSelling}
              disabled={blocked}
            />
            <SharingSwitch
              name="sharesCost"
              label="Share cost prices"
              hint="Automatically update cost prices to all shared stores."
              defaultChecked={member.sharesCost}
              disabled={blocked}
            />
          </div>
        </CardBody>

        <CardFooter>
          <SaveButton />
        </CardFooter>
      </form>
    </Card>
  )
}

/**
 * A kit Switch inside a plain <form action>. The switch itself is a button and
 * submits nothing, so a hidden input mirrors checkbox semantics — present as
 * "on" when checked, absent when not — which is exactly what the server action
 * reads (`form.get(name) === 'on'`).
 */
function SharingSwitch({
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
  const [checked, setChecked] = useState(defaultChecked)
  return (
    <>
      {checked && <input type="hidden" name={name} value="on" />}
      <Switch
        checked={checked}
        onChange={setChecked}
        label={label}
        hint={hint}
        disabled={disabled}
      />
    </>
  )
}
