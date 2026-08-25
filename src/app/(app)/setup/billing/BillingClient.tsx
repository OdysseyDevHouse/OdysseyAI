'use client'

import { useMemo, useState, useTransition } from 'react'
import {
  Card,
  CardBody,
  Button,
  Badge,
  Switch,
  Stepper,
  Modal,
  Callout,
  Icons,
  TextLink,
  useToast,
} from '@/components/ui'
import { TABLE_HEAD_ROW, TABLE_TH, TABLE_TD, TABLE_NUMERIC } from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import { quoteFor, storeLines, changePreview, type Holding, type PriceBook } from '@/lib/billing/pricing'
import { MODULE_CARDS, FREE_DEVICES_PER_STORE } from '@/lib/billing/catalogue'
import { periodEnd, formatPeriodDate } from '@/lib/billing/period'
import { applyModuleChangesAction, setDevicesAction, confirmPaymentAction, type BillingChange } from './actions'
import { startSubscriptionAction, cancelSubscriptionAction } from './subscribeActions'

/**
 * The plan, and the controls that change it.
 *
 * ── IT IS A PRICE LIST, NOT A SETTINGS SCREEN ───────────────────────────────
 *
 * A row with a switch tells somebody what is on. A card with a price, a
 * sentence and a ticked list of what it does tells them whether they want it —
 * and "do I want this" is the only question anybody opens this screen to
 * answer. That is why each module is a full bordered tile rather than a line.
 *
 * ── WHY NOTHING SAVES ON A CLICK ────────────────────────────────────────────
 *
 * Toggling marks a change PENDING; nothing is written until the customer
 * confirms. Upgrades bill from today and downgrades only at period end, and a
 * grid that wrote on every click would give them nowhere to see that difference
 * before agreeing to it.
 */

type SiteRow = { siteId: number; siteCode: string; displayName: string }
type DeviceRow = { siteId: number; requested: number; provisioned: number; pendingFrom: string | null }

type Props = {
  accountName: string
  accountStatus: string
  billingContact: string | null
  billingEmail: string | null
  billingDay: number
  nextBillingOn: string
  today: string
  sites: SiteRow[]
  hiddenStoreCount: number
  holdings: Holding[]
  prices: PriceBook
  devices: DeviceRow[]
  canConfirmPayment: boolean
  payfastReady: boolean
  /** Why card payments are unavailable, named so somebody can fix it. */
  payfastProblems: string[]
  subscription: {
    status: string
    amountIncl: number
    lastPaidOn: string | null
    /** False when PayFast has not yet accepted the current price. */
    synced: boolean
  } | null
  payments: {
    id: number
    amountGross: number
    paymentStatus: string
    verified: boolean
    rejectReason: string | null
    receivedAt: string | null
  }[]
}

type Pending = { siteId: number; moduleKey: string; want: boolean }

const VAT_PERCENT = 15

