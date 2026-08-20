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
  Radio,
  SectionTitle,
} from '@/components/ui'
import { setLegalEntityAction, type LinkFormState } from './actions'

/**
 * One company, or several?
 *
 * ── WHY A SETUP SCREEN ASKS A LEGAL QUESTION ─────────────────────────────
 *
 * Sharing one customer file means one balance: bought at branch 3, paid at
 * branch 7, settled in one debtors book. Whether that is right depends on a
 * fact about the business the software has no other way to know.
 *
 * Ten branches of ONE company already have one debtors book — the customer owes
 * the company, not a building — so sharing reflects reality. Ten SEPARATE
 * companies each have their own books and their own VAT return, and a payment
 * taken at one settling an invoice raised by another is one company collecting
 * money it does not own.
 *
 * The second case does not merely look untidy. It misstates two sets of
 * statutory records, and it does so silently, which is exactly the kind of
 * wrong nobody finds until an audit. So the answer is asked once, plainly, and
 * it gates the switches rather than merely annotating them.
 *
 * The copy deliberately talks about registration and VAT numbers rather than
 * "legal entities": the person setting this up knows whether they file one
 * return or ten, and would have to guess at the abstraction.
 */

function SaveButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" variant="secondary" disabled={disabled || pending}>
      {pending ? 'Saving…' : 'Save answer'}
    </Button>
  )
}

export default function LegalEntityCard({
  legalEntity,
}: {
  legalEntity: 'unknown' | 'one' | 'several'
}) {
  const [state, formAction] = useActionState<LinkFormState, FormData>(setLegalEntityAction, {
    error: null,
  })
  const [choice, setChoice] = useState(legalEntity === 'unknown' ? '' : legalEntity)

  return (
    <Card>
      <SectionTitle
        icon={<Icons.Building2 size={16} />}
        action={
          legalEntity === 'unknown' ? (
            <Badge tone="warning">Not answered</Badge>
          ) : (
            <Badge tone={legalEntity === 'one' ? 'success' : 'neutral'}>
              {legalEntity === 'one' ? 'One company' : 'Separate companies'}
            </Badge>
          )
        }
      >
        How are these stores registered?
      </SectionTitle>

      <form action={formAction}>
        <CardBody className="flex flex-col gap-4">
          {state.error && <Callout tone="danger">{state.error}</Callout>}

          <p className="text-sm text-muted">
            This decides whether the stores may share one customer or supplier
            file. It does not change the accounts: each store keeps its own books
            and its own VAT return either way, and group reports read them
            without merging them.
          </p>

          {/* Radio's `label` is a ReactNode, so the explanation goes inside it
              and stays tied to its control. A `hint` prop on the kit's Radio
              would be the alternative, but one screen is not enough reason to
              grow the component. */}
          <div className="flex flex-col gap-3">
            <Radio
              name="legalEntity"
              value="one"
              checked={choice === 'one'}
              onChange={() => setChoice('one')}
              className="items-start"
              label={
                <span className="flex flex-col">
                  <span className="font-medium">One company with several branches</span>
                  <span className="text-xs text-muted">
                    One registration and one VAT number. The stores already share one
                    set of books, so one customer balance is the true one.
                  </span>
                </span>
              }
            />
            <Radio
              name="legalEntity"
              value="several"
              checked={choice === 'several'}
              onChange={() => setChoice('several')}
              className="items-start"
              label={
                <span className="flex flex-col">
                  <span className="font-medium">Separate companies</span>
                  <span className="text-xs text-muted">
                    A franchise, or companies under a holding company. Each files its
                    own return, so each needs its own customer balances — their contact
                    details can still be kept in step.
                  </span>
                </span>
              }
            />
          </div>

          {legalEntity === 'unknown' && (
            <Callout tone="warning">
              Until this is answered, the customer and supplier files cannot be
              shared.
            </Callout>
          )}
        </CardBody>

        <CardFooter>
          <SaveButton disabled={choice === '' || choice === legalEntity} />
        </CardFooter>
      </form>
    </Card>
  )
}
