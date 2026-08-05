'use client'

import LedgerTab, { type OpenItem, type PostInput } from '@/components/ledger/LedgerTab'
import type { LedgerRow } from '@/components/ledger/TransactionTable'
import {
  postSupplierTransactionAction,
  allocateSupplierAction,
  autoAllocateSupplierAction,
  reverseSupplierTransactionAction,
} from '../ledgerActions'

/** Binds the shared ledger screen to the CREDITORS actions. */
export default function TransactionsTab({
  supplierId,
  lines,
  openDebits,
  unappliedCredits,
}: {
  supplierId: number
  lines: LedgerRow[]
  openDebits: OpenItem[]
  unappliedCredits: OpenItem[]
}) {
  return (
    <LedgerTab
      lines={lines}
      openDebits={openDebits}
      unappliedCredits={unappliedCredits}
      /* We pay them, they do not pay us — the same posting, the other way round. */
      paymentLabel="Payment made"
      onPost={(input: PostInput) => postSupplierTransactionAction({ supplierId, ...input })}
      onAllocate={(debitId, creditId, amount) =>
        allocateSupplierAction(supplierId, debitId, creditId, amount)
      }
      onAutoAllocate={(creditId) => autoAllocateSupplierAction(supplierId, creditId)}
      onReverse={(transactionId, reason) =>
        reverseSupplierTransactionAction(supplierId, transactionId, reason)
      }
    />
  )
}
