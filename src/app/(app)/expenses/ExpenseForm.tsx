'use client'

import { useState, useTransition, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import {
  Button,
  Card,
  CardHeader,
  CardBody,
  CardFooter,
  Callout,
  Combobox,
  Field,
  Input,
  NumberInput,
  Select,
  CurrencyInput,
  Textarea,
  Icons,
  SegmentedControl,
  SummaryList,
  SummaryRow,
  SummaryTotal,
  useToast,
  TABLE,
  TABLE_HEAD_ROW,
  TABLE_TH,
  TABLE_TD_INPUT,
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

/* Which field each refusal names, so the complaint can sit under the control
   it is about rather than only in the footer. Keys are refuseExpense's exact
   messages — an unmapped refusal simply stays footer-only. */
const REFUSAL_FIELD: Record<string, 'date' | 'supplier' | 'payee' | 'bank'> = {
  'That date is not valid.': 'date',
  'A bill needs a supplier account — that is who it is owed to.': 'supplier',
  'Choose the account the money came out of.': 'bank',
  'Say who was paid.': 'payee',
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
  const refusalField = refusal ? (REFUSAL_FIELD[refusal] ?? null) : null

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

  const payeeQuery = supplierName.trim().toLowerCase()
  const payeeOptions = (
    payeeQuery
      ? suppliers.filter((s) => s.name.toLowerCase().includes(payeeQuery))
      : suppliers
  )
    .slice(0, 8)
    .map((s) => ({ value: String(s.id), label: s.name, hint: s.code }))

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
          <SegmentedControl
            aria-label="Kind of expense"
            options={[
              { value: 'direct', label: 'Paid now' },
              { value: 'on_account', label: 'Bill to pay later' },
            ]}
            value={paymentType}
            onChange={setPaymentType}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Who and when" />
        <CardBody>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Date" error={refusalField === 'date' ? refusal! : undefined}>
              <Input
                type="date"
                value={expenseDate}
                onChange={(e) => setExpenseDate(e.target.value)}
              />
            </Field>

            {isBill ? (
              <Field
                label="Supplier"
                hint="The account this is owed to."
                error={refusalField === 'supplier' ? refusal! : undefined}
              >
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
              <Field
                label="Paid to"
                hint="A supplier, or just type who it was."
                htmlFor="expense-payee"
                error={refusalField === 'payee' ? refusal! : undefined}
              >
                <Combobox
                  id="expense-payee"
                  options={payeeOptions}
                  query={supplierName}
                  onQueryChange={(next) => {
                    setSupplierName(next)
                    setSupplierId(null)
                  }}
                  onSelect={(option) => {
                    setSupplierName(option.label)
                    setSupplierId(null)
                  }}
                  placeholder="e.g. Shell Garage"
                />
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
              <Field
                label="Paid from"
                hint="Where the money came out of."
                error={refusalField === 'bank' ? refusal! : undefined}
              >
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
            <Callout tone="warning" title="This may be the same bill twice" className="mt-4">
              That invoice number is already captured on this supplier —{' '}
              {duplicate.documentNumber ?? 'a draft'} dated {duplicate.expenseDate} for{' '}
              {formatMoney(duplicate.totalIncl)}.
            </Callout>
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

          {/* Notes belong with the who-and-when story, not inside the lines
              table — they describe the expense, not a split. */}
          <Field
            label="Notes"
            hint="Anything worth remembering about this expense."
            className="mt-4"
          >
            <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
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
                    <td className={TABLE_TD_INPUT}>
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
                    <td className={TABLE_TD_INPUT}>
                      <Input
                        value={line.description}
                        onChange={(e) => updateLine(line.key, { description: e.target.value })}
                        placeholder="Optional"
                      />
                    </td>
                    {departments.length > 0 && (
                      <td className={TABLE_TD_INPUT}>
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
                    <td className={TABLE_TD_INPUT}>
                      <NumberInput
                        value={line.vatRatePct}
                        onChange={(e) =>
                          updateLine(line.key, { vatRatePct: Number(e.target.value) || 0 })
                        }
                      />
                    </td>
                    {/* The input aligns its own figures — TABLE_NUMERIC on the
                        cell would fight the control. */}
                    <td className={TABLE_TD_INPUT}>
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
                        <span className="numeric mt-1 block text-right text-xs text-muted">
                          {formatMoney(computed.excl)} + {formatMoney(computed.vat)} VAT
                        </span>
                      )}
                    </td>
                    <td className={`${TABLE_TD_INPUT} text-right`}>
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
            <SummaryList className="w-64">
              <SummaryRow label="Excluding VAT" value={formatMoney(totals.subtotalExcl)} />
              <SummaryRow label="VAT" value={formatMoney(totals.vatTotal)} />
              {totals.vatClaimable !== totals.vatTotal && (
                <SummaryRow
                  label="…of which claimable"
                  value={formatMoney(totals.vatClaimable)}
                  tone="warning"
                />
              )}
              <SummaryTotal label="Total" value={formatMoney(totals.totalIncl)} />
            </SummaryList>
          </div>
        </CardBody>

        <CardFooter>
          <div className="flex w-full items-center justify-between">
            <span className={`text-sm ${refusal ? 'text-danger' : 'text-muted'}`}>
              {refusal ?? (isBill
                ? 'Posting adds this to the supplier account.'
                : 'Posting takes the money out of the account.')}
            </span>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => router.back()}>
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
