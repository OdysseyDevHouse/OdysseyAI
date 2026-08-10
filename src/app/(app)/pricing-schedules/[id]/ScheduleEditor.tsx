'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Badge,
  Button,
  Callout,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  Checkbox,
  ConfirmModal,
  CurrencyInput,
  EmptyState,
  Field,
  Icons,
  Input,
  Modal,
  ToolbarSearch,
  useToast,
  TABLE,
  TABLE_HEAD_ROW,
  TABLE_NUMERIC,
  TABLE_TD,
  TABLE_TD_INPUT,
  TABLE_TH,
  TABLE_ROW,
} from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import {
  saveScheduleAction,
  setLinesAction,
  removeLineAction,
  clearLinesAction,
  seedFromCurrentAction,
  refreshOldPricesAction,
  armScheduleAction,
  disarmScheduleAction,
  applyNowAction,
  revertScheduleAction,
  deleteScheduleAction,
} from '../actions'
import type { Schedule, ScheduleLine } from '@/lib/site/priceSchedules'

/**
 * Building one price change.
 *
 * ── THE TABLE IS PIVOTED BY PRODUCT ──────────────────────────────────────
 *
 * A shop thinks "the burger goes to R95 retail and R80 wholesale" — one thought
 * about one product. Stored, those are two rows; shown as two rows they read as
 * two unrelated changes and the owner has to hold the pairing in their head
 * while scrolling. So the storage stays flat and the SCREEN pivots: one row per
 * product, one pair of columns per price type.
 *
 * Above three price types the pivot stops helping — the row gets too wide to
 * read — and the flat view is offered instead.
 */

const PAGE_SIZE = 100

type Structure = { id: number; name: string }

/** One product, with whatever this change does to it under each price type. */
type PivotRow = {
  productId: number
  code: string
  description: string
  byStructure: Map<number, ScheduleLine>
}

const pad = (n: number) => String(n).padStart(2, '0')

function splitMoment(value: string): { date: string; time: string } {
  if (!value) return { date: '', time: '' }
  const [date, time] = value.split('T')
  return { date: date ?? '', time: time ?? '' }
}

/**
 * "14 Aug 2026 at 06:00", read from the stored text.
 *
 * Never through `new Date(value)` — the string is local wall-clock text and
 * parsing it as a date is the timezone shift migration 057 exists to prevent.
 */
function momentLabel(value: string): string {
  if (!value) return ''
  const [date, time] = value.split('T')
  const [y, m, d] = date.split('-').map(Number)
  const shown = new Date(y, m - 1, d).toLocaleDateString('en-ZA', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })
  return `${shown} at ${time}`
}

