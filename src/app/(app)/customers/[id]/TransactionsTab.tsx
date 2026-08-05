'use client'

import LedgerTab, { type OpenItem, type PostInput } from '@/components/ledger/LedgerTab'
import type { LedgerRow } from '@/components/ledger/TransactionTable'
import {
  postTransactionAction,
  allocateAction,
  autoAllocateAction,
  reverseTransactionAction,
} from '../ledgerActions'

/**
 * Binds the shared ledger screen to the DEBTORS actions.
 *
 * The screen itself lives in components/ledger — posting and allocation work
 * identically on both sides. Only which server actions it calls differs, and
 * those stay per-entity so each writes its own table.
 */
export default function TransactionsTab({
  customerId,
  autoAllocatesByDefault,
  lines,
  openDebits,
  unappliedCredits,
}: {
  customerId: number
  /** From the account type: balance-brought-forward allocates automatically. */
  autoAllocatesByDefault: boolean
  lines: LedgerRow[]
  openDebits: OpenItem[]
  unappliedCredits: OpenItem[]
}) {
  return (
    <LedgerTab
      lines={lines}
      openDebits={openDebits}
      unappliedCredits={unappliedCredits}
      paymentLabel="Payment received"
      autoAllocatesByDefault={autoAllocatesByDefault}
      onPost={(input: PostInput) => postTransactionAction({ customerId, ...input })}
      onAllocate={(debitId, creditId, amount) =>
        allocateAction(customerId, debitId, creditId, amount)
      }
      onAutoAllocate={(creditId) => autoAllocateAction(customerId, creditId)}
      onReverse={(transactionId, reason) =>
        reverseTransactionAction(customerId, transactionId, reason)
      }
    />
  )
}
