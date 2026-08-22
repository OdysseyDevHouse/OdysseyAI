'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Badge,
  Button,
  Checkbox,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Icons,
  Modal,
  SegmentedControl,
  Switch,
  useToast,
} from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import {
  SHAPE_LABEL,
  AUDIENCE_LABEL,
  specialActiveAt,
  type Special,
  type SpecialInput,
  // The pure engine, NOT lib/site/specials — importing the server module from
  // a client component pulls mysql2 (and `tls`) into the browser bundle.
} from '@/lib/specialsEngine'

import {
  deleteSpecialAction,
  fanoutSpecialAction,
  reorderSpecialsAction,
  setSpecialActiveAction,
} from './actions'
import SpecialForm, {
  type CustomerGroupOption,
  type DepartmentOption,
  type FormRow,
} from './SpecialForm'
import type { ResolvedItem, SpecialWithUse } from '@/lib/site/specials'
import type { FanoutOutcome } from '@/lib/site/specialFanout'

/**
 * The shop's promotions, in the order they fire.
 *
 * ── THE ORDER IS THE FEATURE ─────────────────────────────────────────────
 *
 * Only one special applies to a product. Which one is decided by this list,
 * top down — so the arrows are not a display preference, they are how a shop
 * says "the three-for-two beats the ten percent". The header says so, because
 * a list that silently decided that would be baffling.
 */

type Status = 'running' | 'scheduled' | 'ended' | 'off'
type Filter = 'all' | Status

/**
 * What a shop sees at a glance.
 *
 * Deliberately NOT the same as `specialActiveAt`. A special that is switched
 * on and inside its dates but outside today's hours is "scheduled" — it is
 * waiting for its next window, not off and not broken.
 */
function statusOf(special: Special, now: Date): Status {
  if (!special.isActive) return 'off'
  if (special.endsAt < stamp(now)) return 'ended'
  if (special.startsAt > stamp(now)) return 'scheduled'
  return specialActiveAt(special, now) ? 'running' : 'scheduled'
}

