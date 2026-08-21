'use client'

import { useState, useTransition } from 'react'
import {
  Button,
  Card,
  CardHeader,
  CardBody,
  DataTable,
  StatStrip,
  StatTile,
  Field,
  NumberInput,
  CurrencyInput,
  Input,
  Textarea,
  Badge,
  Callout,
  EmptyState,
  Modal,
  useToast,
  Icons,
  type Column,
  type BadgeTone,
} from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import {
  adjustPointsAction,
  adjustWalletAction,
  issueVoucherAction,
  voidVoucherAction,
  recalcMemberAction,
} from '@/app/(app)/loyalty/actions'

export type LedgerRowView = {
  id: number
  when: string
  entryType: string
  points: number
  documentNumber: string
  note: string
  userName: string
}

export type VoucherRowView = {
  id: number
  code: string
  description: string
  rewardLabel: string
  status: string
  expiresOn: string | null
  redeemedDocNumber: string
}

export type CardProgressView = {
  cardId: number
  name: string
  stamps: number
  requiredStamps: number
  rewardLabel: string
}

export type WalletRowView = {
  id: number
  when: string
  entryType: string
  amount: number
  tenderName: string
  documentNumber: string
  note: string
}

/** How each kind of movement reads at a glance. */
const ENTRY: Record<string, { label: string; tone: BadgeTone }> = {
  earn: { label: 'Earned', tone: 'success' },
  redeem: { label: 'Spent', tone: 'danger' },
  expire: { label: 'Expired', tone: 'warning' },
  adjust: { label: 'Adjusted', tone: 'neutral' },
  reverse: { label: 'Reversed', tone: 'warning' },
}

const VOUCHER_STATUS: Record<string, BadgeTone> = {
  issued: 'success',
  redeemed: 'neutral',
  expired: 'warning',
  void: 'danger',
}

const WALLET_ENTRY: Record<string, string> = {
  topup: 'Loaded',
  spend: 'Spent',
  refund: 'Refunded',
  adjust: 'Adjusted',
}