export default function ScheduleEditor({
  schedule,
  structures,
  departments,
  staleCount,
}: {
  schedule: Schedule & { lines: ScheduleLine[] }
  structures: Structure[]
  departments: { id: number; name: string }[]
  staleCount: number
}) {
  const router = useRouter()
  const toast = useToast()
  const [busy, startTransition] = useTransition()

  const editable = schedule.status === 'draft'
  const armed = schedule.status === 'armed'
  const applied = schedule.status === 'applied'

  const [name, setName] = useState(schedule.name)
  const moment = splitMoment(schedule.effectiveAt)
  const [date, setDate] = useState(moment.date)
  const [time, setTime] = useState(moment.time)

  const [search, setSearch] = useState('')
  const [shown, setShown] = useState(PAGE_SIZE)
  const [seeding, setSeeding] = useState(false)
  const [confirmRevert, setConfirmRevert] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  /* Which price types this change actually touches. Not every active one — a
     change to Retail alone must not show an empty Wholesale column. */
  const usedStructures = useMemo(() => {
    const ids = new Set(schedule.lines.map((l) => l.priceStructureId))
    return structures.filter((s) => ids.has(s.id))
  }, [schedule.lines, structures])

  const pivoted = usedStructures.length > 0 && usedStructures.length <= 3

  const rows = useMemo(() => {
    const byProduct = new Map<number, PivotRow>()
    for (const line of schedule.lines) {
      let row = byProduct.get(line.productId)
      if (!row) {
        row = {
          productId: line.productId,
          code: line.code,
          description: line.description,
          byStructure: new Map(),
        }
        byProduct.set(line.productId, row)
      }
      row.byStructure.set(line.priceStructureId, line)
    }
    return [...byProduct.values()]
  }, [schedule.lines])

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase()
    if (!term) return rows
    return rows.filter(
      (r) =>
        r.description.toLowerCase().includes(term) || r.code.toLowerCase().includes(term),
    )
  }, [rows, search])

  const pageRows = useMemo(() => filtered.slice(0, shown), [filtered, shown])

  const changing = schedule.lines.filter(
    (l) => l.oldPriceIncl === null || l.oldPriceIncl !== l.newPriceIncl,
  ).length
  const unchanged = schedule.lines.length - changing

  /* ── Mutations ──────────────────────────────────────────────────────── */

  function run(action: () => Promise<{ ok: true; message: string } | { ok: false; error: string }>) {
    startTransition(async () => {
      const result = await action()
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(result.message)
      router.refresh()
    })
  }

  function saveHeader() {
    const at = date && time ? `${date}T${time}` : ''
    run(() => saveScheduleAction(schedule.id, { name: name.trim(), effectiveAt: at }))
  }

  function setPrice(line: ScheduleLine, value: number) {
    if (value === line.newPriceIncl) return
    run(() =>
      setLinesAction(schedule.id, [
        {
          productId: line.productId,
          priceStructureId: line.priceStructureId,
          newPriceIncl: value,
          origin: 'typed',
        },
      ]),
    )
  }

  /* ── Render ─────────────────────────────────────────────────────────── */

  return (
    <div className="flex flex-col gap-5">
      {/* ── When it happens ─────────────────────────────────────────── */}
      <Card>
        <CardHeader
          title="When these prices take effect"
          description="Tills apply the change on their own clock, to the minute — even with no network. The rest of the system follows within a few minutes."
        />
        <CardBody className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-4">
            <Field label="Name" className="min-w-56 flex-1">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                onBlur={saveHeader}
                disabled={!editable || busy}
              />
            </Field>
            <Field label="Date" className="w-44">
              <Input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                onBlur={saveHeader}
                disabled={!editable || busy}
              />
            </Field>
            <Field label="Time" className="w-32">
              <Input
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value)}
                onBlur={saveHeader}
                disabled={!editable || busy}
              />
            </Field>
          </div>

          {schedule.effectiveAt && !applied && (
            <Callout tone="brand" title="What will happen">
              These become the shop&rsquo;s prices on {momentLabel(schedule.effectiveAt)}. Every
              till switches at that minute on its own clock, with or without a network. Nobody
              needs to be here.
            </Callout>
          )}

          {applied && (
            <Callout tone="success" title="This change has happened">
              {schedule.appliedCount} price{schedule.appliedCount === 1 ? '' : 's'} changed
              {schedule.appliedAt
                ? ` on ${schedule.appliedAt.toLocaleDateString('en-ZA', { day: 'numeric', month: 'long' })}`
                : ''}
              . The list below is kept so the old prices can be put back.
            </Callout>
          )}

          {staleCount > 0 && editable && (
            <Callout tone="warning" title="Some of these have changed since">
              {staleCount} product{staleCount === 1 ? ' has' : 's have'} had a price changed by
              hand since this list was built. Applying this will overwrite those changes.
              <span className="mt-2 block">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => run(() => refreshOldPricesAction(schedule.id))}
                  disabled={busy}
                >
                  Bring the before-prices up to date
                </Button>
              </span>
            </Callout>
          )}

          {schedule.note && schedule.status === 'cancelled' && (
            <Callout tone="warning" title="This change did not run">
              {schedule.note}
            </Callout>
          )}
        </CardBody>
      </Card>

      {/* ── Building the list ───────────────────────────────────────── */}
      {editable && (
        <Card>
          <CardHeader
            title="Which prices are changing"
            description="Start from what you charge today and edit the ones you want, or add products one at a time."
          />
          <CardBody className="flex flex-wrap gap-3">
            <Button onClick={() => setSeeding(true)} disabled={busy}>
              <Icons.Copy size={15} />
              Start from my current prices
            </Button>
            {schedule.lines.length > 0 && (
              <Button
                variant="danger-ghost"
                onClick={() => run(() => clearLinesAction(schedule.id))}
                disabled={busy}
              >
                Clear the list
              </Button>
            )}
          </CardBody>
        </Card>
      )}

      {/* ── The prices ──────────────────────────────────────────────── */}
      <Card>
        <CardHeader
          title="The new prices"
          description={
            schedule.lines.length === 0
              ? undefined
              : `${changing} changing${unchanged > 0 ? `, ${unchanged} unchanged` : ''} across ${usedStructures.length} price type${usedStructures.length === 1 ? '' : 's'}`
          }
          action={
            schedule.lines.length > 0 ? (
              <ToolbarSearch
                value={search}
                onChange={(v) => {
                  setSearch(v)
                  setShown(PAGE_SIZE)
                }}
                placeholder="Find a product"
              />
            ) : undefined
          }
        />
        <CardBody>
          {schedule.lines.length === 0 ? (
            <EmptyState
              icon={<Icons.Tag size={22} />}
              title="No prices on this change yet"
              hint="Bring in the prices you charge today, then edit the ones that are going up or down."
              action={
                editable ? (
                  <Button onClick={() => setSeeding(true)}>Start from my current prices</Button>
                ) : undefined
              }
            />
          ) : filtered.length === 0 ? (
            <EmptyState
              icon={<Icons.Search size={22} />}
              title="Nothing matched"
              hint={`No product here matches “${search}”.`}
              action={<Button variant="secondary" onClick={() => setSearch('')}>Clear the search</Button>}
            />
          ) : (
            <div className="overflow-x-auto">
              <table className={TABLE}>
                <thead>
                  <tr className={TABLE_HEAD_ROW}>
                    <th className={TABLE_TH}>Code</th>
                    <th className={TABLE_TH}>Product</th>
                    {pivoted ? (
                      usedStructures.map((s) => (
                        <th key={s.id} className={`${TABLE_TH} ${TABLE_NUMERIC}`}>
                          {s.name}
                        </th>
                      ))
                    ) : (
                      <th className={TABLE_TH}>Price type</th>
                    )}
                    {!pivoted && <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>Now</th>}
                    {!pivoted && <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>New</th>}
                    <th className={TABLE_TH} />
                  </tr>
                </thead>
                <tbody>
                  {pivoted
                    ? pageRows.map((row) => (
                        <tr key={row.productId} className={TABLE_ROW}>
                          <td className={`${TABLE_TD} numeric text-muted`}>{row.code}</td>
                          <td className={TABLE_TD}>{row.description}</td>
                          {usedStructures.map((s) => {
                            const line = row.byStructure.get(s.id)
                            if (!line) {
                              return (
                                <td key={s.id} className={`${TABLE_TD} ${TABLE_NUMERIC} text-faint`}>
                                  —
                                </td>
                              )
                            }
                            return (
                              <td key={s.id} className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                                <PriceCell
                                  line={line}
                                  editable={editable}
                                  busy={busy}
                                  onCommit={(v) => setPrice(line, v)}
                                />
                              </td>
                            )
                          })}
                          <td className={TABLE_TD} />
                        </tr>
                      ))
                    : pageRows.flatMap((row) =>
                        [...row.byStructure.values()].map((line) => (
                          <tr key={line.id} className={TABLE_ROW}>
                            <td className={`${TABLE_TD} numeric text-muted`}>{row.code}</td>
                            <td className={TABLE_TD}>{row.description}</td>
                            <td className={TABLE_TD}>
                              <Badge tone="neutral">{line.structureName}</Badge>
                            </td>
                            <td className={`${TABLE_TD} ${TABLE_NUMERIC} text-muted`}>
                              {line.oldPriceIncl === null ? '—' : formatMoney(line.oldPriceIncl)}
                            </td>
                            <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                              <PriceCell
                                line={line}
                                editable={editable}
                                busy={busy}
                                onCommit={(v) => setPrice(line, v)}
                              />
                            </td>
                            <td className={TABLE_TD}>
                              {editable && (
                                <Button
                                  variant="danger-ghost"
                                  size="sm"
                                  iconOnly
                                  aria-label={`Remove ${row.description}`}
                                  onClick={() => run(() => removeLineAction(schedule.id, line.id))}
                                  disabled={busy}
                                >
                                  <Icons.Close size={14} />
                                </Button>
                              )}
                            </td>
                          </tr>
                        )),
                      )}
                </tbody>
              </table>
            </div>
          )}

          {/* Grown in place rather than paged. The kit's Pagination puts the page
              in the URL, which is right for a server-side list; this one is
              filtered in the browser, and a 40 000-line change is scrolled
              through looking for a product rather than navigated by page. */}
          {filtered.length > shown && (
            <div className="mt-4 flex items-center justify-center gap-3">
              <span className="text-sm text-muted">
                Showing {shown.toLocaleString('en-ZA')} of {filtered.length.toLocaleString('en-ZA')}
              </span>
              <Button variant="secondary" size="sm" onClick={() => setShown(shown + PAGE_SIZE)}>
                Show more
              </Button>
            </div>
          )}
        </CardBody>

        <CardFooter className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-sm text-muted">
            {changing === 0
              ? 'Nothing on this list changes a price yet.'
              : `${changing} price${changing === 1 ? '' : 's'} changing` +
                (schedule.effectiveAt ? ` · ${momentLabel(schedule.effectiveAt)}` : '')}
          </span>

          <span className="flex flex-wrap gap-2">
            {editable && (
              <Button
                variant="danger-ghost"
                onClick={() => setConfirmDelete(true)}
                disabled={busy}
              >
                Delete
              </Button>
            )}
            {armed && (
              <Button
                variant="secondary"
                onClick={() => run(() => disarmScheduleAction(schedule.id))}
                disabled={busy}
              >
                Unschedule
              </Button>
            )}
            {(editable || armed) && schedule.lines.length > 0 && (
              <Button
                variant="secondary"
                onClick={() => run(() => applyNowAction(schedule.id))}
                disabled={busy || editable}
                title={editable ? 'Schedule it first, or set a time and schedule it.' : undefined}
              >
                Apply now
              </Button>
            )}
            {editable && (
              <Button onClick={() => run(() => armScheduleAction(schedule.id))} disabled={busy}>
                Schedule this change
              </Button>
            )}
            {applied && (
              <Button variant="danger" onClick={() => setConfirmRevert(true)} disabled={busy}>
                Put these prices back
              </Button>
            )}
          </span>
        </CardFooter>
      </Card>

      <SeedModal
        open={seeding}
        onClose={() => setSeeding(false)}
        structures={structures}
        departments={departments}
        busy={busy}
        onSeed={(scope) => {
          setSeeding(false)
          run(() => seedFromCurrentAction(schedule.id, scope))
        }}
      />

      <ConfirmModal
        open={confirmRevert}
        onClose={() => setConfirmRevert(false)}
        title="Put these prices back?"
        confirmLabel="Put them back"
        tone="danger"
        busy={busy}
        message="Every price this change set goes back to what it was. Anything somebody has edited by hand since is left alone."
        onConfirm={() => {
          setConfirmRevert(false)
          run(() => revertScheduleAction(schedule.id))
        }}
      />

      <ConfirmModal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="Delete this price change?"
        confirmLabel="Delete"
        tone="danger"
        busy={busy}
        message="This has not happened yet, so nothing in the shop changes. The list of prices is discarded."
        onConfirm={() => {
          setConfirmDelete(false)
          startTransition(async () => {
            const result = await deleteScheduleAction(schedule.id)
            if (!result.ok) {
              toast.error(result.error)
              return
            }
            toast.success(result.message)
            router.push('/pricing-schedules')
          })
        }}
      />
    </div>
  )
}