const pad = (n: number) => String(n).padStart(2, '0')
const stamp = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`

const STATUS_TONE = {
  running: 'success',
  scheduled: 'brand',
  ended: 'neutral',
  off: 'neutral',
} as const

const STATUS_LABEL = {
  running: 'Running now',
  scheduled: 'Scheduled',
  ended: 'Ended',
  off: 'Off',
} as const

/** What kind it is — the shape's own name, not the group it is filed under. */
function typeLabel(s: Special): string {
  return SHAPE_LABEL[s.shape]
}

/** A one-line summary of what the customer actually gets. */
function dealSummary(s: Special): string {
  switch (s.shape) {
    case 'happy_hour':
      // No scope at all IS the whole store — see 210 on why the separate
      // applies_to_all flag went.
      return s.items.some((i) => i.role === 'scope')
        ? `${s.discountPct}% off ${countScope(s)}`
        : `${s.discountPct}% off everything`
    case 'special_price':
      return `Marked-down price on ${countScope(s)}`
    case 'cheapest_free':
      return s.discountPct > 0 && s.discountPct < 100
        ? `Buy ${s.triggerQty}, cheapest at ${s.discountPct}% off`
        : `Buy ${s.triggerQty}, cheapest free`
    case 'free_item':
      return `Buy ${countRole(s, 'trigger')}, get ${countRole(s, 'reward')} free`
    case 'percent_off':
      return `${s.discountPct}% off when you buy ${countRole(s, 'trigger')}`
    case 'bundle_price':
      return `${countRole(s, 'trigger')} for ${formatMoney(s.bundlePriceIncl)}`
    case 'multibuy':
      return s.tiers.length === 1
        ? `${s.tiers[0].qty} for ${formatMoney(s.tiers[0].priceIncl)}`
        : `${s.tiers.length} quantity tiers on ${countRole(s, 'trigger')}`
    case 'spend':
      return s.discountPct > 0
        ? `Spend ${formatMoney(s.spendAmountIncl)}, get ${s.discountPct}% off`
        : `Spend ${formatMoney(s.spendAmountIncl)}, get something free`
    case 'bonus_points':
      return `${s.pointsMultiplier ?? 1}x loyalty points`
    case 'quantity_break': {
      const smallest = [...s.tiers].sort((a, b) => a.qty - b.qty)[0]
      return smallest
        ? `${smallest.qty}+ at ${smallest.discountPct}% off${s.tiers.length > 1 ? `, ${s.tiers.length} breaks` : ''}`
        : 'Quantity breaks'
    }
    case 'second_at_pct':
      return s.discountPct >= 100
        ? 'Buy one, get one free'
        : `Second one at ${s.discountPct}% off`
    case 'mix_and_match':
      return `Any ${s.triggerQty} for ${formatMoney(s.bundlePriceIncl)}`
    case 'free_delivery':
      return `Free delivery over ${formatMoney(s.spendAmountIncl)}`
  }
}

const countScope = (s: Special) => {
  const n = s.items.filter((i) => i.role === 'scope').length
  return n === 1 ? '1 product' : `${n} products`
}
const countRole = (s: Special, role: 'trigger' | 'reward') => {
  const n = s.items.filter((i) => i.role === role).length
  return n === 1 ? '1 product' : `${n} products`
}

/** "7 Aug → 14 Aug", with the time only when it isn't a whole day. */
function windowLabel(s: Special): string {
  const show = (value: string) => {
    const [date, time] = value.split('T')
    const [y, m, d] = date.split('-').map(Number)
    const shown = new Date(y, m - 1, d).toLocaleDateString('en-ZA', {
      day: 'numeric',
      month: 'short',
    })
    return time === '00:00' || time === '23:59' ? shown : `${shown} ${time}`
  }
  return `${show(s.startsAt)} → ${show(s.endsAt)}`
}

const DAY_LETTERS = ['M', 'T', 'W', 'T', 'F', 'S', 'S']

export default function SpecialsList({
  specials,
  items,
  departments,
  customerGroups,
  stores,
}: {
  specials: SpecialWithUse[]
  /** Every special's items, already resolved to names and prices. */
  items: ResolvedItem[]
  departments: DepartmentOption[]
  customerGroups: CustomerGroupOption[]
  /** The other stores in the group. Empty for a shop that is in none. */
  stores: { siteId: number; name: string }[]
}) {
  const router = useRouter()
  const toast = useToast()
  const [busy, start] = useTransition()
  /*
   * A local copy ONLY so the reorder arrows move a row instantly rather than
   * after a round trip. Everything else — adding, editing, deleting — comes
   * from the server, so `pending` is cleared whenever the server sends a new
   * list. Without that, `useState(specials)` seeds once and a newly saved
   * special never appears: the toast says "saved" over an empty list.
   */
  const [pending, setPending] = useState<SpecialWithUse[] | null>(null)
  const [lastServer, setLastServer] = useState(specials)
  if (lastServer !== specials) {
    setLastServer(specials)
    setPending(null)
  }
  const rows = pending ?? specials
  const setRows = setPending
  const [filter, setFilter] = useState<Filter>('all')
  const [editing, setEditing] = useState<SpecialInput | null>(null)
  /*
   * Which special's rows the form is holding. Kept beside  rather
   * than derived from it, because a NEW special has no id to look items up by.
   */
  const [editingRows, setEditingRows] = useState<FormRow[]>([])
  /** The special whose push dialog is open. */
  const [pushing, setPushing] = useState<SpecialWithUse | null>(null)

  // Re-derived on every render rather than held in state, so a special that
  // starts while someone is looking at the list flips on its own.
  const now = new Date()
  const counts = useMemo(() => {
    const out: Record<Filter, number> = { all: rows.length, running: 0, scheduled: 0, ended: 0, off: 0 }
    for (const s of rows) out[statusOf(s, now)]++
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows])

  const visible = filter === 'all' ? rows : rows.filter((s) => statusOf(s, now) === filter)

  /* A new special starts with no items; an existing one loads its own. */
  function openNew() {
    setEditing(blankSpecial())
    setEditingRows([])
  }

  /**
   * The same special again, as a new one.
   *
   * ── WHY THIS IS WORTH A BUTTON ───────────────────────────────────────────
   *
   * Next month's version of last month's promotion is the same dozen products,
   * the same discount, the same days — and a different fortnight. Without this
   * that is retyped from scratch every time, and the retyping is where a
   * product gets left out.
   *
   * Purely client-side: the form opens on a copy with no id, so nothing exists
   * until Create is pressed. Someone who duplicates by accident closes the
   * dialog and has changed nothing.
   *
   * The COUNTER does not come with it. A copy has been redeemed zero times
   * whatever its original has done — carrying that across would start a fresh
   * promotion already half spent.
   */
  function openCopy(special: SpecialWithUse) {
    openEdit(special)
    setEditing({
      ...toInput(special),
      id: null,
      name: `${special.name} (copy)`.slice(0, 100),
      /*
       * Switched OFF, deliberately.
       *
       * A duplicate opens on the original's dates, which have very likely
       * passed — and a copy that arrives live is a promotion nobody decided to
       * run. Whoever is copying it is about to change the window anyway, and
       * this way the decision to start it is theirs.
       */
      isActive: false,
    })
  }

  function openEdit(special: SpecialWithUse) {
    setEditing(toInput(special))
    setEditingRows(
      items
        .filter((i) => i.specialId === special.id)
        .map((i) => ({
          role: i.role,
          productId: i.productId,
          departmentId: i.departmentId,
          qty: i.qty,
          priceIncl: i.priceIncl,
          label: i.label,
          currentPrice: i.currentPrice,
          priceText: i.priceIncl > 0 ? String(i.priceIncl) : '',
          pctText:
            i.currentPrice && i.currentPrice > 0 && i.priceIncl > 0 && i.priceIncl < i.currentPrice
              ? String(Math.round((1 - i.priceIncl / i.currentPrice) * 10000) / 100)
              : '',
        })),
    )
  }

  function nudge(index: number, delta: -1 | 1) {
    const to = index + delta
    if (to < 0 || to >= rows.length) return
    const next = [...rows]
    ;[next[index], next[to]] = [next[to], next[index]]
    setRows(next)
    start(async () => {
      const result = await reorderSpecialsAction(next.map((s) => s.id))
      if (!result.ok) {
        toast.error(result.error)
        setRows(specials)
      }
      router.refresh()
    })
  }

  function toggle(special: Special, active: boolean) {
    start(async () => {
      const result = await setSpecialActiveAction(special.id, active, special.name)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      router.refresh()
    })
  }

  function remove(special: Special) {
    start(async () => {
      const result = await deleteSpecialAction(special.id, special.name)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(`“${special.name}” deleted.`)
      router.refresh()
    })
  }

  return (
    <>
      <Card>
        <CardHeader
          title="Specials"
          description="Discounts and deals the till and your online shop apply by themselves while their window is open. Only one special applies to a product — the one higher in this list wins."
          action={
            <Button onClick={() => openNew()} disabled={busy}>
              <Icons.Plus size={15} />
              Add a special
            </Button>
          }
        />
        <CardBody className="flex flex-col gap-4">
          <SegmentedControl
            value={filter}
            onChange={(v) => setFilter(v as Filter)}
            options={[
              { value: 'all', label: `All (${counts.all})` },
              { value: 'running', label: `Running now (${counts.running})` },
              { value: 'scheduled', label: `Scheduled (${counts.scheduled})` },
              { value: 'ended', label: `Ended (${counts.ended})` },
              { value: 'off', label: `Off (${counts.off})` },
            ]}
          />

          {visible.length === 0 ? (
            <EmptyState
              icon={<Icons.Tag size={22} />}
              title={filter === 'all' ? 'No specials yet' : 'Nothing here'}
              hint={
                filter === 'all'
                  ? 'Set one up and the till will start applying it the moment its window opens.'
                  : 'Try another filter to see the rest.'
              }
              action={
                filter === 'all' ? (
                  <Button onClick={() => openNew()}>Add a special</Button>
                ) : undefined
              }
            />
          ) : (
            <ul className="flex flex-col gap-2">
              {visible.map((special) => {
                const index = rows.findIndex((s) => s.id === special.id)
                const status = statusOf(special, now)
                return (
                  <li
                    key={special.id}
                    className="flex flex-wrap items-center gap-3 rounded-card border border-border bg-surface px-3 py-2.5"
                  >
                    {/* Reordering only makes sense against the whole list —
                        moving a row "up" inside a filter would move it past
                        rows nobody can see. */}
                    <span className="flex flex-col">
                      <Button
                        variant="ghost"
                        size="sm"
                        iconOnly
                        aria-label={`Move ${special.name} earlier`}
                        disabled={filter !== 'all' || index === 0 || busy}
                        onClick={() => nudge(index, -1)}
                      >
                        <Icons.ChevronUp size={14} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        iconOnly
                        aria-label={`Move ${special.name} later`}
                        disabled={filter !== 'all' || index === rows.length - 1 || busy}
                        onClick={() => nudge(index, 1)}
                      >
                        <Icons.ChevronDown size={14} />
                      </Button>
                    </span>

                    <span className="numeric w-6 shrink-0 text-right text-sm text-muted">
                      {index + 1}
                    </span>

                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium text-ink">{special.name}</span>
                        <Badge tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Badge>
                      </span>
                      <span className="mt-0.5 block text-xs text-muted">
                        {typeLabel(special)} · {dealSummary(special)}
                      </span>
                      <span className="mt-0.5 flex flex-wrap items-center gap-x-3 text-xs text-muted">
                        <span>{windowLabel(special)}</span>
                        {special.dailyStart && special.dailyEnd && (
                          <span>
                            {special.dailyStart}–{special.dailyEnd}
                          </span>
                        )}
                        {special.daysOfWeek !== '1111111' && (
                          <span className="tracking-widest">
                            {DAY_LETTERS.map((letter, i) => (
                              <span
                                key={i}
                                className={special.daysOfWeek[i] === '1' ? 'text-ink-2' : 'text-faint'}
                              >
                                {letter}
                              </span>
                            ))}
                          </span>
                        )}
                        {/* Only when they are NOT the default. A row saying
                            "Everyone, both channels, no limit" on every
                            promotion is noise that hides the one that is
                            actually restricted. */}
                        {special.audience && special.audience !== 'everyone' && (
                          <span>{AUDIENCE_LABEL[special.audience]} only</span>
                        )}
                        {special.runsInStore === false && <span>Online only</span>}
                        {special.runsOnline === false && <span>In store only</span>}
                        {special.maxRedemptions !== null && (
                          <span>
                            {special.redemptionsCount}/{special.maxRedemptions} used
                          </span>
                        )}
                        {/*
                          A promotion that has been running and has never been
                          used. Almost always means it is shadowed by one above
                          it, or that its products never sell together — and
                          either way it is invisible without being told.

                          Only once it is genuinely RUNNING: a scheduled or
                          switched-off special has had no chance yet, and saying
                          "never used" of one would be alarming and wrong.
                        */}
                        {status === 'running' && special.redemptionsCount === 0 && (
                          <span className="text-warning">Not used yet</span>
                        )}
                      </span>
                    </span>

                    <Switch
                      checked={special.isActive}
                      onChange={(next) => toggle(special, next)}
                      ariaLabel={`${special.name} in use`}
                    />

                    <span className="flex shrink-0 items-center gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        iconOnly
                        aria-label={`Edit ${special.name}`}
                        disabled={busy}
                        onClick={() => openEdit(special)}
                      >
                        <Icons.Pencil size={15} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        iconOnly
                        aria-label={`Duplicate ${special.name}`}
                        title="Duplicate"
                        disabled={busy}
                        onClick={() => openCopy(special)}
                      >
                        <Icons.Copy size={15} />
                      </Button>
                      {/* Only for a shop that is actually in a group. A button
                          that opens a dialog listing no stores is a button
                          promising something the shop does not have. */}
                      {stores.length > 0 && (
                        <Button
                          variant="ghost"
                          size="sm"
                          iconOnly
                          aria-label={`Push ${special.name} to other stores`}
                          title="Push to other stores"
                          disabled={busy}
                          onClick={() => setPushing(special)}
                        >
                          <Icons.Send size={15} />
                        </Button>
                      )}
                      <Button
                        variant="danger-ghost"
                        size="sm"
                        iconOnly
                        aria-label={`Delete ${special.name}`}
                        disabled={busy}
                        onClick={() => remove(special)}
                      >
                        <Icons.Trash size={15} />
                      </Button>
                    </span>
                  </li>
                )
              })}
            </ul>
          )}
        </CardBody>
      </Card>

      {editing && (
        <SpecialForm
          value={editing}
          rows={editingRows}
          departments={departments}
          customerGroups={customerGroups}
          others={rows}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            router.refresh()
          }}
        />
      )}

      {pushing && (
        <PushToStores
          special={pushing}
          stores={stores}
          onClose={() => setPushing(null)}
          onDone={() => {
            setPushing(null)
            router.refresh()
          }}
        />
      )}
    </>
  )
}

function toInput(s: SpecialWithUse): SpecialInput {
  return {
    id: s.id,
    name: s.name,
    shape: s.shape,
    isActive: s.isActive,
    startsAt: s.startsAt,
    endsAt: s.endsAt,
    dailyStart: s.dailyStart,
    dailyEnd: s.dailyEnd,
    daysOfWeek: s.daysOfWeek,
    discountPct: s.discountPct,
    /* Carried through, or editing anything about a special would silently
       clear the limits someone set on it — a partial save that wipes its
       siblings is exactly the shape of bug this file has produced before. */
    guards: s.guards ? { ...s.guards } : undefined,
    maxRedemptions: s.maxRedemptions,
    audience: s.audience,
    audienceGroupId: s.audienceGroupId,
    runsInStore: s.runsInStore,
    runsOnline: s.runsOnline,
    pointsMultiplier: s.pointsMultiplier,
    rewardPerDeal: s.rewardPerDeal,
    triggerQty: s.triggerQty,
    bundlePriceIncl: s.bundlePriceIncl,
    spendAmountIncl: s.spendAmountIncl,
    items: s.items.map((i) => ({ ...i })),
    tiers: s.tiers.map((t) => ({ ...t })),
  }
}

function blankSpecial(): SpecialInput {
  const today = new Date()
  const inAWeek = new Date(today.getTime() + 7 * 86400000)
  const day = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  return {
    id: null,
    name: '',
    shape: 'happy_hour',
    isActive: true,
    // Today through next week, all day: the common case, and every part of it
    // is visible and changeable rather than hidden behind a default.
    startsAt: `${day(today)}T00:00`,
    endsAt: `${day(inAWeek)}T23:59`,
    dailyStart: '',
    dailyEnd: '',
    daysOfWeek: '1111111',
    discountPct: 10,
    triggerQty: 3,
    bundlePriceIncl: 0,
    spendAmountIncl: 0,
    items: [],
    tiers: [],
  }
}

/* ── Pushing one promotion to the rest of the group ──────────────────────── */

/**
 * Copy this special into the other stores.
 *
 * ── IT COPIES, AND THE DIALOG SAYS SO ────────────────────────────────────
 *
 * Each store gets its own row, which it can then switch off or re-time without
 * phoning head office. That is the right behaviour and a surprising one if
 * nobody says it, so the dialog does — along with the two things that cannot
 * travel: a customer group (ids are per store) and a redemption count.
 *
 * ── AND IT REPORTS PER STORE ─────────────────────────────────────────────
 *
 * No transaction spans two databases, so this is never all-or-nothing. Nineteen
 * stores taking it and one being asleep IS the answer, and the outcomes stay on
 * screen afterwards — including which products a store does not stock, because
 * a promotion covering four products here and three there is exactly what
 * nobody finds until a customer argues about a price.
 */
function PushToStores({
  special,
  stores,
  onClose,
  onDone,
}: {
  special: SpecialWithUse
  stores: { siteId: number; name: string }[]
  onClose: () => void
  onDone: () => void
}) {
  const toast = useToast()
  const [busy, start] = useTransition()
  const [chosen, setChosen] = useState<Set<number>>(new Set(stores.map((s) => s.siteId)))
  const [outcomes, setOutcomes] = useState<FanoutOutcome[] | null>(null)

  const toggle = (siteId: number) => {
    const next = new Set(chosen)
    if (next.has(siteId)) next.delete(siteId)
    else next.add(siteId)
    setChosen(next)
  }

  const caveat =
    special.audience === 'group'
      ? 'This promotion is aimed at one customer group. Customer groups are per store, so the copies will apply to everyone until each branch narrows them.'
      : special.maxRedemptions !== null
        ? `Each store keeps its own count, so a limit of ${special.maxRedemptions} means ${special.maxRedemptions} at every store rather than ${special.maxRedemptions} across the group.`
        : null

  function push() {
    start(async () => {
      const result = await fanoutSpecialAction(special.id, [...chosen])
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      setOutcomes(result.outcomes)
      const worked = result.outcomes.filter((o) => o.ok).length
      if (worked === result.outcomes.length) {
        toast.success(`Pushed to ${worked} store${worked === 1 ? '' : 's'}.`)
      } else {
        toast.error(`${worked} of ${result.outcomes.length} stores took it — see below.`)
      }
    })
  }

  return (
    <Modal
      open
      onClose={busy ? () => {} : outcomes ? onDone : onClose}
      title="Push to other stores"
      description={`Copy “${special.name}” into the other stores in your group.`}
      size="lg"
      footer={
        outcomes ? (
          <Button onClick={onDone}>Done</Button>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={push} disabled={busy || chosen.size === 0}>
              <Icons.Send size={15} />
              {busy
                ? 'Pushing…'
                : `Push to ${chosen.size} store${chosen.size === 1 ? '' : 's'}`}
            </Button>
          </>
        )
      }
    >
      <div className="flex flex-col gap-3">
        {outcomes ? (
          <ul className="flex flex-col gap-2">
            {outcomes.map((o) => (
              <li
                key={o.siteId}
                className="flex flex-wrap items-center gap-2 rounded-control border border-border bg-surface px-3 py-2 text-sm"
              >
                <Badge tone={o.ok ? 'success' : 'danger'}>{o.ok ? o.detail : 'failed'}</Badge>
                <span className="text-ink">{o.storeName}</span>
                {!o.ok && <span className="text-muted">{o.detail}</span>}
                {o.skipped.length > 0 && (
                  <span className="text-warning">
                    {o.skipped.length} not stocked there: {o.skipped.slice(0, 4).join(', ')}
                    {o.skipped.length > 4 ? '…' : ''}
                  </span>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <>
            <p className="text-sm text-muted">
              Each store gets its own copy, which it can switch off or re-time on its own.
              Pushing again updates the copies rather than making new ones.
            </p>
            {caveat && (
              <p className="rounded-control bg-warning-soft px-3 py-2 text-xs text-warning">
                <Icons.Info size={14} className="mr-1.5 inline align-text-bottom" />
                {caveat}
              </p>
            )}
            <div className="flex flex-col gap-1.5">
              {stores.map((s) => (
                <Checkbox
                  key={s.siteId}
                  checked={chosen.has(s.siteId)}
                  label={s.name}
                  onChange={() => toggle(s.siteId)}
                />
              ))}
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}