export function LoyaltyTab({
  memberId,
  enabled,
  points,
  pointsValue,
  walletBalance,
  tierName,
  tierColor,
  qualifyingSpend,
  nextTierName,
  nextTierShortfall,
  ledger,
  vouchers,
  cards,
  wallet,
  canAdjust,
}: {
  /**
   * The MEMBER this tab acts on — not the customer whose page it sits in.
   *
   * The two were the same number until the member file was split out, and every
   * action below is keyed on this one. Both are `number`, so nothing but this
   * name stops a customer id being passed here and quietly adjusting the wrong
   * account.
   */
  memberId: number
  enabled: boolean
  points: number
  pointsValue: number
  walletBalance: number
  tierName: string
  tierColor: string
  qualifyingSpend: number
  nextTierName: string | null
  nextTierShortfall: number
  ledger: LedgerRowView[]
  vouchers: VoucherRowView[]
  cards: CardProgressView[]
  wallet: WalletRowView[]
  canAdjust: boolean
}) {
  const toast = useToast()
  const [pending, start] = useTransition()
  const [open, setOpen] = useState<null | 'points' | 'wallet' | 'voucher'>(null)

  const [pointsDelta, setPointsDelta] = useState(0)
  const [walletDelta, setWalletDelta] = useState(0)
  const [voucherValue, setVoucherValue] = useState(50)
  const [voucherDays, setVoucherDays] = useState(60)
  const [reason, setReason] = useState('')

  function close() {
    setOpen(null)
    setReason('')
    setPointsDelta(0)
    setWalletDelta(0)
  }

  function run(action: () => Promise<{ ok: boolean; message?: string; error?: string }>) {
    start(async () => {
      const result = await action()
      if (!result.ok) {
        toast.error(result.error ?? 'That did not work.')
        return
      }
      toast.success(result.message ?? 'Done.')
      close()
    })
  }

  const ledgerColumns: Column<LedgerRowView>[] = [
    { key: 'when', header: 'When', cell: (r) => r.when },
    {
      key: 'type',
      header: 'What happened',
      cell: (r) => {
        const entry = ENTRY[r.entryType] ?? { label: r.entryType, tone: 'neutral' as BadgeTone }
        return <Badge tone={entry.tone}>{entry.label}</Badge>
      },
    },
    {
      key: 'points',
      header: 'Points',
      numeric: true,
      cell: (r) => (r.points > 0 ? `+${Math.round(r.points)}` : Math.round(r.points)),
      sortValue: (r) => r.points,
    },
    { key: 'doc', header: 'Sale', cell: (r) => r.documentNumber || '—' },
    { key: 'note', header: 'Detail', cell: (r) => r.note || '—' },
    { key: 'who', header: 'By', cell: (r) => r.userName || '—' },
  ]

  const voucherColumns: Column<VoucherRowView>[] = [
    { key: 'code', header: 'Code', cell: (r) => <span className="numeric font-medium">{r.code}</span> },
    { key: 'what', header: 'Reward', cell: (r) => r.rewardLabel },
    { key: 'why', header: 'For', cell: (r) => r.description || '—' },
    {
      key: 'status',
      header: 'Status',
      cell: (r) => <Badge tone={VOUCHER_STATUS[r.status] ?? 'neutral'}>{r.status}</Badge>,
    },
    { key: 'expires', header: 'Expires', cell: (r) => r.expiresOn ?? 'No expiry' },
    { key: 'used', header: 'Used on', cell: (r) => r.redeemedDocNumber || '—' },
  ]

  const walletColumns: Column<WalletRowView>[] = [
    { key: 'when', header: 'When', cell: (r) => r.when },
    { key: 'type', header: 'What happened', cell: (r) => WALLET_ENTRY[r.entryType] ?? r.entryType },
    {
      key: 'amount',
      header: 'Amount',
      numeric: true,
      cell: (r) => formatMoney(r.amount),
      sortValue: (r) => r.amount,
    },
    { key: 'how', header: 'Paid by', cell: (r) => r.tenderName || '—' },
    { key: 'doc', header: 'Sale', cell: (r) => r.documentNumber || '—' },
  ]

  return (
    <div className="space-y-4">
      {!enabled && (
        <Callout tone="warning">
          The loyalty programme is switched off, so nothing new is earning. The history below is
          still what this customer holds.
        </Callout>
      )}

      <StatStrip columns={4}>
        <StatTile
          label="Points"
          value={Math.floor(points).toLocaleString()}
          hint={`worth ${formatMoney(pointsValue)}`}
        />
        <StatTile label="Tier" value={tierName || 'None'} hint={`${formatMoney(qualifyingSpend)} qualifying spend`} />
        <StatTile
          label="Wallet"
          value={formatMoney(walletBalance)}
          hint="money loaded on the card"
        />
        <StatTile
          label="To next tier"
          value={nextTierName ? formatMoney(nextTierShortfall) : 'Top tier'}
          hint={nextTierName ? `to reach ${nextTierName}` : 'nothing higher'}
        />
      </StatStrip>

      {canAdjust && (
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" onClick={() => setOpen('points')}>
            <Icons.Gem size={16} />
            Adjust points
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setOpen('wallet')}>
            <Icons.Wallet size={16} />
            Adjust wallet
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setOpen('voucher')}>
            <Icons.Ticket size={16} />
            Give a voucher
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={() => run(() => recalcMemberAction(memberId))}
          >
            <Icons.Refresh size={16} />
            Rebuild balance
          </Button>
        </div>
      )}

      {cards.length > 0 && (
        <Card>
          <CardHeader title="Punch cards" description="How far along each running card they are." />
          <CardBody>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {cards.map((card) => (
                <div key={card.cardId} className="rounded-card border border-border p-4">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="font-medium text-ink">{card.name}</span>
                    <span className="numeric text-sm text-muted">
                      {card.stamps}/{card.requiredStamps}
                    </span>
                  </div>
                  {/* A plain proportional bar — the kit has no progress component,
                      and one card's fill is not worth adding a variant for. */}
                  <div
                    className="mt-2 h-2 w-full overflow-hidden rounded-pill bg-surface-2"
                    data-kit-ok
                  >
                    <div
                      className="h-full rounded-pill bg-brand"
                      style={{
                        width: `${Math.min(100, (card.stamps / Math.max(1, card.requiredStamps)) * 100)}%`,
                      }}
                    />
                  </div>
                  <p className="mt-2 text-xs text-muted">{card.rewardLabel}</p>
                </div>
              ))}
            </div>
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader title="Vouchers" description="Rewards issued to this customer." />
        <CardBody>
          {vouchers.length === 0 ? (
            <EmptyState
              icon={<Icons.Ticket />}
              title="No vouchers"
              hint="A voucher appears here when a punch card is completed, or when one is given by hand."
            />
          ) : (
            <DataTable
              columns={voucherColumns}
              rows={vouchers}
              getRowKey={(r) => r.id}
              actions={
                canAdjust
                  ? (row) =>
                      row.status === 'issued' ? (
                        <Button
                          variant="danger-ghost"
                          size="sm"
                          disabled={pending}
                          onClick={() => run(() => voidVoucherAction(row.id, memberId))}
                        >
                          Cancel
                        </Button>
                      ) : null
                  : undefined
              }
            />
          )}
        </CardBody>
      </Card>

      {wallet.length > 0 && (
        <Card>
          <CardHeader title="Wallet history" description="Money loaded onto the card, and spent from it." />
          <CardBody>
            <DataTable columns={walletColumns} rows={wallet} getRowKey={(r) => r.id} />
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader title="Points history" description="Every movement, and what caused it." />
        <CardBody>
          {ledger.length === 0 ? (
            <EmptyState
              icon={<Icons.Gem />}
              title="Nothing yet"
              hint="Points appear here the first time this customer earns on a sale."
            />
          ) : (
            <DataTable columns={ledgerColumns} rows={ledger} getRowKey={(r) => r.id} />
          )}
        </CardBody>
      </Card>

      <Modal
        open={open === 'points'}
        onClose={close}
        title="Adjust points"
        footer={
          <>
            <Button variant="secondary" onClick={close}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={pending}
              onClick={() => run(() => adjustPointsAction(memberId, pointsDelta, reason))}
            >
              {pending ? 'Saving…' : 'Adjust points'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field
            label="Points to add or take away"
            hint="A negative number removes points. The balance cannot go below zero."
          >
            <NumberInput
              value={pointsDelta}
              onChange={(e) => setPointsDelta(Number(e.target.value))}
              step={10}
            />
          </Field>
          <Field label="Reason" hint="Recorded against the entry — an unexplained movement is the one someone has to account for later.">
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} />
          </Field>
        </div>
      </Modal>

      <Modal
        open={open === 'wallet'}
        onClose={close}
        title="Adjust wallet"
        footer={
          <>
            <Button variant="secondary" onClick={close}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={pending}
              onClick={() => run(() => adjustWalletAction(memberId, walletDelta, reason))}
            >
              {pending ? 'Saving…' : 'Adjust wallet'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Callout tone="warning">
            This is a correction, not a top-up. Money taken over the counter should be loaded at the
            till so it reaches the cash-up.
          </Callout>
          <Field label="Amount" hint="A negative amount takes money off the card.">
            <CurrencyInput
              value={walletDelta}
              onChange={(e) => setWalletDelta(Number(e.target.value))}
            />
          </Field>
          <Field label="Reason">
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} />
          </Field>
        </div>
      </Modal>

      <Modal
        open={open === 'voucher'}
        onClose={close}
        title="Give a voucher"
        footer={
          <>
            <Button variant="secondary" onClick={close}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={pending}
              onClick={() =>
                run(() => issueVoucherAction(memberId, voucherValue, reason, voucherDays))
              }
            >
              {pending ? 'Issuing…' : 'Issue voucher'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Worth">
            <CurrencyInput
              value={voucherValue}
              onChange={(e) => setVoucherValue(Number(e.target.value))}
            />
          </Field>
          <Field label="What it is for" hint="Printed on the slip and shown at the till.">
            <Input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={150}
              placeholder="Goodwill"
            />
          </Field>
          <Field label="Valid for, in days" hint="Zero means it never expires.">
            <NumberInput
              value={voucherDays}
              onChange={(e) => setVoucherDays(Number(e.target.value))}
              min={0}
            />
          </Field>
        </div>
      </Modal>
    </div>
  )
}
