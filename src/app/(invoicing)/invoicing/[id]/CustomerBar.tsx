'use client'

import { useEffect, useRef, useState } from 'react'
import {
  Button,
  Card,
  Icons,
  Input,
  Modal,
  useToast,
} from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import { searchCustomersAction } from '@/app/(app)/sales/actions'
import { listCustomersAction } from '../actions'
import type { TillCustomer } from '@/lib/site/tillCustomers'

/**
 * Who the invoice is for.
 *
 * A back-office invoice posts to an account, so the credit position is shown
 * as soon as a customer is attached — finding out at Finalise that the account
 * is blocked is finding out one screen too late.
 */
export default function CustomerBar({
  customerId,
  customerName,
  editable,
  onPick,
}: {
  customerId: number | null
  customerName: string
  editable: boolean
  onPick: (customer: { id: number; name: string } | null) => void
}) {
  const toast = useToast()
  const [picking, setPicking] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<TillCustomer[]>([])
  const [searching, setSearching] = useState(false)
  const defaultList = useRef<TillCustomer[] | null>(null)

  /*
   * Two sources feed one list: the opening hundred, and the search.
   *
   * A short term falls back to the default list rather than blanking it —
   * typing one letter and being shown nothing reads as "no such customer",
   * when the truth is the search has not started yet.
   */
  useEffect(() => {
    if (!picking) return

    const needle = query.trim()

    if (needle.length < 2) {
      // Held from the first open, so deleting a search term restores the list
      // instantly instead of re-querying on every backspace.
      if (defaultList.current) {
        setResults(defaultList.current)
        setSearching(false)
        return
      }

      let cancelled = false
      setSearching(true)
      listCustomersAction()
        .then((rows) => {
          defaultList.current = rows
          if (!cancelled) setResults(rows)
        })
        .finally(() => {
          if (!cancelled) setSearching(false)
        })
      return () => {
        cancelled = true
      }
    }

    const timer = setTimeout(() => {
      setSearching(true)
      searchCustomersAction(needle)
        .then(setResults)
        .finally(() => setSearching(false))
    }, 180)
    return () => clearTimeout(timer)
  }, [query, picking])

  function choose(customer: TillCustomer) {
    if (customer.creditBlockedReason) {
      toast.error(customer.creditBlockedReason)
      return
    }
    onPick({ id: customer.id, name: customer.name })
    setPicking(false)
    setQuery('')
  }

  return (
    <>
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5">
          <div className="flex items-center gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-card bg-brand-soft text-brand">
              <Icons.Users size={18} />
            </span>
            <div>
              <p className="text-sm font-medium text-ink">Customer</p>
              <p className="text-xs text-muted">
                {customerName
                  ? customerId
                    ? customerName
                    : `${customerName} · once-off, not an account`
                  : 'None selected'}
              </p>
            </div>
          </div>

          {editable && (
            <div className="flex flex-wrap items-center gap-2">
              {(customerId || customerName) && (
                <Button variant="secondary" size="sm" onClick={() => onPick(null)}>
                  Clear
                </Button>
              )}
              <Button variant="secondary" size="sm" onClick={() => setPicking(true)}>
                <Icons.Users size={15} />
                Select customer
              </Button>
            </div>
          )}
        </div>
      </Card>

      <Modal
        open={picking}
        onClose={() => setPicking(false)}
        title="Select customer"
        description="Search by code, name or phone number."
      >
        <div className="flex flex-col gap-3">
          <Input
            autoFocus
            value={query}
            placeholder="Search by code, name or phone…"
            aria-label="Search customers"
            onChange={(e) => setQuery(e.target.value)}
          />

          {searching && <p className="text-sm text-muted">Loading…</p>}

          {/* Says which hundred these are. A list that silently stops at 100
              looks like the whole book to someone whose customer is not on
              it. */}
          {!searching && query.trim().length < 2 && results.length > 0 && (
            <p className="text-xs text-muted">
              {results.length === 100
                ? 'First 100 by name — type to search the rest.'
                : `${results.length} customer${results.length === 1 ? '' : 's'}`}
            </p>
          )}

          {!searching && query.trim().length >= 2 && results.length === 0 && (
            <p className="text-sm text-muted">No account matches “{query.trim()}”.</p>
          )}

          {/* Scrolls itself: a hundred rows would otherwise run the modal off
              the bottom of the screen and take the search box with it. */}
          <ul className="-mx-1 flex max-h-[26rem] flex-col divide-y divide-border overflow-y-auto px-1">
            {results.map((customer) => (
              <li key={customer.id}>
                {/* A multi-line selection row, which the kit's Button cannot
                    express. data-kit-ok — see odyssey-ui's escape hatch. */}
                <button
                  data-kit-ok
                  type="button"
                  onClick={() => choose(customer)}
                  className="flex w-full items-center justify-between gap-3 px-1 py-2.5 text-left transition hover:bg-surface-2"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-ink">
                      {customer.name}
                    </span>
                    <span className="block truncate text-xs text-muted">
                      {customer.code}
                      {customer.creditBlockedReason ? ` · ${customer.creditBlockedReason}` : ''}
                    </span>
                  </span>
                  <span className="numeric shrink-0 text-right text-xs text-muted">
                    <span className="block">Balance {formatMoney(customer.balance)}</span>
                    <span className="block">Available {formatMoney(customer.availableCredit)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </Modal>
    </>
  )
}
