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
  Switch,
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
  sharesLoyaltyWallet,
}: {
  legalEntity: 'unknown' | 'one' | 'several'
  /** Only meaningful under 'several' — see the switch below. */
  sharesLoyaltyWallet: boolean
}) {
  const [state, formAction] = useActionState<LinkFormState, FormData>(setLegalEntityAction, {
    error: null,
  })
  /*
   * ── WHAT THE RADIO SHOWS AFTER A SAVE ────────────────────────────────────
   *
   * Three things are true at once here, and the control has to satisfy all of
   * them:
   *
   *   · while choosing, it must follow the click
   *   · after saving, it must show what was saved
   *   · the parent is a CLIENT component, so revalidatePath does not hand it a
   *     fresh `legalEntity` prop — the page's server data updates, the props
   *     this tree already holds do not
   *
   * That third point is what made the first fix wrong. Syncing to the prop
   * looked right and was worse: on save the prop was still 'unknown', so the
   * guard dutifully cleared the choice and BOTH radios went blank — while the
   * answer sat correctly in the database, which is exactly what a refresh
   * showed.
   *
   * So the action reports what it wrote, and that wins. The prop is only the
   * starting point.
   */
  const answered = state.saved ?? (legalEntity === 'unknown' ? '' : legalEntity)
  const [typed, setTyped] = useState<string | null>(null)
  const [walletShared, setWalletShared] = useState(sharesLoyaltyWallet)
  const [lastAnswered, setLastAnswered] = useState(answered)
  if (lastAnswered !== answered) {
    // A save landed: drop the in-progress choice so the saved answer shows.
    setLastAnswered(answered)
    setTyped(null)
  }
  const choice = typed ?? answered
  const setChoice = setTyped

  return (
    <Card>
      <SectionTitle
        icon={<Icons.Building2 size={16} />}
        action={
          answered === '' ? (
            <Badge tone="warning">Not answered</Badge>
          ) : (
            <Badge tone={answered === 'one' ? 'success' : 'neutral'}>
              {answered === 'one' ? 'One company' : 'Separate companies'}
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

          {/*
            ── THE WALLET QUESTION, AND WHY IT ONLY APPEARS HERE ─────────────
            Shown only under "separate companies", because that is the only
            answer that gives it a reason to exist: one company sharing its own
            float across its own branches raises no question at all.

            It is a switch rather than a refusal because it is a commercial
            decision the owner is entitled to make — a franchise with a
            settlement agreement between its members has already made it. What
            the software owes them is the consequence stated here, at the moment
            of choosing, rather than discovered at a till later.

            Off by default: the answer that needs no agreement between the
            companies. See sql/tickets/017_share_loyalty.sql.
          */}
          {choice === 'several' && (
            <div className="border-t border-border pt-4">
              <Switch
                checked={walletShared}
                onChange={setWalletShared}
                label="Share loyalty wallet money between the companies"
                hint="Points, tiers and punch cards work across the group either way. This is only about wallet rand — money a shopper handed over. Switched on, R500 topped up at one company can be spent at another, and the two settle it between themselves. Switched off, each company holds its own float."
              />
              {walletShared && <input type="hidden" name="sharesLoyaltyWallet" value="on" />}
            </div>
          )}

          {answered === '' && (
            <Callout tone="warning">
              Until this is answered, the customer and supplier files cannot be
              shared.
            </Callout>
          )}
        </CardBody>

        <CardFooter>
          {/* Compared against `answered`, not the prop: after a save the prop is
              stale, and comparing to it would leave Save enabled against an
              answer already written. */}
          {/* Enabled when EITHER answer has moved. Comparing only the radio
              would leave Save greyed out after someone flipped the wallet
              switch, which reads as the screen having ignored them. */}
          <SaveButton
            disabled={
              choice === '' || (choice === answered && walletShared === sharesLoyaltyWallet)
            }
          />
        </CardFooter>
      </form>
    </Card>
  )
}
