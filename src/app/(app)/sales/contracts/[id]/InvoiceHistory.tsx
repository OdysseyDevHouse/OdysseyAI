'use client'

import { useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Badge,
  Button,
  DataTable,
  Icons,
  TextLink,
  useToast,
  type Column,
} from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import { postContractInvoiceAction, sendContractInvoiceAction } from '../actions'

/**
 * What a contract has billed, month by month.
 *
 * Two states matter and they are tracked separately, because they fail
 * independently: whether the invoice POSTED (the customer owes it) and whether
 * it was SENT (they know about it). An invoice that posted but bounced needs a
 * resend, not a re-bill — conflating the two is how somebody gets billed twice.
 */

export type HistoryRow = {
  id: number
  forDate: string
  documentId: number | null
  documentNumber: string | null
  status: 'draft' | 'posted' | 'failed'
  emailStatus: 'pending' | 'sent' | 'failed' | 'skipped'
  emailedTo: string | null
  emailedAt: Date | null
  totalIncl: number
  error: string | null
}

export function InvoiceHistory({
  contractId,
  customerId,
  rows,
  canAct,
  emailConfigured,
}: {
  contractId: number
  /** Who the draft posts to. The contract's customer, not the row's. */
  customerId: number
  rows: HistoryRow[]
  canAct: boolean
  emailConfigured: boolean
}) {
  const router = useRouter()
  const toast = useToast()
  const [pending, startTransition] = useTransition()

  function run(action: () => Promise<{ ok: boolean; message?: string; error?: string }>) {
    startTransition(async () => {
      const result = await action()
      if (result.ok) {
        toast.success(result.message ?? 'Done.')
        router.refresh()
      } else {
        toast.error(result.error ?? 'That did not work.')
      }
    })
  }

  const columns: Column<HistoryRow>[] = [
    {
      key: 'period',
      header: 'Period',
      cell: (r) => <span className="text-ink">{r.forDate}</span>,
      sortValue: (r) => r.forDate,
    },
    {
      key: 'invoice',
      header: 'Invoice',
      cell: (r) =>
        r.documentId ? (
          <TextLink href={`/sales/${r.documentId}`}>
            {r.documentNumber ?? `#${r.documentId}`}
          </TextLink>
        ) : (
          <span className="text-faint">—</span>
        ),
      sortValue: (r) => r.documentNumber ?? '',
    },
    {
      key: 'status',
      header: 'Posted',
      cell: (r) =>
        r.status === 'posted' ? (
          <Badge tone="success">Posted</Badge>
        ) : r.status === 'failed' ? (
          <Badge tone="danger">Failed</Badge>
        ) : (
          <Badge tone="warning">Draft</Badge>
        ),
      sortValue: (r) => (r.status === 'failed' ? 0 : r.status === 'draft' ? 1 : 2),
    },
    {
      key: 'email',
      header: 'Emailed',
      cell: (r) =>
        r.emailStatus === 'sent' ? (
          <>
            <Badge tone="success">Sent</Badge>
            {r.emailedTo ? (
              <span className="mt-0.5 block truncate text-xs text-muted">{r.emailedTo}</span>
            ) : null}
          </>
        ) : r.emailStatus === 'failed' ? (
          <Badge tone="danger">Bounced</Badge>
        ) : r.emailStatus === 'skipped' ? (
          <Badge tone="default">Not sent</Badge>
        ) : (
          <Badge tone="default">Waiting</Badge>
        ),
      sortValue: (r) => (r.emailStatus === 'failed' ? 0 : r.emailStatus === 'sent' ? 2 : 1),
    },
    {
      key: 'amount',
      header: 'Amount',
      numeric: true,
      cell: (r) => <span className="text-ink">{formatMoney(r.totalIncl)}</span>,
      sortValue: (r) => r.totalIncl,
    },
  ]

  return (
    <DataTable
      columns={columns}
      rows={rows}
      getRowKey={(r) => r.id}
      actions={
        canAct
          ? (r) => (
              <div className="flex justify-end gap-1">
                {/* Release: post a draft to the account. The manual counterpart
                    of auto-send, and the one action a due screen exists for. */}
                {r.status === 'draft' && r.documentId ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={pending}
                    onClick={() =>
                      run(() => postContractInvoiceAction(r.documentId!, customerId, contractId))
                    }
                  >
                    Post
                  </Button>
                ) : null}

                {/* Resend re-renders and re-sends the SAME document. Nothing on
                    the ledger moves, which is what makes it safe to offer. */}
                {r.status === 'posted' && emailConfigured ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    iconOnly
                    aria-label={
                      r.emailStatus === 'sent'
                        ? `Send ${r.documentNumber ?? 'invoice'} again`
                        : `Email ${r.documentNumber ?? 'invoice'}`
                    }
                    disabled={pending}
                    onClick={() => run(() => sendContractInvoiceAction(r.id, contractId))}
                  >
                    <Icons.Send size={14} />
                  </Button>
                ) : null}
              </div>
            )
          : undefined
      }
      empty={{
        title: 'Nothing billed yet',
        hint: 'Invoices appear here as the contract bills them, with what happened to each one.',
      }}
    />
  )
}