/**
 * One editable price, with what it was and how far it moves.
 *
 * The difference is coloured because it is the thing being judged: a column of
 * plain numbers makes a 40% rise look exactly like a 2% one. Held locally while
 * typing and committed on blur, so every keystroke is not a round trip.
 */
function PriceCell({
  line,
  editable,
  busy,
  onCommit,
}: {
  line: ScheduleLine
  editable: boolean
  busy: boolean
  onCommit: (value: number) => void
}) {
  const [value, setValue] = useState(line.newPriceIncl)
  const old = line.oldPriceIncl
  const moved = old !== null && old !== 0 ? ((line.newPriceIncl - old) / old) * 100 : null

  if (!editable) {
    return (
      <span className="flex flex-col items-end">
        <span className="numeric text-sm text-ink">{formatMoney(line.newPriceIncl)}</span>
        {old !== null && old !== line.newPriceIncl && (
          <span className="numeric text-xs text-muted line-through">{formatMoney(old)}</span>
        )}
      </span>
    )
  }

  return (
    <span className="flex flex-col items-end gap-0.5">
      <CurrencyInput
        className={TABLE_TD_INPUT}
        value={value}
        onChange={(e) => setValue(Number(e.target.value.replace(',', '.')) || 0)}
        onBlur={() => onCommit(value)}
        disabled={busy}
      />
      <span className="flex items-center gap-1.5 text-xs">
        <span className="numeric text-muted">
          {old === null ? 'was nothing' : `was ${formatMoney(old)}`}
        </span>
        {moved !== null && Math.abs(moved) >= 0.05 && (
          <span className={`numeric ${moved > 0 ? 'text-success' : 'text-danger'}`}>
            {moved > 0 ? '+' : ''}
            {moved.toFixed(1)}%
          </span>
        )}
      </span>
    </span>
  )
}

