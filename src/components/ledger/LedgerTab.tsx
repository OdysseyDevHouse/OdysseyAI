'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Button,
  Card,
  ConfirmModal,
  CurrencyInput,
  Field,
  Icons,
  Input,
  Menu,
  MenuItem,
  MenuSeparator,
  Modal,
  Select,
  Switch,
  Textarea,
  useToast,
} from '@/components/ui'
import { TransactionTable, type LedgerRow } from '@/components/ledger/TransactionTable'
import { formatMoney } from '@/lib/decimals'

/**
 * The account's Transactions tab — the ledger, and the things you do to it.
 *
 * Shared by debtors and creditors. The mechanics of posting, allocating and
 * reversing are identical on both sides; only the wording differs, and only in
 * two places. The screen therefore takes its ACTIONS as props rather than
 * importing them: the two route folders own their own server actions (different
 * tables, different revalidate paths), and threading a table name through a
 * shared action is how an injection bug gets in.
 *
 * Nothing on this screen edits a posted row, because nothing anywhere does. A
 * mistake is corrected by reversing it, which is why the row menu offers
 * "Reverse" and not "Edit".
 */

export type LedgerActionResult = { ok: true; message: string } | { ok: false; error: string }

export type OpenItem = {
  id: number
  docLabel: string
  docNumber: string | null
  docDate: string
  outstanding: number
}

export type PostInput = {
  docType: string
  amount: number
  docDate: string
  docNumber?: string
  reference?: string
  description?: string
  vatRatePct?: number
  autoAllocate?: boolean
}

type Props = {
  lines: LedgerRow[]
  openDebits: OpenItem[]
  unappliedCredits: OpenItem[]
  /** 'Payment received' for a debtor; 'Payment made' for a creditor. */
  paymentLabel?: string
  /** Default for the auto-allocate switch, from the account type. */
  autoAllocatesByDefault?: boolean
  onPost: (input: PostInput) => Promise<LedgerActionResult>
  onAllocate: (debitId: number, creditId: number, amount: number) => Promise<LedgerActionResult>
  onAutoAllocate: (creditId: number) => Promise<LedgerActionResult>
  onReverse: (transactionId: number, reason: string) => Promise<LedgerActionResult>
}

