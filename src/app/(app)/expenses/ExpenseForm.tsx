'use client'

import { useState, useTransition, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import {
  Button,
  Card,
  CardHeader,
  CardBody,
  CardFooter,
  Field,
  Input,
  Select,
  CurrencyInput,
  Textarea,
  Badge,
  Icons,
  useToast,
  TABLE,
  TABLE_HEAD_ROW,
  TABLE_TH,
  TABLE_TD,
  TABLE_ROW,
  TABLE_NUMERIC,
} from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import {
  computeTotals,
  refuseExpense,
  PAYMENT_TYPE_HINTS,
  type ExpenseLineInput,
  type ExpensePaymentType,
} from '@/lib/expenseModel'
import {
  saveExpenseAction,
  saveAndFinaliseAction,
  checkDuplicateAction,
} from './actions'

/**
 * Capturing an expense.
 *
 * ── THE ONE DECISION THAT MATTERS ────────────────────────────────────────
 *
 * "Paid now" or "bill to pay later" sits at the top and changes what the rest
 * of the form asks for, because it changes where the money goes: a bill hits
 * the supplier's account and joins the payables age analysis; a direct payment
 * comes straight out of a bank account. Burying that choice among the fields is
 * how expenses end up on the wrong side.
 *
 * Everything else is arranged for speed: somebody is holding a slip and typing
 * what it says. Amounts are entered VAT-INCLUSIVE because that is the number
 * printed on the slip, and the split is shown as it is typed.
 */

type Category = {
  id: number
  accountCode: string
  name: string
  categoryType: string
  vatClaimable: boolean
  defaultVatRatePct: number | null
}

type Option = { id: number; name: string; code?: string }

type FormLine = {
  key: string
  categoryId: number
  description: string
  departmentId: number | null
  amountIncl: number
  vatRatePct: number
}

export type ExpenseFormValues = {
  id?: number
  expenseDate: string
  paymentType: ExpensePaymentType
  supplierId: number | null
  supplierName: string
  supplierInvoiceNo: string
  bankAccountId: number | null
  reference: string
  description: string
  notes: string
  lines: FormLine[]
}

export function ExpenseForm({
  categories,
  suppliers,
  bankAccounts,
  departments,
  defaultVatRate,
  existing,
}: {
  categories: Category[]
  suppliers: Option[]
  bankAccounts: Option[]
  departments: Option[]
  defaultVatRate: number
  existing?: ExpenseFormValues
}) {
  const router = useRouter()
  const toast = useToast()
  const [pending, startTransition] = useTransition()

  const [expenseDate, setExpenseDate] = useState(existing?.expenseDate ?? todayIso())
  const [paymentType, setPaymentType] = useState<ExpensePaymentType>(
    existing?.paymentType ?? 'direct',
  )
  const [supplierId, setSupplierId] = useState<number | null>(existing?.supplierId ?? null)
  const [supplierName, setSupplierName] = useState(existing?.supplierName ?? '')
  const [supplierInvoiceNo, setSupplierInvoiceNo] = useState(existing?.supplierInvoiceNo ?? '')
  const [bankAccountId, setBankAccountId] = useState<number | null>(
    existing?.bankAccountId ?? bankAccounts[0]?.id ?? null,
  )
  const [reference, setReference] = useState(existing?.reference ?? '')
  const [description, setDescription] = useState(existing?.description ?? '')
  const [notes, setNotes] = useState(existing?.notes ?? '')
  const [lines, setLines] = useState<FormLine[]>(
    existing?.lines ?? [blankLine(categories[0]?.id ?? 0, defaultVatRate)],
  )
  const [duplicate, setDuplicate] = useState<{
    documentNumber: string | null
    expenseDate: string
    totalIncl: number
  } | null>(null)

  const isBill = paymentType === 'on_account'

  const modelLines: ExpenseLineInput[] = lines.map((l) => {
    const category = categories.find((c) => c.id === l.categoryId)
    return {
      categoryId: l.categoryId,
      amountIncl: l.amountIncl,
      vatRatePct: l.vatRatePct,
      vatClaimable: category?.vatClaimable !== false,
    }
  })
  const totals = computeTotals(modelLines)

  const refusal = refuseExpense({
    expenseDate,
    paymentType,
    supplierId,
    supplierName,
    bankAccountId,
    lines: modelLines,
  })

  // Warn about a repeated supplier invoice number while the user is still
  // typing rather than after they post. Booking the same bill twice silently
  // overstates costs and is the commonest expense error there is.
  useEffect(() => {
    if (!supplierId || !supplierInvoiceNo.trim()) {
      setDuplicate(null)
      return
    }
    let cancelled = false
    const timer = setTimeout(async () => {
      const found = await checkDuplicateAction(
        supplierId,
        supplierInvoiceNo.trim(),
        existing?.id ?? 0,
      )
      if (!cancelled) setDuplicate(found)
    }, 400)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [supplierId, supplierInvoiceNo, existing?.id])

  function payload() {
    return {
      expenseDate,
      paymentType,
      supplierId,
      supplierName: supplierName.trim() || null,
      supplierInvoiceNo: supplierInvoiceNo.trim() || null,
      bankAccountId: isBill ? null : bankAccountId,
      reference: reference.trim() || null,
      description: description.trim() || null,
      notes: notes.trim() || null,
      lines: lines.map((l) => ({
        categoryId: l.categoryId,
        description: l.description.trim() || null,
        departmentId: l.departmentId,
        amountIncl: l.amountIncl,
        vatRatePct: l.vatRatePct,
      })),
    }
  }

  function save(andPost: boolean) {
    startTransition(async () => {
      const result = andPost
        ? await saveAndFinaliseAction(payload(), existing?.id)
        : await saveExpenseAction(payload(), existing?.id)

      if (result.ok) {
        toast.success(result.message)
        router.push('/expenses')
      } else {
        toast.error(result.error)
      }
    })
  }

  function updateLine(key: string, patch: Partial<FormLine>) {
    setLines((current) =>
      current.map((l) => {
        if (l.key !== key) return l
        const next = { ...l, ...patch }
        // Choosing a category adopts its default VAT rate — the common case is
        // that the category knows better than the person typing.
        if (patch.categoryId !== undefined) {
          const category = categories.find((c) => c.id === patch.categoryId)
          if (category?.defaultVatRatePct !== null && category?.defaultVatRatePct !== undefined) {
            next.vatRatePct = category.defaultVatRatePct
          }
        }
        return next
      }),
    )
  }

  return (
    <>
      <Card>
        <CardHeader
          title="What kind of expense is this?"
          description={PAYMENT_TYPE_HINTS[paymentType]}
        />
        <CardBody>
          <div className="flex gap-2">
            <Button
              variant={paymentType === 'direct' ? 'primary' : 'secondary'}
              onClick={() => setPaymentType('direct')}
            >
              <Icons.Wallet size={15} />
              Paid now
            </Button>
            <Button
              variant={isBill ? 'primary' : 'secondary'}
              onClick={() => setPaymentType('on_account')}
            >
              <Icons.Clock size={15} />
              Bill to pay later
            </Button>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Who and when" />
        <CardBody>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Date">
              <Input
                type="date"
                value={expenseDate}
                onChange={(e) => setExpenseDate(e.target.value)}
              />
            </Field>

            {isBill ? (
              <Field label="Supplier" hint="The account this is owed to.">
                <Select
                  value={String(supplierId ?? '')}
                  onChange={(e) => {
                    const id = Number(e.target.value) || null
                    setSupplierId(id)
                    setSupplierName(suppliers.find((s) => s.id === id)?.name ?? '')
                  }}
                >
                  <option value="">— Choose a supplier —</option>
                  {suppliers.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : (
              <Field label="Paid to" hint="A supplier, or just type who it was.">
                <Input
                  value={supplierName}
                  onChange={(e) => {
                    setSupplierName(e.target.value)
                    setSupplierId(null)
                  }}
                  list="expense-payees"
                  placeholder="e.g. Shell Garage"
                />
                <datalist id="expense-payees">
                  {suppliers.map((s) => (
                    <option key={s.id} value={s.name} />
                  ))}
                </datalist>
              </Field>
            )}

            {isBill ? (
              <Field label="Their invoice number" hint="What to quote when paying.">
                <Input
                  value={supplierInvoiceNo}
                  onChange={(e) => setSupplierInvoiceNo(e.target.value)}
                />
              </Field>
            ) : (
              <Field label="Paid from" hint="Where the money came out of.">
                <Select
                  value={String(bankAccountId ?? '')}
                  onChange={(e) => setBankAccountId(Number(e.target.value) || null)}
                >
                  <option value="">— Choose an account —</option>
                  {bankAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
          </div>

          {duplicate && (
            <p className="mt-4 rounded-control bg-warning-soft px-3 py-2 text-sm text-warning-ink">
              That invoice number is already captured on this supplier —{' '}
              {duplicate.documentNumber ?? 'a draft'} dated {duplicate.expenseDate} for{' '}
              {formatMoney(duplicate.totalIncl)}. Check this is not the same bill twice.
            </p>
          )}

          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <Field label="Description" hint="What it was for.">
              <Input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="e.g. Shop rent for March"
              />
            </Field>
            <Field label="Reference" hint="Optional.">
              <Input value={reference} onChange={(e) => setReference(e.target.value)} />
            </Field>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="What it was spent on"
          description="Split across categories where one slip covers several things."
          action={
            <Button
              variant="secondary"
              size="sm"
              onClick={() =>
                setLines((c) => [...c, blankLine(categories[0]?.id ?? 0, defaultVatRate)])
              }
            >
              <Icons.Plus size={15} />
              Add line
            </Button>
          }
        />

        <div className="overflow-x-auto">
          <table className={TABLE}>
            <thead>
              <tr className={TABLE_HEAD_ROW}>
                <th className={TABLE_TH}>Category</th>
                <th className={TABLE_TH}>Description</th>
                {departments.length > 0 && <th className={TABLE_TH}>Department</th>}
                <th className={`${TABLE_TH} w-24`}>VAT %</th>
                <th className={`${TABLE_TH} ${TABLE_NUMERIC} w-36`}>Amount (incl)</th>
                <th className={`${TABLE_TH} w-12`} />
              </tr>
            </thead>
            <tbody>
              {lines.map((line, index) => {
                const category = categories.find((c) => c.id === line.categoryId)
                const computed = totals.lines[index]
                return (
                  <tr key={line.key} className={TABLE_ROW}>
                    <td className={TABLE_TD}>
                      <Select
                        value={String(line.categoryId)}
                        onChange={(e) =>
                          updateLine(line.key, { categoryId: Number(e.target.value) })
                        }
                      >
                        {categories.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.accountCode} · {c.name}
                          </option>
                        ))}
                      </Select>
                      {category?.vatClaimable === false && (
                        <span className="mt-1 block text-xs text-warning-ink">
                          VAT cannot be claimed on this category
                        </span>
                      )}
                      {category?.categoryType === 'capital' && (
                        <span className="mt-1 block text-xs text-muted">
                          An asset — kept out of the profit and loss
                        </span>
                      )}
                    </td>
                    <td className={TABLE_TD}>
                      <Input
                        value={line.description}
                        onChange={(e) => updateLine(line.key, { description: e.target.value })}
                        placeholder="Optional"
                      />
                    </td>
                    {departments.length > 0 && (
                      <td className={TABLE_TD}>
                        <Select
                          value={String(line.departmentId ?? '')}
                          onChange={(e) =>
                            updateLine(line.key, {
                              departmentId: Number(e.target.value) || null,
                            })
                          }
                        >
                          <option value="">—</option>
                          {departments.map((d) => (
                            <option key={d.id} value={d.id}>
                              {d.name}
                            </option>
                          ))}
                        </Select>
                      </td>
                    )}
                    <td className={TABLE_TD}>
                      <Input
                        type="number"
                        step="0.01"
                        value={line.vatRatePct}
                        onChange={(e) =>
                          updateLine(line.key, { vatRatePct: Number(e.target.value) || 0 })
                        }
                      />
                    </td>
                    <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                      <CurrencyInput
                        value={line.amountIncl}
                        onChange={(e) =>
                          updateLine(line.key, {
                            amountIncl: Number(String(e.target.value).replace(',', '.')) || 0,
                          })
                        }
                      />
                      {/* The split, as it is typed. The slip says the inclusive
                          figure; the books need the other two. */}
                      {computed && computed.vat > 0 && (
                        <span className="mt-1 block text-xs text-muted">
                          {formatMoney(computed.excl)} + {formatMoney(computed.vat)} VAT
                        </span>
                      )}
                    </td>
                    <td className={`${TABLE_TD} text-right`}>
                      {lines.length > 1 && (
                        <Button
                          variant="danger-ghost"
                          size="sm"
                          iconOnly
                          aria-label="Remove this line"
                          onClick={() =>
                            setLines((c) => c.filter((l) => l.key !== line.key))
                          }
                        >
                          <Icons.Trash size={15} />
                        </Button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        <CardBody>
          <div className="flex justify-end">
            <dl className="w-64 space-y-1 text-sm">
              <div className="flex justify-between">
                <dt className="text-muted">Excluding VAT</dt>
                <dd className="numeric text-ink-2">{formatMoney(totals.subtotalExcl)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted">VAT</dt>
                <dd className="numeric text-ink-2">{formatMoney(totals.vatTotal)}</dd>
              </div>
              {totals.vatClaimable !== totals.vatTotal && (
                <div className="flex justify-between">
                  <dt className="text-muted">…of which claimable</dt>
                  <dd className="numeric text-warning-ink">{formatMoney(totals.vatClaimable)}</dd>
                </div>
              )}
              <div className="flex justify-between border-t border-border pt-1">
                <dt className="font-medium text-ink">Total</dt>
                <dd className="numeric text-lg font-semibold text-ink">
                  {formatMoney(totals.totalIncl)}
                </dd>
              </div>
            </dl>
          </div>

          <Field label="Notes" hint="Optional — anything worth remembering about this expense.">
            <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
        </CardBody>

        <CardFooter>
          <div className="flex w-full items-center justify-between">
            <span className="text-sm text-muted">
              {refusal ?? (isBill
                ? 'Posting adds this to the supplier account.'
                : 'Posting takes the money out of the account.')}
            </span>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => router.back()}>
                Cancel
              </Button>
              <Button
                variant="secondary"
                disabled={pending || refusal !== null}
                onClick={() => save(false)}
              >
                Save as draft
              </Button>
              <Button disabled={pending || refusal !== null} onClick={() => save(true)}>
                <Icons.Check size={15} />
                {pending ? 'Posting…' : 'Save and post'}
              </Button>
            </div>
          </div>
        </CardFooter>
      </Card>
    </>
  )
}

function blankLine(categoryId: number, vatRatePct: number): FormLine {
  return {
    // A stable key that survives reordering. Index keys break the inputs when a
    // middle line is removed — React reuses the DOM node and the wrong value
    // appears in the wrong row.
    key: `line-${Math.random().toString(36).slice(2)}`,
    categoryId,
    description: '',
    departmentId: null,
    amountIncl: 0,
    vatRatePct,
  }
}

function todayIso(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