/**
 * "Take the menu I have and give it new pricing" — the primary way in.
 *
 * Copies every current price in scope onto the change with new = old, so the
 * owner edits a list that already reads like their menu. Untouched lines are
 * dropped when it is scheduled, so bringing in the whole shop and changing four
 * things schedules four changes.
 */
function SeedModal({
  open,
  onClose,
  structures,
  departments,
  busy,
  onSeed,
}: {
  open: boolean
  onClose: () => void
  structures: Structure[]
  departments: { id: number; name: string }[]
  busy: boolean
  onSeed: (scope: {
    priceStructureIds: number[]
    departmentIds?: number[]
    includeArchived?: boolean
  }) => void
}) {
  /* Defaults to the first price type rather than none: a shop with one price
     type should be able to press Bring them in without choosing anything. */
  const [picked, setPicked] = useState<number[]>(() =>
    structures.length > 0 ? [structures[0].id] : [],
  )
  const [depts, setDepts] = useState<number[]>([])

  const toggle = (list: number[], id: number) =>
    list.includes(id) ? list.filter((x) => x !== id) : [...list, id]

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Start from my current prices"
      description="Brings today's prices in so you can edit the ones that are changing."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={() =>
              onSeed({
                priceStructureIds: picked,
                departmentIds: depts.length > 0 ? depts : undefined,
              })
            }
            disabled={busy || picked.length === 0}
          >
            Bring them in
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <Field
          label="Which price types"
          hint="Pick more than one to move them together in a single change."
        >
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            {structures.map((s) => (
              <Checkbox
                key={s.id}
                checked={picked.includes(s.id)}
                onChange={() => setPicked(toggle(picked, s.id))}
                label={s.name}
              />
            ))}
          </div>
        </Field>

        <Field
          label="Which departments"
          hint="Leave all unticked for the whole shop."
        >
          <div className="flex max-h-48 flex-col gap-2 overflow-y-auto">
            {departments.map((d) => (
              <Checkbox
                key={d.id}
                checked={depts.includes(d.id)}
                onChange={() => setDepts(toggle(depts, d.id))}
                label={d.name}
              />
            ))}
          </div>
        </Field>
      </div>
    </Modal>
  )
}
