'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Button, Field, Input, Select, Icons, Modal, useToast } from '@/components/ui'
import {
  ACCOUNT_TYPES,
  ACCOUNT_TYPE_LABELS,
  ACCOUNT_TYPE_HINTS,
  SUBTYPE_LABELS,
  type AccountType,
} from '@/lib/glModel'
import { saveAccountAction } from './actions'

type Account = {
  id: number
  accountCode: string
  name: string
  accountType: AccountType
  subtype: string | null
}

/**
 * Adding an account to the chart.
 *
 * Editing an existing one happens on its own page, where its balance and
 * history are visible — changing the type of an account that has been posted to
 * is refused there for a reason, and doing it from a modal with no context
 * would make that refusal look arbitrary.
 */
export function AccountsClient({ accounts }: { accounts: Account[] }) {
  const router = useRouter()
  const toast = useToast()
  const [pending, startTransition] = useTransition()
  const [open, setOpen] = useState(false)

  const [accountCode, setAccountCode] = useState('')
  const [name, setName] = useState('')
  const [accountType, setAccountType] = useState<AccountType>('expense')
  const [subtype, setSubtype] = useState<string>('operating')
  const [touched, setTouched] = useState<{ code: boolean; name: boolean }>({
    code: false,
    name: false,
  })

  // Only the groupings that make sense for the chosen type — offering
  // "current asset" under income is noise that invites a mistake.
  const subtypesForType: Record<AccountType, string[]> = {
    asset: ['current_asset', 'fixed_asset'],
    liability: ['current_liability', 'long_term_liability'],
    equity: ['equity'],
    income: ['revenue', 'other_income'],
    expense: ['cost_of_sales', 'operating', 'financial'],
  }

  const available = subtypesForType[accountType]
  // Derived, never set during render: when the chosen type invalidates the
  // stored subtype, fall back to the first valid one for display and submit.
  const effectiveSubtype = available.includes(subtype) ? subtype : available[0]

  const codeError =
    touched.code && !accountCode.trim() ? 'Every account needs a code.' : undefined
  const nameError = touched.name && !name.trim() ? 'Give the account a name.' : undefined

  // The next free code in the type's usual band, so nobody has to work it out.
  function suggestCode(type: AccountType): string {
    const bands: Record<AccountType, number> = {
      asset: 1000, liability: 2000, equity: 3000, income: 4000, expense: 6000,
    }
    const base = bands[type]
    const used = accounts
      .map((a) => Number(a.accountCode))
      .filter((n) => Number.isFinite(n) && n >= base && n < base + 1000)
    const next = used.length > 0 ? Math.max(...used) + 10 : base
    return String(next)
  }

  return (
    <>
      {/* The screen's one primary action — nothing else on it mutates. */}
      <Button
        onClick={() => {
          setAccountCode(suggestCode('expense'))
          setName('')
          setAccountType('expense')
          setSubtype('operating')
          setTouched({ code: false, name: false })
          setOpen(true)
        }}
      >
        <Icons.Plus size={15} />
        Add account
      </Button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="New account"
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={pending || !accountCode.trim() || !name.trim()}
              onClick={() =>
                startTransition(async () => {
                  const result = await saveAccountAction({
                    accountCode: accountCode.trim(),
                    name: name.trim(),
                    accountType,
                    subtype: effectiveSubtype,
                    sortOrder: Number(accountCode) || 5000,
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
              Add
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Type" hint={ACCOUNT_TYPE_HINTS[accountType]}>
            <Select
              value={accountType}
              onChange={(e) => {
                const next = e.target.value as AccountType
                setAccountType(next)
                setAccountCode(suggestCode(next))
              }}
            >
              {ACCOUNT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {ACCOUNT_TYPE_LABELS[t]}
                </option>
              ))}
            </Select>
          </Field>

          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Code" error={codeError}>
              <Input
                value={accountCode}
                onChange={(e) => setAccountCode(e.target.value)}
                onBlur={() => setTouched((t) => ({ ...t, code: true }))}
                maxLength={16}
              />
            </Field>
            <div className="sm:col-span-2">
              <Field label="Name" error={nameError}>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onBlur={() => setTouched((t) => ({ ...t, name: true }))}
                  placeholder="e.g. Waste removal"
                />
              </Field>
            </div>
          </div>

          <Field label="Grouping" hint="Where it appears on the statement.">
            <Select value={effectiveSubtype} onChange={(e) => setSubtype(e.target.value)}>
              {available.map((s) => (
                <option key={s} value={s}>
                  {SUBTYPE_LABELS[s] ?? s}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </Modal>
    </>
  )
}
