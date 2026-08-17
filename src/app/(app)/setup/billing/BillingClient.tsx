'use client'

import { useMemo, useState, useTransition } from 'react'
import {
  Card,
  CardHeader,
  CardBody,
  Button,
  Badge,
  Switch,
  Modal,
  Callout,
  SummaryList,
  SummaryRow,
  SummaryTotal,
  StatStrip,
  StatTile,
  Tabs,
  TextLink,
  Icons,
  useToast,
} from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import { quoteFor, changePreview, type Holding, type PriceBook } from '@/lib/billing/pricing'
import { periodEnd, formatPeriodDate } from '@/lib/billing/period'
import { applyModuleChangesAction, type BillingChange } from './actions'

/**
 * The plan, and the controls that change it.
 *
 * ── WHY NOTHING SAVES ON A CLICK ────────────────────────────────────────────
 *
 * Toggling marks a change as PENDING; nothing is written until the customer
 * confirms. That is not caution for its own sake — upgrades bill from today and
 * downgrades only at period end, and a grid that wrote on every click would
 * give the customer nowhere to see that difference before agreeing to it.
 *
 * The confirm step states both consequences as separate sentences with separate
 * money, because netting them into one figure would misstate what happens on
 * the card this month.
 */

type SiteRow = { siteId: number; siteCode: string; displayName: string }

type Props = {
  accountName: string
  accountStatus: string
  billingContact: string | null
  billingEmail: string | null
  vatNumber: string | null
  billingDay: number
  nextBillingOn: string
  today: string
  sites: SiteRow[]
  hiddenStoreCount: number
  holdings: Holding[]
  prices: PriceBook
  devicesBySite: Record<number, number>
  moduleKeys: string[]
  moduleLabels: Record<string, string>
  moduleDescriptions: Record<string, string>
}

/** A toggle the customer has moved but not yet confirmed. */
type Pending = { siteId: number; moduleKey: string; want: boolean }

const VAT_PERCENT = 15

