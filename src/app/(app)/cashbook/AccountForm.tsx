'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Button,
  Card,
  CardHeader,
  CardBody,
  CardFooter,
  ConfirmModal,
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
 *
 * KNOWN GAP: the create/update actions do not yet accept `notes`, so the Notes
 * field is captured here but not sent — see the note at payload().
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
  const [errors, setErrors] = useState<{ code?: string; name?: string }>({})
  const [closing, setClosing] = useState(false)

  const isEdit = account?.id !== undefined
  const isBank = accountType === 'bank'

  function save() {
    // The button stays enabled and the complaint lands under the field it
    // names — a silently disabled button is a puzzle, not validation.
    const nextErrors: { code?: string; name?: string } = {}
    if (!code.trim()) nextErrors.code = 'Give the account a short code.'
    if (!name.trim()) nextErrors.name = 'Give the account a name.'
    setErrors(nextErrors)
    if (nextErrors.code || nextErrors.name) return

    startTransition(async () => {
      // `notes` is deliberately not sent: createAccountAction/updateAccountAction
      // do not take it yet. Add it to their input type in ./actions.ts and
      // include it here — the library layer (AccountInput) already persists it.
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
            <Field
              label="Code"
              hint="Short handle used on screens and imports."
              error={errors.code}
            >
              {/* Constrained: a 24-character code in a full-width box invites a
                  sentence. See the note on field width in odyssey-craft. */}
              <Input
                value={code}
                onChange={(e) => {
                  setCode(e.target.value.toUpperCase())
                  setErrors((prev) => ({ ...prev, code: undefined }))
                }}
                placeholder="FNB-CHQ"
                maxLength={24}
                className="max-w-40"
              />
            </Field>
            <Field label="Name" error={errors.name}>
              <Input
                value={name}
                onChange={(e) => {
                  setName(e.target.value)
                  setErrors((prev) => ({ ...prev, name: undefined }))
                }}
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
              cash tin has no branch code. Only Code and Name are required, so
              these carry no "Optional" chorus. */}
          {accountType !== 'cash' && (
            <div className="mt-4 grid gap-4 sm:grid-cols-3">
              <Field label="Bank">
                <Input value={bankName} onChange={(e) => setBankName(e.target.value)} />
              </Field>
              <Field label="Account number">
                <Input
                  value={accountNumber}
                  onChange={(e) => setAccountNumber(e.target.value)}
                />
              </Field>
              <Field label="Branch code">
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
            <Field label="As at" hint="The date that balance was true.">
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
            <Field label="Notes">
              <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </Field>
          </div>
        </CardBody>
        <CardFooter>
          <div className="flex w-full items-center justify-end gap-2">
            <Button variant="secondary" onClick={() => router.back()}>
              Cancel
            </Button>
            <Button disabled={pending} onClick={save}>
              {isEdit ? 'Save changes' : 'Create account'}
            </Button>
          </div>
        </CardFooter>
      </Card>

      {/* Closing lives in its own clearly-separated section rather than beside
          Save, so a destructive act is never one slip away from a routine one. */}
      {isEdit && (
        <Card>
          <CardHeader
            title="Close this account"
            description="A closed account stops appearing in pickers. Its history is kept, and closing is refused while it still holds money."
          />
          <CardBody>
            <Button variant="danger-ghost" disabled={pending} onClick={() => setClosing(true)}>
              Close account
            </Button>
          </CardBody>
        </Card>
      )}

      <ConfirmModal
        open={closing}
        onClose={() => setClosing(false)}
        onConfirm={() => {
          setClosing(false)
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
        title="Close this account"
        message={`Close ${name.trim() || code.trim() || 'this account'}? Its history is kept.`}
        confirmLabel="Close account"
        busy={pending}
      />
    </>
  )
}