export default function BillingClient(props: Props) {
  const {
    accountName, accountStatus, billingContact, billingEmail,
    billingDay, nextBillingOn, today, sites, hiddenStoreCount,
    holdings, prices, devices, canConfirmPayment,
    payfastReady, payfastProblems, subscription, payments,
  } = props

  const [pending, setPending] = useState<Pending[]>([])
  const [confirming, setConfirming] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [deviceCounts, setDeviceCounts] = useState<Record<number, number>>(
    () => Object.fromEntries(devices.map((d) => [d.siteId, d.requested])),
  )
  const [saving, startSaving] = useTransition()
  const [subscribing, startSubscribing] = useTransition()
  const toast = useToast()

  /**
   * Hand the browser off to PayFast.
   *
   * A full-page form POST, not a fetch: PayFast's process URL is a browser
   * destination, and the whole point of a hosted checkout is that the card
   * details never touch this application. The fields are already signed by the
   * server — the passphrase never leaves it.
   */
  function subscribe() {
    startSubscribing(async () => {
      const result = await startSubscriptionAction()
      if ('ok' in result && result.ok === false) {
        toast.error(result.error)
        return
      }

      const form = document.createElement('form')
      form.method = 'POST'
      form.action = result.form.action
      // In iteration order, matching exactly what was signed.
      for (const [name, value] of Object.entries(result.form.fields)) {
        const input = document.createElement('input')
        input.type = 'hidden'
        input.name = name
        input.value = value
        form.appendChild(input)
      }
      document.body.appendChild(form)
      form.submit()
    })
  }

  function cancelDebitOrder() {
    startSubscribing(async () => {
      const result = await cancelSubscriptionAction()
      if ('ok' in result && result.ok === false) {
        toast.error(result.error)
        return
      }
      toast.success('The debit order has been cancelled.')
    })
  }

  const heldNow = useMemo(() => {
    const s = new Set<string>()
    for (const h of holdings) s.add(`${h.siteId}:${h.moduleKey}`)
    return s
  }, [holdings])

  const endingNow = useMemo(() => {
    const m = new Map<string, string>()
    for (const h of holdings) if (h.endsOn) m.set(`${h.siteId}:${h.moduleKey}`, h.endsOn)
    return m
  }, [holdings])

  const pendingFor = (siteId: number, key: string) =>
    pending.find((p) => p.siteId === siteId && p.moduleKey === key)

  const isOn = (siteId: number, key: string) =>
    pendingFor(siteId, key)?.want ?? heldNow.has(`${siteId}:${key}`)

  /** How many stores hold this module, counting pending changes. */
  const onCount = (key: string) => sites.filter((s) => isOn(s.siteId, key)).length

  function toggle(siteId: number, key: string, want: boolean) {
    setPending((prev) => {
      const without = prev.filter((p) => !(p.siteId === siteId && p.moduleKey === key))
      const held = heldNow.has(`${siteId}:${key}`)
      const ending = endingNow.has(`${siteId}:${key}`)
      // Back to where it started is not a change — unless it is scheduled to
      // end, where switching it on cancels the removal.
      if (want === held && !(want && ending)) return without
      return [...without, { siteId, moduleKey: key, want }]
    })
  }

  /** Ticking the card header applies to every store on the account. */
  function toggleAll(key: string, want: boolean) {
    for (const s of sites) toggle(s.siteId, key, want)
  }

  // ── Money ────────────────────────────────────────────────────────────────
  // The live figures reflect PENDING changes, so the total moves as the
  // customer ticks — which is the whole point of a pricing screen.
  const projected = useMemo<Holding[]>(() => {
    const kept = holdings.filter((h) => {
      const p = pendingFor(h.siteId, h.moduleKey)
      return p ? p.want : true
    })
    const added = pending
      .filter((p) => p.want && !heldNow.has(`${p.siteId}:${p.moduleKey}`))
      .map((p) => ({
        siteId: p.siteId,
        moduleKey: p.moduleKey,
        quantity: 1,
        agreedPrice: null,
        endsOn: null,
      }))
    return [...kept, ...added]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [holdings, JSON.stringify(pending), heldNow])

  const totalStores = sites.length + hiddenStoreCount
  const quote = useMemo(
    () => quoteFor(projected, deviceCounts, prices, VAT_PERCENT, totalStores),
    [projected, deviceCounts, prices, totalStores],
  )
  const rows = useMemo(
    () => storeLines(sites.map((s) => s.siteId), projected, deviceCounts, prices),
    [sites, projected, deviceCounts, prices],
  )

  const adding = pending.filter((p) => p.want).map(({ siteId, moduleKey }) => ({ siteId, moduleKey }))
  const removing = pending.filter((p) => !p.want).map(({ siteId, moduleKey }) => ({ siteId, moduleKey }))
  const preview = useMemo(
    () => changePreview(holdings, adding, removing, prices),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [holdings, prices, JSON.stringify(adding), JSON.stringify(removing)],
  )

  const scheduled = holdings.filter((h) => h.endsOn)
  const removalDate = periodEnd(today, billingDay)
  const siteName = (id: number) => sites.find((s) => s.siteId === id)?.displayName ?? `Store ${id}`

  const deviceDirty = devices.some((d) => (deviceCounts[d.siteId] ?? d.requested) !== d.requested)
  const dirty = pending.length > 0 || deviceDirty

  function save() {
    const changes: BillingChange[] = pending.map((p) => ({
      siteId: p.siteId,
      moduleKey: p.moduleKey,
      want: p.want,
    }))

    startSaving(async () => {
      if (changes.length) {
        const r = await applyModuleChangesAction(changes)
        if ('ok' in r && r.ok === false) {
          toast.error(r.error)
          return
        }
      }
      for (const d of devices) {
        const want = deviceCounts[d.siteId] ?? d.requested
        if (want === d.requested) continue
        const r = await setDevicesAction(d.siteId, want)
        if ('ok' in r && r.ok === false) {
          toast.error(r.error)
          return
        }
      }
      setPending([])
      setConfirming(false)
      toast.success('Plan updated.')
    })
  }

  return (
    <div className="flex flex-col gap-4">
      {accountStatus === 'suspended' ? (
        <Callout tone="danger" title="This account is suspended">
          Only the Starter Pack is active. Settle the account to restore the other modules.
        </Callout>
      ) : null}

      {scheduled.length > 0 ? (
        <Callout tone="warning" title="Scheduled to end">
          <ul className="flex flex-col gap-1">
            {scheduled.map((h) => (
              <li key={`${h.siteId}:${h.moduleKey}`} className="text-sm">
                <span className="font-medium">
                  {MODULE_CARDS.find((c) => c.key === h.moduleKey)?.name ?? h.moduleKey}
                </span>{' '}
                at {siteName(h.siteId)} ends {formatPeriodDate(h.endsOn!)}. It keeps working until
                then.
              </li>
            ))}
          </ul>
        </Callout>
      ) : null}

      {/* ── Choose your modules ──────────────────────────────────────────── */}
      <Card>
        <CardBody className="border-b border-border">
          <h2 className="font-medium text-ink">Choose your modules</h2>
          <p className="text-sm text-muted">
            Billed monthly. The Starter Pack is always included. Charged per store — you have{' '}
            {totalStores} {totalStores === 1 ? 'store' : 'stores'}.
          </p>
        </CardBody>

        <div className="flex flex-col gap-3 p-4">
          {MODULE_CARDS.map((card) => {
            const count = onCount(card.key)
            const all = count === sites.length
            const some = count > 0 && !all
            const price = prices[card.key]
            const isExpanded = expanded === card.key
            const changed = sites.some((s) => pendingFor(s.siteId, card.key))

            return (
              <div
                key={card.key}
                className={`rounded-card border p-4 transition-colors ${
                  card.required || count > 0
                    ? 'border-brand bg-brand-soft/40'
                    : 'border-border bg-surface'
                }`}
              >
                <div className="flex items-start gap-3">
                  {/* The tick. Locked on the base package — it cannot come off. */}
                  <div className="pt-0.5">
                    {card.required ? (
                      <span
                        className="flex h-5 w-5 items-center justify-center rounded border border-border bg-surface-2 text-faint"
                        aria-label="Always included"
                      >
                        <Icons.Check size={14} />
                      </span>
                    ) : (
                      <input
                        type="checkbox"
                        className="h-5 w-5 rounded border-border-strong accent-brand"
                        checked={all}
                        ref={(el) => {
                          // Partial selection across stores reads as neither on
                          // nor off, which is exactly what indeterminate means.
                          if (el) el.indeterminate = some
                        }}
                        onChange={(e) => toggleAll(card.key, e.target.checked)}
                        aria-label={card.name}
                      />
                    )}
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-ink">{card.name}</span>
                        {card.required ? (
                          <span className="text-sm text-muted">Always included</span>
                        ) : null}
                        {changed ? <Badge tone="brand">Not saved</Badge> : null}
                        {sites.length > 1 && !card.required && count > 0 ? (
                          <Badge tone={all ? 'success' : 'warning'}>
                            {all ? 'All stores' : `${count} of ${sites.length} stores`}
                          </Badge>
                        ) : null}
                      </div>
                      <div className="text-right">
                        {price ? (
                          <>
                            <div className="numeric text-lg font-semibold text-ink">
                              {formatMoney(price)}
                            </div>
                            <div className="text-sm text-muted">/mo · per store</div>
                          </>
                        ) : (
                          <Badge tone="warning">No price set</Badge>
                        )}
                      </div>
                    </div>

                    <p className="mt-1 text-sm text-muted">{card.description}</p>

                    <ul className="mt-3 flex flex-col gap-1.5">
                      {card.features.map((f) => (
                        <li key={f} className="flex items-start gap-2 text-sm text-ink-2">
                          <Icons.StatusSuccess size={16} className="mt-0.5 shrink-0 text-brand" />
                          <span>{f}</span>
                        </li>
                      ))}
                    </ul>

                    {card.limitNote ? (
                      <div className="mt-3 flex items-center gap-2 border-t border-border pt-3 text-sm text-muted">
                        <Icons.Package size={16} className="shrink-0" />
                        <span>{card.limitNote}</span>
                      </div>
                    ) : null}

                    {/* Per-store control, for an account with more than one.
                        Collapsed by default: the question is "do we want this",
                        asked once, and only sometimes "at which branch". */}
                    {sites.length > 1 && !card.required ? (
                      <div className="mt-3 border-t border-border pt-3">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setExpanded(isExpanded ? null : card.key)}
                        >
                          <Icons.ChevronDown
                            size={14}
                            className={isExpanded ? 'rotate-180 transition-transform' : 'transition-transform'}
                          />
                          {isExpanded ? 'Hide stores' : 'Choose which stores'}
                        </Button>

                        {isExpanded ? (
                          <div className="mt-2 flex flex-col gap-2">
                            {sites.map((s) => {
                              const ends = endingNow.get(`${s.siteId}:${card.key}`)
                              return (
                                <div
                                  key={s.siteId}
                                  className="flex items-center justify-between gap-3 rounded-control bg-surface-2 px-3 py-2"
                                >
                                  <div className="flex flex-col">
                                    <span className="text-sm text-ink-2">{s.displayName}</span>
                                    {ends && !pendingFor(s.siteId, card.key) ? (
                                      <span className="text-sm text-warning-ink">
                                        Ends {formatPeriodDate(ends)}
                                      </span>
                                    ) : null}
                                  </div>
                                  <Switch
                                    checked={isOn(s.siteId, card.key)}
                                    onChange={(w) => toggle(s.siteId, card.key, w)}
                                    ariaLabel={`${card.name} at ${s.displayName}`}
                                  />
                                </div>
                              )
                            })}
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </Card>

      {/* ── Point of sale devices ────────────────────────────────────────── */}
      <Card>
        <CardBody className="border-b border-border">
          <h2 className="font-medium text-ink">Point of sale devices</h2>
          <p className="text-sm text-muted">
            The first device per store is included. Each extra device is{' '}
            {formatMoney(prices.pos_device ?? 0)}/month.
          </p>
        </CardBody>

        <div className="flex flex-col">
          {devices.map((d, i) => {
            const want = deviceCounts[d.siteId] ?? d.requested
            const extra = Math.max(0, want - FREE_DEVICES_PER_STORE)
            const gap = d.provisioned < want
            return (
              <div
                key={d.siteId}
                className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-4 last:border-0"
              >
                <div className="flex items-center gap-3">
                  <span className="flex h-8 w-8 items-center justify-center rounded-control bg-brand-soft text-sm font-medium text-brand-ink">
                    {i + 1}
                  </span>
                  <div className="flex flex-col">
                    <span className="text-sm font-medium text-ink">{siteName(d.siteId)}</span>
                    <span className="numeric text-sm text-muted">
                      {extra === 0
                        ? 'First device included'
                        : `${extra} extra × ${formatMoney(prices.pos_device ?? 0)} = ${formatMoney((prices.pos_device ?? 0) * extra)} /mo`}
                    </span>
                    {/* The two numbers, stated. Never silently different. */}
                    {gap ? (
                      <span className="text-sm text-warning-ink">
                        {d.provisioned} of {want} set up
                        {d.pendingFrom ? ' — awaiting payment' : ''}
                      </span>
                    ) : null}
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <Stepper
                    value={want}
                    onChange={(n) => setDeviceCounts((p) => ({ ...p, [d.siteId]: n }))}
                    min={1}
                    max={99}
                    label={`Devices at ${siteName(d.siteId)}`}
                  />
                  <TextLink href="/setup/terminals">Manage</TextLink>
                </div>
              </div>
            )
          })}
        </div>
      </Card>

      {/* ── Summary ──────────────────────────────────────────────────────── */}
      <Card>
        <CardBody className="border-b border-border">
          <h2 className="font-medium text-ink">Summary</h2>
        </CardBody>

        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className={TABLE_HEAD_ROW}>
                <th className={TABLE_TH}>Store</th>
                <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>Modules</th>
                <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>Extra devices</th>
                <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>Store total</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.siteId}>
                  <td className={TABLE_TD}>{siteName(r.siteId)}</td>
                  <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>{formatMoney(r.moduleTotal)}</td>
                  <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                    {r.extraDevices
                      ? `${r.extraDevices} × ${formatMoney(prices.pos_device ?? 0)}`
                      : '—'}
                  </td>
                  <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>{formatMoney(r.lineTotal)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td className={`${TABLE_TD} text-muted`} colSpan={3}>
                  Subtotal
                </td>
                <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>{formatMoney(quote.subtotal)}</td>
              </tr>
              {quote.discountRate > 0 ? (
                <tr>
                  <td className={`${TABLE_TD} text-success-ink`} colSpan={3}>
                    Multi-store discount ({Math.round(quote.discountRate * 100)}% · {totalStores}{' '}
                    stores)
                  </td>
                  <td className={`${TABLE_TD} ${TABLE_NUMERIC} text-success-ink`}>
                    −{formatMoney(quote.discountAmount)}
                  </td>
                </tr>
              ) : null}
              <tr>
                <td className={`${TABLE_TD} text-muted`} colSpan={3}>
                  VAT at {VAT_PERCENT}%
                </td>
                <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>{formatMoney(quote.vat)}</td>
              </tr>
            </tfoot>
          </table>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-brand-soft/30 p-4">
          <div className="flex flex-col">
            <span className="font-medium text-ink">Total per month</span>
            <span className="text-sm text-muted">incl. VAT</span>
          </div>
          <span className="numeric text-3xl font-semibold text-brand">
            {formatMoney(quote.total)}
          </span>
        </div>

        {quote.nextPeriodTotal !== quote.total ? (
          <CardBody className="border-t border-border">
            <p className="text-sm text-muted">
              From {formatPeriodDate(nextBillingOn)} this becomes{' '}
              <span className="numeric">{formatMoney(quote.nextPeriodTotal)}</span>, once the
              scheduled changes above take effect.
            </p>
          </CardBody>
        ) : null}
      </Card>

      {/* ── The debit order ──────────────────────────────────────────────── */}
      <Card>
        <CardBody className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <span className="font-medium text-ink">Debit order</span>
              {subscription ? <Badge tone={debitTone(subscription.status)}>{debitLabel(subscription.status)}</Badge> : null}
            </div>

            {!payfastReady ? (
              <span className="text-sm text-muted">
                Card payments are not set up yet
                {payfastProblems.length ? `: ${payfastProblems[0]}` : '.'}
              </span>
            ) : subscription && subscription.status === 'active' ? (
              <>
                <span className="numeric text-sm text-muted">
                  {formatMoney(subscription.amountIncl)} a month
                  {subscription.lastPaidOn
                    ? ` · last paid ${formatPeriodDate(subscription.lastPaidOn)}`
                    : ''}
                </span>
                {/* A price PayFast has not accepted yet is worth saying out
                    loud: the customer's plan changed and their bank has not
                    heard about it, which is otherwise entirely invisible. */}
                {!subscription.synced ? (
                  <span className="text-sm text-warning-ink">
                    The new amount takes effect on the next collection.
                  </span>
                ) : null}
              </>
            ) : subscription && subscription.status === 'past_due' ? (
              <span className="text-sm text-danger-ink">
                The last collection did not go through. PayFast will try again.
              </span>
            ) : (
              <span className="text-sm text-muted">
                Pay {formatMoney(quote.total)} a month automatically, from{' '}
                {formatPeriodDate(nextBillingOn)}.
              </span>
            )}
          </div>

          <div className="flex flex-wrap gap-2">
            {payfastReady && (!subscription || subscription.status === 'none' || subscription.status === 'cancelled') ? (
              <Button variant="primary" onClick={subscribe} disabled={subscribing || dirty}>
                {subscribing ? 'Opening PayFast…' : 'Set up the debit order'}
              </Button>
            ) : null}

            {payfastReady && subscription?.status === 'active' ? (
              <Button variant="secondary" onClick={cancelDebitOrder} disabled={subscribing}>
                Cancel the debit order
              </Button>
            ) : null}
          </div>
        </CardBody>

        {/* Toggling the plan while a checkout is being set up would sign a form
            for a price that is about to change. */}
        {dirty && payfastReady && !subscription?.status.startsWith('act') ? (
          <CardBody className="border-t border-border">
            <p className="text-sm text-muted">
              Apply your plan changes first — the debit order is set up for whatever the plan
              comes to.
            </p>
          </CardBody>
        ) : null}
      </Card>

      {/* ── What has actually been collected ─────────────────────────────── */}
      {payments.length > 0 ? (
        <Card>
          <CardBody className="border-b border-border">
            <h2 className="font-medium text-ink">Payments</h2>
            <p className="text-sm text-muted">
              What PayFast has collected, and anything it tried to send that we refused.
            </p>
          </CardBody>
          <div className="flex flex-col">
            {payments.map((p) => (
              <div
                key={p.id}
                className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-4 last:border-0"
              >
                <div className="flex flex-col">
                  <span className="text-sm text-ink-2">
                    {p.receivedAt ? formatPeriodDate(p.receivedAt.slice(0, 10)) : '—'}
                  </span>
                  {/* A refused payload is shown, not hidden. It is the evidence
                      when somebody says they paid and nothing happened. */}
                  {!p.verified ? (
                    <span className="text-sm text-danger-ink">
                      Refused — {p.rejectReason ?? 'did not verify'}
                    </span>
                  ) : null}
                </div>
                <div className="flex items-center gap-3">
                  <Badge tone={p.verified && p.paymentStatus === 'COMPLETE' ? 'success' : 'warning'}>
                    {p.verified ? p.paymentStatus : 'Not verified'}
                  </Badge>
                  <span className="numeric text-sm text-ink">{formatMoney(p.amountGross)}</span>
                </div>
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      {/* ── The account, and what happens next ───────────────────────────── */}
      <Card>
        <CardBody className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex flex-col gap-1">
            <span className="text-sm text-muted">
              Billed to <span className="text-ink-2">{accountName}</span>
              {billingContact ? ` · ${billingContact}` : ''}
              {billingEmail ? ` · ${billingEmail}` : ''}
            </span>
            <span className="text-sm text-muted">
              Next charged {formatPeriodDate(nextBillingOn)}, and on the{' '}
              {ordinal(billingDay)} of each month after that.
              {hiddenStoreCount > 0
                ? ` Includes ${hiddenStoreCount} further ${hiddenStoreCount === 1 ? 'store' : 'stores'} you do not have access to.`
                : ''}
            </span>
          </div>

          <Button variant="primary" onClick={() => setConfirming(true)} disabled={!dirty || saving}>
            {dirty ? 'Review and confirm' : 'No changes to apply'}
          </Button>
        </CardBody>
      </Card>

      {/* Until the payment gateway lands, somebody has to say the money
          arrived before a licence is created. This button is that step, and
          the webhook replaces it without changing anything else. */}
      {canConfirmPayment && devices.some((d) => d.pendingFrom) ? (
        <Callout tone="brand" title="Till licences awaiting payment">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-sm">
              Once payment has cleared, confirm it here and the extra licences are set up.
            </span>
            <Button
              variant="secondary"
              disabled={saving}
              onClick={() =>
                startSaving(async () => {
                  for (const d of devices.filter((x) => x.pendingFrom)) {
                    const r = await confirmPaymentAction(d.siteId)
                    if ('ok' in r && r.ok === false) {
                      toast.error(r.error)
                      return
                    }
                  }
                  toast.success('Licences set up.')
                })
              }
            >
              Confirm payment received
            </Button>
          </div>
        </Callout>
      ) : null}

      <Modal
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Confirm these changes"
        /* Three change lists — adding, removing, device deltas — and a shop
           changing plan can have a lot of each. The default 60vh cap hid the
           tail of the very list somebody is being asked to approve. */
        bodyGrows
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setConfirming(false)} disabled={saving}>
              Cancel
            </Button>
            <Button variant="primary" onClick={save} disabled={saving}>
              {saving ? 'Applying…' : 'Apply changes'}
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-4">
          {adding.length > 0 ? (
            <div className="flex flex-col gap-1">
              <p className="text-sm font-medium text-ink">Added, from today</p>
              <ul className="flex flex-col gap-1">
                {adding.map((a) => (
                  <li key={`${a.siteId}:${a.moduleKey}`} className="text-sm text-ink-2">
                    {MODULE_CARDS.find((c) => c.key === a.moduleKey)?.name ?? a.moduleKey} at{' '}
                    {siteName(a.siteId)}
                  </li>
                ))}
              </ul>
              <p className="numeric text-sm text-success-ink">
                +{formatMoney(preview.addedMonthly)} per month
              </p>
            </div>
          ) : null}

          {removing.length > 0 ? (
            <div className="flex flex-col gap-1">
              <p className="text-sm font-medium text-ink">
                Removed, from {formatPeriodDate(removalDate)}
              </p>
              <ul className="flex flex-col gap-1">
                {removing.map((r) => (
                  <li key={`${r.siteId}:${r.moduleKey}`} className="text-sm text-ink-2">
                    {MODULE_CARDS.find((c) => c.key === r.moduleKey)?.name ?? r.moduleKey} at{' '}
                    {siteName(r.siteId)}
                  </li>
                ))}
              </ul>
              <p className="numeric text-sm text-muted">
                −{formatMoney(preview.removedMonthly)} per month
              </p>
              {/* The single most important sentence here. Without it a customer
                  reads the removal as "switched off now" and rings to ask why
                  they were charged. */}
              <p className="text-sm text-muted">
                These keep working until {formatPeriodDate(removalDate)} and are on this month’s
                bill.
              </p>
            </div>
          ) : null}

          {deviceDirty ? (
            <div className="flex flex-col gap-1">
              <p className="text-sm font-medium text-ink">Till licences</p>
              <ul className="flex flex-col gap-1">
                {devices
                  .filter((d) => (deviceCounts[d.siteId] ?? d.requested) !== d.requested)
                  .map((d) => {
                    const want = deviceCounts[d.siteId] ?? d.requested
                    return (
                      <li key={d.siteId} className="text-sm text-ink-2">
                        {siteName(d.siteId)}: {d.requested} → {want}
                      </li>
                    )
                  })}
              </ul>
              <p className="text-sm text-muted">
                An extra licence is set up once payment has cleared. Reducing takes effect at once.
              </p>
            </div>
          ) : null}
        </div>
      </Modal>
    </div>
  )
}

/** A debit order's state, in words a shop owner uses. */
function debitLabel(status: string): string {
  switch (status) {
    case 'active': return 'Active'
    case 'pending': return 'Awaiting first payment'
    case 'past_due': return 'Payment failed'
    case 'paused': return 'Paused'
    case 'cancelled': return 'Cancelled'
    default: return 'Not set up'
  }
}

function debitTone(status: string): 'success' | 'warning' | 'danger' | 'neutral' {
  if (status === 'active') return 'success'
  if (status === 'past_due') return 'danger'
  if (status === 'pending' || status === 'paused') return 'warning'
  return 'neutral'
}

function ordinal(n: number): string {
  if (n >= 11 && n <= 13) return `${n}th`
  const last = n % 10
  if (last === 1) return `${n}st`
  if (last === 2) return `${n}nd`
  if (last === 3) return `${n}rd`
  return `${n}th`
}
