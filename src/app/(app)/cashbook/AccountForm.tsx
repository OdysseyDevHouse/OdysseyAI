'use client'

import { useState, useTransition } from 'react'
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
  Switch,
  Textarea,
  useToast,
} from '@/components/ui'
import { ACCOUNT_TYPE_LABELS, BANK_ACCOUNT_TYPES, type BankAccountType } from '@/lib/site/cashbookRules'
import { createAccountAction, updateAccountAction, closeAccountAction } from './actions'

/**
 * Creating and editing a bank, cash or card account.
 *
 * Grouped by what the user is doing rather than by column order: what the
 * account IS, where it starts, and how it is used. The opening balance sits in
 * its own group because it is the one field that moves a figure — everything
 * else here is descriptive.
 */

export type AccountFormValues = {
  id?: number
  code: string
  name: string
  accountType: BankAccountType
  bankName: string | null
  accountNumber: string | null
  branchCode: string | null
  openingBalance: number
  openingDate: string | null
  isDefaultReceipts: boolean
  isDefaultPayments: boolean
  notes: string | null
  /** Present on an existing account — closing is refused while it holds money. */
  balance?: number
}

export function AccountForm({ account }: { account?: AccountFormValues }) {
  const router = useRouter()
  const toast = useToast()
  const [pending, startTransition] = useTransition()

  const [code, setCode] = useState(account?.code ?? '')
  const [name, setName] = useState(account?.name ?? '')
  const [accountType, setAccountType] = useState<BankAccountType>(account?.accountType ?? 'bank')
  const [bankName, setBankName] = useState(account?.bankName ?? '')
  const [accountNumber, setAccountNumber] = useState(account?.accountNumber ?? '')
  const [branchCode, setBranchCode] = useState(account?.branchCode ?? '')
  const [openingBalance, setOpeningBalance] = useState(account?.openingBalance ?? 0)
  const [openingDate, setOpeningDate] = useState(account?.openingDate ?? '')
  const [isDefaultReceipts, setIsDefaultReceipts] = useState(account?.isDefaultReceipts ?? false)
  const [isDefaultPayments, setIsDefaultPayments] = useState(account?.isDefaultPayments ?? false)
  const [notes, setNotes] = useState(account?.notes ?? '')

  const isEdit = account?.id !== undefined
  const isBank = accountType === 'bank'

  function save() {
    startTransition(async () => {
      const payload = {
        code: code.trim(),
        name: name.trim(),
        accountType,
        bankName: bankName.trim() || undefined,
        accountNumber: accountNumber.trim() || undefined,
        branchCode: branchCode.trim() || undefined,
        openingBalance,
        openingDate: openingDate || undefined,
        isDefaultReceipts,
        isDefaultPayments,
      }

      const result = isEdit
        ? await updateAccountAction(account!.id!, payload)
        : await createAccountAction(payload)

      if (result.ok) {
        toast.success(result.message)
        router.push(isEdit ? `/cashbook/${account!.id}` : '/cashbook')
      } else {
        toast.error(result.error)
      }
    })
  }

  return (
    <>
      <Card>
        <CardHeader title="What this account is" />
        <CardBody>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Code" hint="Short handle used on screens and imports.">
              {/* Constrained: a 24-character code in a full-width box invites a
                  sentence. See the note on field width in odyssey-craft. */}
              <Input
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                placeholder="FNB-CHQ"
                maxLength={24}
                className="max-w-40"
              />
            </Field>
            <Field label="Name">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="FNB Cheque Account"
              />
            </Field>
            <Field
              label="Type"
              hint={
                isBank
                  ? 'Reconciled against a bank statement.'
                  : accountType === 'cash'
                    ? 'Counted rather than reconciled.'
                    : 'Where a card acquirer settles, net of fees.'
              }
            >
              <Select
                value={accountType}
                onChange={(e) => setAccountType(e.target.value as BankAccountType)}
              >
                {BANK_ACCOUNT_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {ACCOUNT_TYPE_LABELS[t]}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          {/* Bank details only matter for a real bank or card account — a petty
              cash tin has no branch code. */}
          {accountType !== 'cash' && (
            <div className="mt-4 grid gap-4 sm:grid-cols-3">
              <Field label="Bank" hint="Optional">
                <Input value={bankName} onChange={(e) => setBankName(e.target.value)} />
              </Field>
              <Field label="Account number" hint="Optional">
                <Input
                  value={accountNumber}
                  onChange={(e) => setAccountNumber(e.target.value)}
                />
              </Field>
              <Field label="Branch code" hint="Optional">
                <Input
                  value={branchCode}
                  onChange={(e) => setBranchCode(e.target.value)}
                  className="max-w-32"
                />
              </Field>
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Where it starts"
          description="What the account held before anything was captured here. The running balance builds on this."
        />
        <CardBody>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Opening balance"
              hint={
                isEdit
                  ? 'Changing this moves the current balance by the same amount.'
                  : 'Leave at zero if you are starting from nothing.'
              }
            >
              <CurrencyInput
                value={openingBalance}
                onChange={(e) =>
                  setOpeningBalance(Number(String(e.target.value).replace(',', '.')) || 0)
                }
                className="max-w-48"
              />
            </Field>
            <Field label="As at" hint="Optional — the date that balance was true.">
              <Input
                type="date"
                value={openingDate}
                onChange={(e) => setOpeningDate(e.target.value)}
                className="max-w-48"
              />
            </Field>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="How it is used"
          description="Only one account can be the default for each. Setting one here clears the other."
        />
        <CardBody>
          <div className="space-y-4">
            <Switch
              checked={isDefaultReceipts}
              onChange={setIsDefaultReceipts}
              label="Money comes in here by default"
              hint="Where till takings are banked and customer receipts land."
            />
            <Switch
              checked={isDefaultPayments}
              onChange={setIsDefaultPayments}
              label="Money goes out from here by default"
              hint="Which account a supplier payment run draws on."
            />
            <Field label="Notes" hint="Optional">
              <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </Field>
          </div>
        </CardBody>
        <CardFooter>
          <div className="flex w-full items-center justify-between">
            {isEdit ? (
              <Button
                variant="danger-ghost"
                disabled={pending}
                onClick={() => {
                  if (!window.confirm('Close this account? Its history is kept.')) return
                  startTransition(async () => {
                    const result = await closeAccountAction(account!.id!)
                    if (result.ok) {
                      toast.success(result.message)
                      router.push('/cashbook')
                    } else {
                      toast.error(result.error)
                    }
                  })
                }}
              >
                Close account
              </Button>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => router.back()}>
                Cancel
              </Button>
              <Button disabled={pending || !code.trim() || !name.trim()} onClick={save}>
                {isEdit ? 'Save changes' : 'Create account'}
              </Button>
            </div>
          </div>
        </CardFooter>
      </Card>
    </>
  )
}
