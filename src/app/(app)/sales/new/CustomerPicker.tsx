'use client'

import { useEffect, useState } from 'react'
import {
  Badge,
  Button,
  Combobox,
  Field,
  Icons,
  Input,
  Modal,
  type ComboboxOption,
} from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import type { TillCustomer } from '@/lib/site/tillCustomers'
import { searchCustomersAction } from '../actions'

/**
 * Attaching a customer to a sale.
 *
 * Two different things share this control, and keeping them distinct matters:
 *
 *   A WALK-IN is just a name typed on the document. No account is created, the
 *   debtors book stays a list of real accounts, and the sale must be paid for
 *   now.
 *
 *   An ACCOUNT CUSTOMER is a real debtor record. Attaching one unlocks the
 *   Account tender and shows how much credit is left — which is the number the
 *   cashier actually needs before offering it.
 */
export default function CustomerPicker({
  customer,
  walkInName,
  onAttach,
  onClear,
  onWalkInName,
}: {
  customer: TillCustomer | null
  walkInName: string
  onAttach: (customer: TillCustomer) => void
  onClear: () => void
  onWalkInName: (name: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [options, setOptions] = useState<TillCustomer[]>([])
  const [searching, setSearching] = useState(false)

  useEffect(() => {
    if (!open || query.trim().length < 2) {
      setOptions([])
      return
    }
    const timer = setTimeout(() => {
      setSearching(true)
      searchCustomersAction(query)
        .then(setOptions)
        .finally(() => setSearching(false))
    }, 180)
    return () => clearTimeout(timer)
  }, [query, open])

  const comboOptions: ComboboxOption<TillCustomer>[] = options.map((c) => ({
    value: String(c.id),
    label: c.name,
    hint: c.creditBlockedReason ?? `${c.code} · ${formatMoney(c.availableCredit)} available`,
    trailing: c.balance !== 0 ? formatMoney(c.balance) : undefined,
    // Blocked accounts stay visible but unpickable: a cashier needs to see WHY
    // rather than conclude the customer does not exist.
    disabled: Boolean(c.creditBlockedReason),
    data: c,
  }))

  if (customer) {
    return (
      <div className="flex flex-col gap-2 rounded-card border border-border bg-surface p-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate font-medium text-ink">{customer.name}</div>
            <div className="text-xs text-muted">
              {customer.code} ·{' '}
              {customer.paymentTermsDays === 0 ? 'COD' : `${customer.paymentTermsDays} days`}
            </div>
          </div>
          <Button variant="bare" size="sm" iconOnly aria-label="Remove customer" onClick={onClear}>
            <Icons.Close size={15} />
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-border pt-2 text-xs">
          {customer.creditBlockedReason ? (
            <Badge tone="danger">{customer.creditBlockedReason}</Badge>
          ) : (
            <>
              <span className="text-muted">Available credit</span>
              <span className="numeric font-medium text-ink">
                {formatMoney(customer.availableCredit)}
              </span>
              {customer.balance !== 0 && (
                <span className="text-muted">
                  · owes {formatMoney(customer.balance)}
                </span>
              )}
            </>
          )}
        </div>
      </div>
    )
  }

  return (
    <>
      <div className="flex flex-col gap-2">
        <Field label="Customer" hint="Leave blank for a walk-in, or attach an account.">
          <Input
            value={walkInName}
            onChange={(e) => onWalkInName(e.target.value)}
            placeholder="Walk-in"
          />
        </Field>
        <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
          <Icons.Contact size={15} />
          Attach an account
        </Button>
      </div>

      <Modal
        open={open}
        onClose={() => {
          setOpen(false)
          setQuery('')
        }}
        title="Attach a customer account"
        description="Unlocks the Account tender and shows their remaining credit."
        size="sm"
      >
        <Combobox
          options={comboOptions}
          query={query}
          onQueryChange={setQuery}
          onSelect={(option) => {
            if (!option.data) return
            onAttach(option.data)
            setOpen(false)
            setQuery('')
          }}
          placeholder="Search by code, name, phone or loyalty number…"
          loading={searching}
          autoFocus
          emptyText={query.trim().length >= 2 ? 'No account matches.' : 'Keep typing…'}
        />
      </Modal>
    </>
  )
}