export default function BillingClient(props: Props) {
  const {
    accountName, accountStatus, billingContact, billingEmail, vatNumber,
    billingDay, nextBillingOn, today, sites, hiddenStoreCount,
    holdings, prices, devicesBySite, moduleKeys, moduleLabels, moduleDescriptions,
  } = props

  const [pending, setPending] = useState<Pending[]>([])
  const [view, setView] = useState<'by-module' | 'by-store'>('by-module')
  const [confirming, setConfirming] = useState(false)
  const [saving, startSaving] = useTransition()
  const toast = useToast()

  const optional = moduleKeys.filter((k) => k !== 'starter')

  /** Does this site hold this module right now (ignoring pending changes)? */
  const heldNow = useMemo(() => {
    const set = new Set<string>()
    for (const h of holdings) set.add(`${h.siteId}:${h.moduleKey}`)
    return set
  }, [holdings])

  /** module -> its end date, where one is scheduled. */
  const endingNow = useMemo(() => {
    const map = new Map<string, string>()
    for (const h of holdings) if (h.endsOn) map.set(`${h.siteId}:${h.moduleKey}`, h.endsOn)
    return map
  }, [holdings])

  const pendingFor = (siteId: number, moduleKey: string) =>
    pending.find((p) => p.siteId === siteId && p.moduleKey === moduleKey)

  /** What the toggle should show: the pending state if any, else the real one. */
  const isOn = (siteId: number, moduleKey: string) => {
    const p = pendingFor(siteId, moduleKey)
    if (p) return p.want
    return heldNow.has(`${siteId}:${moduleKey}`)
  }

  function toggle(siteId: number, moduleKey: string, want: boolean) {
    setPending((prev) => {
      const without = prev.filter((p) => !(p.siteId === siteId && p.moduleKey === moduleKey))
      const held = heldNow.has(`${siteId}:${moduleKey}`)
      const ending = endingNow.has(`${siteId}:${moduleKey}`)

      /* Toggling back to where it started is not a change — EXCEPT when the
         module is scheduled to end. Switching that one "on" cancels the
         removal, which is a real edit even though the switch looks unmoved. */
      if (want === held && !(want && ending)) return without
      return [...without, { siteId, moduleKey, want }]
    })
  }

  /** Turn a module on or off for every store at once. */
  function setAll(moduleKey: string, want: boolean) {
    for (const s of sites) toggle(s.siteId, moduleKey, want)
  }

  // ── Money ────────────────────────────────────────────────────────────────
  // The same pure function the server runs before writing, so the number the
  // customer agrees to is the number that gets stored.
  const quote = useMemo(
    () => quoteFor(holdings, devicesBySite, prices, VAT_PERCENT),
    [holdings, devicesBySite, prices],
  )

  const adding = pending.filter((p) => p.want).map((p) => ({ siteId: p.siteId, moduleKey: p.moduleKey }))
  const removing = pending.filter((p) => !p.want).map((p) => ({ siteId: p.siteId, moduleKey: p.moduleKey }))
  const preview = useMemo(
    () => changePreview(holdings, adding, removing, prices),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [holdings, prices, JSON.stringify(adding), JSON.stringify(removing)],
  )

  const scheduled = holdings.filter((h) => h.endsOn)
  const removalDate = periodEnd(today, billingDay)

  function save() {
    const changes: BillingChange[] = pending.map((p) => ({
      siteId: p.siteId,
      moduleKey: p.moduleKey,
      want: p.want,
    }))

    startSaving(async () => {
      const result = await applyModuleChangesAction(changes)
      if ('ok' in result && result.ok === false) {
        toast.error(result.error)
        return
      }
      setPending([])
      setConfirming(false)
      toast.success(
        changes.length === 1 ? 'Plan updated.' : `Plan updated — ${changes.length} changes.`,
      )
    })
  }

  const siteName = (siteId: number) =>
    sites.find((s) => s.siteId === siteId)?.displayName ?? `Store ${siteId}`

  return (
    <div className="flex flex-col gap-4">
      {accountStatus === 'suspended' ? (
        <Callout tone="danger" title="This account is suspended">
          Only the Starter Pack is active. Settle the account to restore the other modules.
        </Callout>
      ) : null}

      {/* ── What the account is ──────────────────────────────────────────── */}
      <Card>
        <CardHeader title={accountName} description="One account, one monthly bill, however many stores." />
        <CardBody className="flex flex-col gap-4">
          <StatStrip>
            <StatTile label="Stores on this account" value={String(sites.length + hiddenStoreCount)} />
            <StatTile label="This month" value={formatMoney(quote.total)} />
            <StatTile label="Next charged" value={formatPeriodDate(nextBillingOn)} />
            <StatTile
              label="Till licences"
              value={String(Object.values(devicesBySite).reduce((a, b) => a + b, 0))}
            />
          </StatStrip>

          {/* A definition grid rather than SummaryList: these are names and
              addresses, and SummaryList sets its values in tabular figures for
              money columns, which reads oddly on an email address. */}
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
            {billingContact ? (
              <>
                <dt className="text-muted">Billing contact</dt>
                <dd className="text-ink-2">{billingContact}</dd>
              </>
            ) : null}
            {billingEmail ? (
              <>
                <dt className="text-muted">Invoices go to</dt>
                <dd className="text-ink-2">{billingEmail}</dd>
              </>
            ) : null}
            {vatNumber ? (
              <>
                <dt className="text-muted">VAT number</dt>
                <dd className="numeric text-ink-2">{vatNumber}</dd>
              </>
            ) : null}
            <dt className="text-muted">Billing day</dt>
            <dd className="text-ink-2">The {ordinal(billingDay)} of each month</dd>
          </dl>

          {hiddenStoreCount > 0 ? (
            <p className="text-sm text-muted">
              {hiddenStoreCount} further {hiddenStoreCount === 1 ? 'store is' : 'stores are'} on
              this account that you do not have access to. {hiddenStoreCount === 1 ? 'It is' : 'They are'}{' '}
              included in the total above.
            </p>
          ) : null}
        </CardBody>
      </Card>

      {/* ── Anything already scheduled to end ────────────────────────────── */}
      {scheduled.length > 0 ? (
        <Callout tone="warning" title="Scheduled to end">
          <ul className="flex flex-col gap-1">
            {scheduled.map((h) => (
              <li key={`${h.siteId}:${h.moduleKey}`} className="text-sm">
                <span className="font-medium">{moduleLabels[h.moduleKey] ?? h.moduleKey}</span> at{' '}
                {siteName(h.siteId)} ends {formatPeriodDate(h.endsOn!)}. It keeps working until then.
              </li>
            ))}
          </ul>
        </Callout>
      ) : null}

      {/* ── The matrix ───────────────────────────────────────────────────────
          Two views of the same toggles. "By module" is the default because the
          question an owner arrives with is "should we take Loyalty", asked once
          across the group — not "what does Sandton have". */}
      <Tabs
        items={[
          { value: 'by-module', label: 'By module' },
          { value: 'by-store', label: 'By store', count: sites.length },
        ]}
        value={view}
        onChange={setView}
        aria-label="How to arrange the modules"
      />

      {view === 'by-module' ? (
              <div className="flex flex-col gap-3">
                {optional.map((key) => {
                  const onCount = sites.filter((s) => isOn(s.siteId, key)).length
                  return (
                    <Card key={key}>
                      <CardHeader
                        title={moduleLabels[key] ?? key}
                        description={moduleDescriptions[key]}
                        action={
                          <div className="flex items-center gap-2">
                            {prices[key] ? (
                              <span className="numeric text-sm text-muted">
                                {formatMoney(prices[key])}/store
                              </span>
                            ) : (
                              <Badge tone="warning">No price set</Badge>
                            )}
                            {/* A count only says something when there is more
                                than one store to count. */}
                            {sites.length > 1 ? (
                              <Badge tone={onCount ? 'success' : 'neutral'}>
                                {onCount} of {sites.length}
                              </Badge>
                            ) : null}
                          </div>
                        }
                      />
                      <CardBody className="flex flex-col gap-3">
                        {sites.length > 1 ? (
                          <>
                            <div className="flex gap-2">
                              <Button size="sm" variant="ghost" onClick={() => setAll(key, true)}>
                                Turn on for all stores
                              </Button>
                              <Button size="sm" variant="ghost" onClick={() => setAll(key, false)}>
                                Turn off for all stores
                              </Button>
                            </div>

                            <div className="flex flex-col gap-2">
                              {sites.map((s) => (
                                <ModuleToggle
                                  key={s.siteId}
                                  label={s.displayName}
                                  on={isOn(s.siteId, key)}
                                  changed={Boolean(pendingFor(s.siteId, key))}
                                  endsOn={endingNow.get(`${s.siteId}:${key}`) ?? null}
                                  onChange={(want) => toggle(s.siteId, key, want)}
                                />
                              ))}
                            </div>
                          </>
                        ) : (
                          /* One store: naming it under every module would repeat
                             the same word six times down the page for no
                             information. The toggle stands alone. */
                          <ModuleToggle
                            label={isOn(sites[0].siteId, key) ? 'Included in your plan' : 'Not in your plan'}
                            on={isOn(sites[0].siteId, key)}
                            changed={Boolean(pendingFor(sites[0].siteId, key))}
                            endsOn={endingNow.get(`${sites[0].siteId}:${key}`) ?? null}
                            onChange={(want) => toggle(sites[0].siteId, key, want)}
                          />
                        )}
                      </CardBody>
                    </Card>
                  )
                })}
              </div>
      ) : (
              <div className="flex flex-col gap-3">
                {sites.map((s) => (
                  <Card key={s.siteId}>
                    <CardHeader
                      title={s.displayName}
                      description={s.siteCode}
                      action={
                        <Badge tone="neutral">
                          {devicesBySite[s.siteId] ?? 0}{' '}
                          {(devicesBySite[s.siteId] ?? 0) === 1 ? 'till' : 'tills'}
                        </Badge>
                      }
                    />
                    <CardBody className="flex flex-col gap-2">
                      {optional.map((key) => (
                        <ModuleToggle
                          key={key}
                          label={moduleLabels[key] ?? key}
                          hint={prices[key] ? `${formatMoney(prices[key])}/mo` : 'No price set'}
                          on={isOn(s.siteId, key)}
                          changed={Boolean(pendingFor(s.siteId, key))}
                          endsOn={endingNow.get(`${s.siteId}:${key}`) ?? null}
                          onChange={(want) => toggle(s.siteId, key, want)}
                        />
                      ))}
                    </CardBody>
                  </Card>
                ))}
              </div>
      )}

      {/* ── Till licences: read-only, on purpose ─────────────────────────── */}
      <Card>
        <CardHeader
          title="Till licences"
          description="Billed per till. The number here is the same one that decides whether a till may trade, so it changes only when a licence is provisioned or retired."
        />
        <CardBody className="flex flex-col gap-2">
          {sites.map((s) => (
            <div
              key={s.siteId}
              className="flex items-center justify-between border-b border-border py-2 last:border-0"
            >
              <span className="text-sm text-ink-2">{s.displayName}</span>
              <div className="flex items-center gap-3">
                <span className="numeric text-sm text-ink">
                  {devicesBySite[s.siteId] ?? 0} × {formatMoney(prices.pos_device ?? 0)}
                </span>
                <TextLink href="/setup/terminals">Manage</TextLink>
              </div>
            </div>
          ))}
        </CardBody>
      </Card>

      {/* ── This month ───────────────────────────────────────────────────── */}
      <Card>
        <CardHeader title="This month" />
        <CardBody>
          <SummaryList>
            <SummaryRow label="Modules and licences" value={formatMoney(quote.subtotal)} />
            <SummaryRow label={`VAT at ${VAT_PERCENT}%`} value={formatMoney(quote.vat)} />
            <SummaryTotal label="Total" value={formatMoney(quote.total)} />
          </SummaryList>
          {quote.nextPeriodTotal !== quote.total ? (
            <p className="mt-2 text-sm text-muted">
              From {formatPeriodDate(nextBillingOn)} this becomes{' '}
              <span className="numeric">{formatMoney(quote.nextPeriodTotal)}</span>, once the
              scheduled changes above take effect.
            </p>
          ) : null}
        </CardBody>
      </Card>

      {/* ── The commit bar ───────────────────────────────────────────────── */}
      {pending.length > 0 ? (
        <div className="sticky bottom-4 z-10">
          <Card className="shadow-pop">
            <CardBody className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Icons.Info size={16} className="text-brand" />
                <span className="text-sm text-ink">
                  {pending.length} {pending.length === 1 ? 'change' : 'changes'} not yet applied
                </span>
              </div>
              <div className="flex gap-2">
                <Button variant="ghost" onClick={() => setPending([])} disabled={saving}>
                  Discard
                </Button>
                <Button variant="primary" onClick={() => setConfirming(true)} disabled={saving}>
                  Review and confirm
                </Button>
              </div>
            </CardBody>
          </Card>
        </div>
      ) : null}

      <Modal
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Confirm these changes"
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
                    {moduleLabels[a.moduleKey] ?? a.moduleKey} at {siteName(a.siteId)}
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
                    {moduleLabels[r.moduleKey] ?? r.moduleKey} at {siteName(r.siteId)}
                  </li>
                ))}
              </ul>
              <p className="numeric text-sm text-muted">
                −{formatMoney(preview.removedMonthly)} per month
              </p>
              {/* The single most important sentence on this screen. Without it a
                  customer reads the strike-through as "switched off now" and
                  calls to ask why they were charged. */}
              <p className="text-sm text-muted">
                These keep working until {formatPeriodDate(removalDate)} and are on this month’s
                bill.
              </p>
            </div>
          ) : null}
        </div>
      </Modal>
    </div>
  )
}

/** One module at one store. */
function ModuleToggle({
  label,
  hint,
  on,
  changed,
  endsOn,
  onChange,
}: {
  label: string
  hint?: string
  on: boolean
  changed: boolean
  endsOn: string | null
  onChange: (want: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border py-2 last:border-0">
      <div className="flex flex-col">
        <span className="text-sm text-ink-2">{label}</span>
        {hint ? <span className="numeric text-sm text-muted">{hint}</span> : null}
        {/* Three states, not two. A module scheduled to end is still ON, and
            showing it as off would tell the customer they had already lost it. */}
        {endsOn && !changed ? (
          <span className="text-sm text-warning-ink">Ends {formatPeriodDate(endsOn)}</span>
        ) : null}
      </div>
      <div className="flex items-center gap-2">
        {changed ? <Badge tone="brand">Not saved</Badge> : null}
        <Switch checked={on} onChange={onChange} ariaLabel={label} />
      </div>
    </div>
  )
}

function ordinal(n: number): string {
  if (n >= 11 && n <= 13) return `${n}th`
  const last = n % 10
  if (last === 1) return `${n}st`
  if (last === 2) return `${n}nd`
  if (last === 3) return `${n}rd`
  return `${n}th`
}