export default function LedgerTab({
  lines,
  openDebits,
  unappliedCredits,
  paymentLabel = 'Payment received',
  autoAllocatesByDefault = false,
  onPost,
  onAllocate,
  onAutoAllocate,
  onReverse,
}: Props) {
  const [posting, setPosting] = useState(false)
  const [allocating, setAllocating] = useState(false)
  const [reversing, setReversing] = useState<LedgerRow | null>(null)
  const [openOnly, setOpenOnly] = useState(false)
  const [pending, startTransition] = useTransition()
  const toast = useToast()
  const router = useRouter()

  const shown = openOnly ? lines.filter((l) => l.amountOutstanding !== 0) : lines

  function run(work: () => Promise<LedgerActionResult>) {
    startTransition(async () => {
      const result = await work()
      if (result.ok) {
        toast.success(result.message)
        setPosting(false)
        setAllocating(false)
        setReversing(null)
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  return (
    <div className="flex flex-col gap-4 px-6 pt-4 pb-10">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Switch checked={openOnly} onChange={setOpenOnly} label="Open items only" />
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            onClick={() => setAllocating(true)}
            disabled={pending || unappliedCredits.length === 0}
            title={
              unappliedCredits.length === 0
                ? 'Nothing to allocate — there are no unapplied credits on this account.'
                : undefined
            }
          >
            <Icons.HandCoins size={15} />
            Allocate
          </Button>
          {/* Named for what people come here to do. "Post transaction" is
              accurate and useless: a payment is the overwhelming majority of
              what gets posted, and someone looking for a way to take one did
              not recognise it. The modal still offers every other type. */}
          <Button variant="primary" onClick={() => setPosting(true)} disabled={pending}>
            <Icons.Plus size={15} />
            {paymentLabel}
          </Button>
        </div>
      </div>

      <Card>
        <TransactionTable
          rows={shown}
          actions={(row) => (
            <Menu label="" variant="bare">
              <MenuItem
                onClick={() => {
                  if (row.amountOutstanding < 0) {
                    run(() => onAutoAllocate(row.id))
                  } else if (unappliedCredits.length === 0) {
                    // Opening the allocate modal here would show two empty
                    // dropdowns and no explanation. Say what is missing and
                    // what to do about it instead.
                    toast.info('No unapplied credits on this account — post a payment first.')
                    setPosting(true)
                  } else {
                    setAllocating(true)
                  }
                }}
              >
                <Icons.HandCoins size={15} />
                {row.amountOutstanding < 0 ? 'Auto-allocate' : 'Allocate against'}
              </MenuItem>
              <MenuSeparator />
              <MenuItem tone="danger" onClick={() => setReversing(row)}>
                <Icons.Reverse size={15} />
                Reverse
              </MenuItem>
            </Menu>
          )}
        />
      </Card>

      <PostModal
        open={posting}
        pending={pending}
        paymentLabel={paymentLabel}
        autoAllocatesByDefault={autoAllocatesByDefault}
        onClose={() => setPosting(false)}
        onPost={(input) => run(() => onPost(input))}
      />

      <AllocateModal
        open={allocating}
        pending={pending}
        debits={openDebits}
        credits={unappliedCredits}
        onClose={() => setAllocating(false)}
        onAllocate={(debitId, creditId, amount) => run(() => onAllocate(debitId, creditId, amount))}
      />

      <ReverseModal
        row={reversing}
        pending={pending}
        onClose={() => setReversing(null)}
        onReverse={(reason) => reversing && run(() => onReverse(reversing.id, reason))}
      />
    </div>
  )
}

/* ── Post ────────────────────────────────────────────────────────────────── */

function PostModal({
  open,
  pending,
  paymentLabel,
  autoAllocatesByDefault,
  onClose,
  onPost,
}: {
  open: boolean
  pending: boolean
  paymentLabel: string
  autoAllocatesByDefault: boolean
  onClose: () => void
  onPost: (input: PostInput) => void
}) {
  const [docType, setDocType] = useState('payment')
  const [amount, setAmount] = useState(0)
  const [docDate, setDocDate] = useState(todayIso())
  const [docNumber, setDocNumber] = useState('')
  const [reference, setReference] = useState('')
  const [description, setDescription] = useState('')
  const [vat, setVat] = useState(0)
  const [auto, setAuto] = useState(autoAllocatesByDefault)

  const isCredit = docType === 'payment' || docType === 'credit_note'
  const carriesVat = docType === 'invoice' || docType === 'credit_note'

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Post a transaction"
      /* A long form: the default 60vh cap made it read through a letterbox with
         empty desktop above and below. Still a MAX, so a short one stays short. */
      bodyGrows
      description="Posts to the ledger and moves the balance, in one step."
      /* Half-typed capture must survive a stray click on the backdrop. */
      closeOnBackdrop={false}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={pending || amount <= 0}
            onClick={() =>
              onPost({
                docType,
                amount,
                docDate,
                docNumber: docNumber || undefined,
                reference: reference || undefined,
                description: description || undefined,
                vatRatePct: carriesVat ? vat : 0,
                autoAllocate: isCredit && auto,
              })
            }
          >
            {pending ? 'Posting…' : 'Post'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Type">
            <Select value={docType} onChange={(e) => setDocType(e.target.value)}>
              <option value="payment">{paymentLabel}</option>
              <option value="invoice">Invoice</option>
              <option value="credit_note">Credit note</option>
              <option value="journal">Journal / adjustment</option>
              <option value="opening">Opening balance</option>
              <option value="interest">Interest</option>
            </Select>
          </Field>
          <Field
            label="Amount"
            hint={
              docType === 'journal'
                ? 'Negative reduces what is owed.'
                : isCredit
                  ? 'Positive — the type sets the direction.'
                  : 'VAT-inclusive.'
            }
          >
            <CurrencyInput
              value={amount}
              onChange={(e) => setAmount(Number(String(e.target.value).replace(',', '.')) || 0)}
            />
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Date">
            <Input type="date" value={docDate} onChange={(e) => setDocDate(e.target.value)} />
          </Field>
          <Field label="Document number">
            <Input
              value={docNumber}
              onChange={(e) => setDocNumber(e.target.value)}
              placeholder="INV001"
            />
          </Field>
          <Field label="Reference" hint="Their remittance or deposit reference.">
            <Input value={reference} onChange={(e) => setReference(e.target.value)} />
          </Field>
        </div>

        {carriesVat && (
          <Field label="VAT rate (%)" hint="Split out of the amount above, not added to it.">
            <CurrencyInput
              value={vat}
              onChange={(e) => setVat(Number(String(e.target.value).replace(',', '.')) || 0)}
              className="sm:max-w-[10rem]"
            />
          </Field>
        )}

        <Field label="Description">
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            maxLength={190}
          />
        </Field>

        {/*
          Defaulted from the account TYPE, not from a fixed value.

          A balance-brought-forward customer is defined by nobody allocating
          anything by hand — the payment goes to the oldest invoice and works
          forward. An open-item customer is defined by the opposite: the
          person taking the payment decides what it settles, and can split it
          across several invoices.

          Still a switch rather than a locked setting, because the exception is
          real: an open-item customer occasionally just says "put it against
          the oldest", and a balance-forward one occasionally disputes a
          specific invoice.
        */}
        {isCredit && (
          <Switch
            checked={auto}
            onChange={setAuto}
            label="Apply to the oldest open invoices"
            hint={
              autoAllocatesByDefault
                ? 'This is a balance-brought-forward account, so payments are applied automatically. Turn it off to choose invoices by hand.'
                : 'This is an open-item account. Leave this off to choose which invoices the payment settles.'
            }
          />
        )}
      </div>
    </Modal>
  )
}

/* ── Allocate ────────────────────────────────────────────────────────────── */

function AllocateModal({
  open,
  pending,
  debits,
  credits,
  onClose,
  onAllocate,
}: {
  open: boolean
  pending: boolean
  debits: OpenItem[]
  credits: OpenItem[]
  onClose: () => void
  onAllocate: (debitId: number, creditId: number, amount: number) => void
}) {
  const [creditId, setCreditId] = useState('')
  const [debitId, setDebitId] = useState('')
  const [amount, setAmount] = useState(0)

  const credit = credits.find((c) => String(c.id) === creditId)
  const debit = debits.find((d) => String(d.id) === debitId)
  // Never offer to allocate more than either side has left — the server refuses
  // it anyway, but a form that lets you type it is a form that wastes your time.
  const max = credit && debit ? Math.min(Math.abs(credit.outstanding), debit.outstanding) : 0

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Allocate a credit"
      description="Match a payment or credit note against a specific invoice."
      closeOnBackdrop={false}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={pending || !credit || !debit || amount <= 0 || amount > max}
            onClick={() => credit && debit && onAllocate(debit.id, credit.id, amount)}
          >
            {pending ? 'Allocating…' : 'Allocate'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field
          label="Credit to apply"
          hint={
            credits.length === 0
              ? 'Nothing here yet — a payment or credit note has to exist before it can be applied to an invoice.'
              : undefined
          }
        >
          <Select
            value={creditId}
            onChange={(e) => {
              setCreditId(e.target.value)
              setAmount(0)
            }}
            disabled={credits.length === 0}
          >
            <option value="">{credits.length === 0 ? '— No unapplied credits —' : '— Choose —'}</option>
            {credits.map((c) => (
              <option key={c.id} value={c.id}>
                {c.docLabel} {c.docNumber ?? `#${c.id}`} · {c.docDate} ·{' '}
                {formatMoney(Math.abs(c.outstanding))} unapplied
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Apply to">
          <Select
            value={debitId}
            onChange={(e) => {
              setDebitId(e.target.value)
              setAmount(0)
            }}
          >
            <option value="">— Choose —</option>
            {debits.map((d) => (
              <option key={d.id} value={d.id}>
                {d.docLabel} {d.docNumber ?? `#${d.id}`} · {d.docDate} ·{' '}
                {formatMoney(d.outstanding)} outstanding
              </option>
            ))}
          </Select>
        </Field>

        <Field
          label="Amount"
          hint={max > 0 ? `Up to ${formatMoney(max)}.` : 'Choose both sides first.'}
          error={amount > max && max > 0 ? `That is more than ${formatMoney(max)}.` : undefined}
        >
          <CurrencyInput
            value={amount}
            onChange={(e) => setAmount(Number(String(e.target.value).replace(',', '.')) || 0)}
          />
        </Field>

        {max > 0 && amount !== max && (
          <Button variant="ghost" size="sm" onClick={() => setAmount(max)}>
            Use the full {formatMoney(max)}
          </Button>
        )}
      </div>
    </Modal>
  )
}

/* ── Reverse ─────────────────────────────────────────────────────────────── */

function ReverseModal({
  row,
  pending,
  onClose,
  onReverse,
}: {
  row: LedgerRow | null
  pending: boolean
  onClose: () => void
  onReverse: (reason: string) => void
}) {
  const [reason, setReason] = useState('')

  return (
    <ConfirmModal
      open={row !== null}
      onClose={() => {
        setReason('')
        onClose()
      }}
      onConfirm={() => onReverse(reason)}
      title="Reverse this transaction?"
      confirmLabel="Post the reversal"
      busy={pending}
      message={
        <div className="flex flex-col gap-3">
          <p>
            {row?.docLabel} {row?.docNumber ?? ''} for{' '}
            {row ? formatMoney(Math.abs(row.amountSigned)) : ''} will be reversed by an opposite
            entry. The original stays exactly as it was issued — a customer may be holding a printed
            copy of it.
          </p>
          <Field label="Reason" hint="Recorded on the reversal and in the audit trail.">
            <Input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Captured twice"
            />
          </Field>
        </div>
      }
    />
  )
}

/** Local-time yyyy-mm-dd. toISOString() would shift the date across UTC midnight. */
function todayIso(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}
