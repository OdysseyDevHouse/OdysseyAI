'use client'

import { useState, useTransition } from 'react'
import {
  Card,
  CardHeader,
  CardBody,
  CardFooter,
  Button,
  Badge,
  Callout,
  DataTable,
  Modal,
  SelectableCard,
  Icons,
  useToast,
  type Column,
} from '@/components/ui'
import { startTopupAction } from './topupActions'

/**
 * The AI credits wallet, on the billing screen.
 *
 * ── WHY IT SITS HERE AND NOT IN THE MAIN NAVIGATION ─────────────────────────
 *
 * It is money, and this is the money screen: the person who tops up a wallet is
 * the person who pays the bill, and they are already here. A balance in the app
 * header would put a spend counter in front of every cashier all day, most of
 * whom cannot top up and none of whom can act on it.
 *
 * The moment it matters to somebody else — the buyer whose scan was just
 * refused — they are told at the point of use, by the feature itself, and sent
 * here.
 *
 * ── WHY THE BALANCE IS A SENTENCE AND NOT A GAUGE ───────────────────────────
 *
 * A progress bar needs a maximum, and a wallet has none: R500 is a fortnight
 * for one shop and a morning for another. What a person actually wants to know
 * is "will this last", which only usage answers — so the history is the second
 * half of this card rather than a separate screen.
 */

type Entry = {
  id: number
  amountMicros: number
  entryType: 'topup' | 'usage' | 'manual' | 'adjustment'
  feature: string | null
  siteName: string | null
  when: string
  /** Already formatted server-side, in the account's own currency. */
  amount: string
  description: string
}

type Props = {
  /** Formatted for display — the server owns the currency conversion. */
  balance: string
  /** Whether the balance is at or below nothing, for the tone of the callout. */
  empty: boolean
  presets: { amount: number; label: string }[]
  entries: Entry[]
  payfastReady: boolean
  payfastProblems: string[]
  /** False when this store has no billing account — nothing to spend from. */
  hasAccount: boolean
}

export default function AiCreditsCard({
  balance,
  empty,
  presets,
  entries,
  payfastReady,
  payfastProblems,
  hasAccount,
}: Props) {
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [chosen, setChosen] = useState<number | null>(presets[0]?.amount ?? null)
  const [busy, start] = useTransition()

  /**
   * Hand off to PayFast by POSTing the signed form.
   *
   * Same shape as the subscription's Subscribe button, and for the same reason:
   * the browser posts straight to PayFast so card details never touch this
   * application, and the fields are already signed by the server — the
   * passphrase never leaves it.
   */
  function topUp() {
    if (chosen === null) return
    start(async () => {
      const result = await startTopupAction(chosen)
      if ('ok' in result && result.ok === false) {
        toast.error(result.error)
        return
      }

      const form = document.createElement('form')
      form.method = 'POST'
      form.action = result.form.action
      // In iteration order, matching exactly what was signed.
      for (const [name, value] of Object.entries(result.form.fields)) {
        const input = document.createElement('input')
        input.type = 'hidden'
        input.name = name
        input.value = value
        form.appendChild(input)
      }
      document.body.appendChild(form)
      form.submit()
    })
  }

  const columns: Column<Entry>[] = [
    { key: 'when', header: 'When', cell: (r) => r.when, sortValue: (r) => r.when },
    {
      key: 'description',
      header: 'What',
      cell: (r) => (
        <div className="flex flex-col">
          <span>{r.description}</span>
          {r.siteName ? <span className="text-xs text-muted">{r.siteName}</span> : null}
        </div>
      ),
      sortValue: (r) => r.description,
    },
    {
      key: 'amount',
      header: 'Amount',
      numeric: true,
      cell: (r) => (
        <span className={r.amountMicros >= 0 ? 'text-success-ink' : undefined}>{r.amount}</span>
      ),
      sortValue: (r) => r.amountMicros,
    },
  ]

  return (
    <Card>
      <CardHeader
        icon={<Icons.Sparkles />}
        title="AI credits"
        description="What AI features draw on. Bought up front, spent per use."
        action={
          hasAccount && payfastReady ? <Button onClick={() => setOpen(true)}>Top up</Button> : null
        }
      />

      <CardBody>
        <div className="flex items-baseline gap-3">
          <span className="numeric text-3xl font-semibold text-ink">{balance}</span>
          {empty ? <Badge tone="warning">Empty</Badge> : null}
        </div>

        {!hasAccount ? (
          <Callout tone="warning" title="No billing account">
            AI credits are bought against a billing account, and this store is not attached to one
            yet. Contact Odyssey to set one up.
          </Callout>
        ) : empty ? (
          <Callout tone="warning" title="AI features are paused">
            Scanning a supplier document and building a report from a question both need credit.
            They will start working again as soon as the wallet has some.
          </Callout>
        ) : null}

        {hasAccount && !payfastReady ? (
          <Callout tone="warning" title="Card payments are not set up">
            {payfastProblems.join('; ')}
          </Callout>
        ) : null}

        {entries.length > 0 ? (
          <div className="mt-2">
            <DataTable
              columns={columns}
              rows={entries}
              getRowKey={(r) => r.id}
              empty={{ title: 'Nothing yet', hint: 'AI activity will appear here.' }}
            />
          </div>
        ) : null}
      </CardBody>

      {hasAccount ? (
        <CardFooter>
          <p className="text-sm text-muted">
            Credit is shared by every store on the account, and does not expire.
          </p>
        </CardFooter>
      ) : null}

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Top up AI credits"
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={topUp} disabled={busy || chosen === null}>
              {busy ? 'Opening PayFast…' : 'Continue to PayFast'}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted">
            Choose an amount. You will be taken to PayFast to pay by card, and the credit lands as
            soon as the payment clears.
          </p>

          {presets.map((p) => (
            <SelectableCard
              key={p.amount}
              name="topup-amount"
              value={String(p.amount)}
              title={p.label}
              checked={chosen === p.amount}
              onChange={(v) => setChosen(Number(v))}
            />
          ))}
        </div>
      </Modal>
    </Card>
  )
}
