'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Button,
  Callout,
  Field,
  Input,
  Select,
  CurrencyInput,
  Icons,
  Modal,
  useToast,
  TABLE,
  TABLE_HEAD_ROW,
  TABLE_TH,
  TABLE_TD_INPUT,
  TABLE_ROW,
  TABLE_NUMERIC,
} from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import { journalTotals, refuseJournal } from '@/lib/glModel'
import { postJournalAction } from '../accounts/actions'

type Account = {
  id: number
  accountCode: string
  name: string
  accountTypeLabel: string
}

type FormLine = {
  key: string
  accountId: number
  description: string
  debit: number
  credit: number
}

/**
 * Capturing a manual journal.
 *
 * ── THE DIFFERENCE IS ALWAYS VISIBLE ─────────────────────────────────────
 *
 * Two columns, debit and credit, with the running difference shown as it is
 * typed and the Post button refusing while it is non-zero. That is the entire
 * discipline of double entry made visible: you cannot post something that does
 * not balance, and you can see how far off you are while fixing it.
 *
 * Entering an amount in one column clears the other, because a line is on one
 * side or the other and a row with both is meaningless.
 */
export function JournalClient({ accounts }: { accounts: Account[] }) {
  const router = useRouter()
  const toast = useToast()
  const [pending, startTransition] = useTransition()
  const [open, setOpen] = useState(false)

  const [journalDate, setJournalDate] = useState(todayIso())
  const [description, setDescription] = useState('')
  const [reference, setReference] = useState('')
  const [lines, setLines] = useState<FormLine[]>([
    blankLine(accounts[0]?.id ?? 0),
    blankLine(accounts[0]?.id ?? 0),
  ])

  const modelLines = lines
    .filter((l) => l.accountId && (l.debit !== 0 || l.credit !== 0))
    .map((l) => ({ accountId: l.accountId, amount: l.debit !== 0 ? l.debit : -l.credit }))

  const totals = journalTotals(modelLines)
  const refusal = refuseJournal({ journalDate, description, lines: modelLines })

  function updateLine(key: string, patch: Partial<FormLine>) {
    setLines((current) =>
      current.map((l) => {
        if (l.key !== key) return l
        const next = { ...l, ...patch }
        // One side or the other, never both.
        if (patch.debit !== undefined && patch.debit !== 0) next.credit = 0
        if (patch.credit !== undefined && patch.credit !== 0) next.debit = 0
        return next
      }),
    )
  }

  function reset() {
    setJournalDate(todayIso())
    setDescription('')
    setReference('')
    setLines([blankLine(accounts[0]?.id ?? 0), blankLine(accounts[0]?.id ?? 0)])
  }

  return (
    <>
      <Button
        onClick={() => {
          reset()
          setOpen(true)
        }}
      >
        <Icons.Plus size={15} />
        New journal
      </Button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Manual journal"
        /* Header fields above an UNBOUNDED lines table — a journal can run to
           twenty legs, and the 60vh cap hid the ones that make it balance. */
        bodyGrows
      >
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-4">
            <Field label="Date">
              <Input
                type="date"
                value={journalDate}
                onChange={(e) => setJournalDate(e.target.value)}
              />
            </Field>
            <div className="sm:col-span-2">
              <Field label="Description" hint="What this journal is for.">
                <Input
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="e.g. Depreciation for March"
                />
              </Field>
            </div>
            <Field label="Reference" hint="Optional.">
              <Input value={reference} onChange={(e) => setReference(e.target.value)} />
            </Field>
          </div>

          <div className="overflow-x-auto">
            <table className={TABLE}>
              <thead>
                <tr className={TABLE_HEAD_ROW}>
                  <th className={TABLE_TH}>Account</th>
                  <th className={TABLE_TH}>Description</th>
                  <th className={`${TABLE_TH} ${TABLE_NUMERIC} w-32`}>Debit</th>
                  <th className={`${TABLE_TH} ${TABLE_NUMERIC} w-32`}>Credit</th>
                  <th className={`${TABLE_TH} w-12`} />
                </tr>
              </thead>
              <tbody>
                {lines.map((line) => (
                  <tr key={line.key} className={TABLE_ROW}>
                    <td className={TABLE_TD_INPUT}>
                      <Select
                        value={String(line.accountId)}
                        onChange={(e) => updateLine(line.key, { accountId: Number(e.target.value) })}
                      >
                        {accounts.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.accountCode} · {a.name}
                          </option>
                        ))}
                      </Select>
                    </td>
                    <td className={TABLE_TD_INPUT}>
                      <Input
                        value={line.description}
                        onChange={(e) => updateLine(line.key, { description: e.target.value })}
                        placeholder="Optional"
                      />
                    </td>
                    <td className={`${TABLE_TD_INPUT} ${TABLE_NUMERIC}`}>
                      <CurrencyInput
                        value={line.debit}
                        onChange={(e) =>
                          updateLine(line.key, {
                            debit: Number(String(e.target.value).replace(',', '.')) || 0,
                          })
                        }
                      />
                    </td>
                    <td className={`${TABLE_TD_INPUT} ${TABLE_NUMERIC}`}>
                      <CurrencyInput
                        value={line.credit}
                        onChange={(e) =>
                          updateLine(line.key, {
                            credit: Number(String(e.target.value).replace(',', '.')) || 0,
                          })
                        }
                      />
                    </td>
                    <td className={`${TABLE_TD_INPUT} text-right`}>
                      {lines.length > 2 && (
                        <Button
                          variant="danger-ghost"
                          size="sm"
                          iconOnly
                          aria-label="Remove this line"
                          onClick={() => setLines((c) => c.filter((l) => l.key !== line.key))}
                        >
                          <Icons.Trash size={15} />
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setLines((c) => [...c, blankLine(accounts[0]?.id ?? 0)])}
            >
              <Icons.Plus size={15} />
              Add line
            </Button>

            {/* The discipline of double entry, made visible. */}
            <dl className="flex items-center gap-6 text-sm">
              <div className="flex gap-2">
                <dt className="text-muted">Debits</dt>
                <dd className="numeric text-ink">{formatMoney(totals.totalDebit)}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="text-muted">Credits</dt>
                <dd className="numeric text-ink">{formatMoney(totals.totalCredit)}</dd>
              </div>
            </dl>
          </div>

          {/* One strip for whatever blocks posting — the out-by figure when it
              is a balance problem. Nothing at all when the journal is ready. */}
          {refusal !== null && (
            <Callout
              tone="danger"
              title={
                totals.balanced
                  ? 'This journal cannot be posted yet'
                  : `Out by ${formatMoney(Math.abs(totals.difference))}`
              }
            >
              {refusal}
            </Callout>
          )}

          <div className="flex items-center justify-end">
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                disabled={pending || refusal !== null}
                onClick={() =>
                  startTransition(async () => {
                    const result = await postJournalAction({
                      journalDate,
                      description: description.trim(),
                      reference: reference.trim() || undefined,
                      lines: lines
                        .filter((l) => l.accountId && (l.debit !== 0 || l.credit !== 0))
                        .map((l) => ({
                          accountId: l.accountId,
                          amount: l.debit !== 0 ? l.debit : -l.credit,
                          description: l.description.trim() || null,
                        })),
                    })
                    if (result.ok) {
                      toast.success(result.message)
                      setOpen(false)
                      router.refresh()
                    } else {
                      toast.error(result.error)
                    }
                  })
                }
              >
                <Icons.Check size={15} />
                {pending ? 'Posting…' : 'Post journal'}
              </Button>
            </div>
          </div>
        </div>
      </Modal>
    </>
  )
}

function blankLine(accountId: number): FormLine {
  return {
    // A stable key so removing a middle line does not shuffle values between
    // rows — React reuses the DOM node when the key is an index.
    key: `line-${Math.random().toString(36).slice(2)}`,
    accountId,
    description: '',
    debit: 0,
    credit: 0,
  }
}

function todayIso(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
