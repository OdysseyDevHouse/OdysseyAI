'use client'

import { useCallback, useMemo, useState, useTransition } from 'react'
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
  FieldGroup,
  Icons,
  Input,
  Modal,
  NumberInput,
  Select,
  ToolbarSearch,
  TreeSelect,
  departmentTreeOptions,
  useFieldErrors,
  useToast,
  TABLE,
  TABLE_HEAD_ROW,
  TABLE_NUMERIC,
  TABLE_TD,
  TABLE_TH,
  TABLE_ROW,
} from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import type { FieldProblems } from '@/lib/fieldErrors'
import {
  applyBulkChange,
  type BulkPriceChange,
  type RepriceRounding,
} from '@/lib/repricing'
import {
  saveScheduleAction,
  setLinesAction,
  bulkAdjustLinesAction,
  removeLineAction,
  clearLinesAction,
  seedFromCurrentAction,
  refreshOldPricesAction,
  armScheduleAction,
  disarmScheduleAction,
  applyNowAction,
  revertScheduleAction,
  deleteScheduleAction,
  duplicateScheduleAction,
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

/**
 * How many rows are on screen before "show more".
 *
 * Fifty rather than a page-ful: a whole-catalogue change is tens of thousands of
 * lines, and nobody reads it top to bottom — they search for the product they
 * came to change. The search box above is the real way through this table, so
 * the list only has to be long enough to browse a menu-sized change in one go.
 */
const PAGE_SIZE = 50

type Structure = { id: number; name: string }

/**
 * A department as this screen needs it: its name, and what it sits under.
 *
 * `parentId` rather than a nested shape because that is how the table stores it
 * and how every other picker in the app receives it — nesting it on the server
 * would mean un-nesting it again here to answer "is this covered by that".
 */
type DepartmentNode = {
  id: number
  parentId: number | null
  name: string
  /**
   * The tile's stored colour token and picture, carried so this screen's
   * pickers draw a department exactly as the products list and the till draw
   * it. Both render fine when absent — a grey tile with a tag on it — which is
   * why they are required rather than optional: a call site that forgot to map
   * them would look merely plain, and nobody would ever find it.
   */
  color: string | null
  imageId: number | null
}

/**
 * The tree in reading order, each row carrying how deep it sits.
 *
 * A department whose parent is not in the list is treated as top level rather
 * than dropped: it is a real department with real products, and hiding it
 * because of a missing row above it would silently shrink the scope somebody
 * thought they had chosen.
 */
function flattenDepartments(
  all: readonly DepartmentNode[],
): { department: DepartmentNode; depth: number }[] {
  const present = new Set(all.map((d) => d.id))
  const byParent = new Map<number | null, DepartmentNode[]>()
  for (const d of all) {
    const parent = d.parentId !== null && present.has(d.parentId) ? d.parentId : null
    const bucket = byParent.get(parent)
    if (bucket) bucket.push(d)
    else byParent.set(parent, [d])
  }

  const out: { department: DepartmentNode; depth: number }[] = []
  /* Iterative with a seen set rather than recursive: the parent column is a
     self-reference, and a cycle in it would blow the stack on a screen whose
     only job is to list some names. */
  const seen = new Set<number>()
  const walk = (parent: number | null, depth: number) => {
    for (const d of byParent.get(parent) ?? []) {
      if (seen.has(d.id)) continue
      seen.add(d.id)
      out.push({ department: d, depth })
      walk(d.id, depth + 1)
    }
  }
  walk(null, 0)
  return out
}

/** One product, with whatever this change does to it under each price type. */
type PivotRow = {
  productId: number
  code: string
  description: string
  departmentId: number | null
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
  departments: DepartmentNode[]
  staleCount: number
}) {
  const router = useRouter()
  const toast = useToast()
  const [busy, startTransition] = useTransition()

  const editable = schedule.status === 'draft'
  const armed = schedule.status === 'armed'
  const applied = schedule.status === 'applied'

  const errors = useFieldErrors()

  const [name, setName] = useState(schedule.name)
  const moment = splitMoment(schedule.effectiveAt)
  const [date, setDate] = useState(moment.date)
  const [time, setTime] = useState(moment.time)

  const [search, setSearch] = useState('')
  /* A LIST, because the picker is the multi-select one the products list uses:
     "show me Bakery and Drinks" is one filter, not two visits. Empty is the
     filter being off — the same thing "All departments" says there. */
  const [departmentFilter, setDepartmentFilter] = useState<number[]>([])
  const [onlyChanging, setOnlyChanging] = useState(false)
  const [shown, setShown] = useState(PAGE_SIZE)
  const [seeding, setSeeding] = useState(false)
  const [bulking, setBulking] = useState(false)
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
          departmentId: line.departmentId,
          byStructure: new Map(),
        }
        byProduct.set(line.productId, row)
      }
      row.byStructure.set(line.priceStructureId, line)
    }
    return [...byProduct.values()]
  }, [schedule.lines])

  /**
   * The departments this change actually touches, in the shop's own order.
   *
   * Built from the LINES rather than from every department the shop has: a
   * change covering three of forty must not offer the other thirty-seven, each
   * of which can only ever empty the table.
   */
  const usedDepartments = useMemo(() => {
    /*
     * A product is filed on the DEEPEST department it belongs to, so counting
     * only the ids the lines carry lists nothing but leaves: a shop with
     * "Drinks › Beer" and "Drinks › Wine" got two entries and no way to say
     * "all of Drinks" — which on a thousand-line change is the filter somebody
     * actually wants. So each line counts toward its own department AND every
     * ancestor above it, and picking a parent takes the branch.
     */
    const byId = new Map(departments.map((d) => [d.id, d]))
    const counts = new Map<number, number>()
    for (const row of rows) {
      if (row.departmentId === null) continue
      const seen = new Set<number>()
      let current: number | null = row.departmentId
      while (current !== null && !seen.has(current)) {
        seen.add(current)
        counts.set(current, (counts.get(current) ?? 0) + 1)
        current = byId.get(current)?.parentId ?? null
      }
    }
    /* Depth-first rather than in the flat order the page was handed, so the
       dropdown reads as the tree it is — a parent immediately above its own
       children — instead of listing "Beer" eleven entries away from "Drinks". */
    return flattenDepartments(departments)
      .filter(({ department }) => counts.has(department.id))
      .map(({ department, depth }) => ({
        ...department,
        depth,
        count: counts.get(department.id) ?? 0,
      }))
  }, [rows, departments])

  /**
   * The rows the picker draws, through the same builder the products list uses.
   *
   * Shared rather than mapped here so the three things a call site gets wrong
   * cannot drift: which tone a department carries (it has to be the same colour
   * here as on the till, or the colour stops being learnable), where its picture
   * comes from, and what happens to one whose parent is missing.
   *
   * Only the departments this change actually touches, each with its count. A
   * change covering three of forty must not offer the other thirty-seven, every
   * one of which could only ever empty the table.
   */
  const departmentOptions = useMemo(
    () =>
      departmentTreeOptions(
        usedDepartments.map((d) => ({
          id: d.id,
          parentId: d.parentId,
          name: d.name,
          color: d.color,
          imageId: d.imageId,
          count: d.count,
        })),
        { allLabel: `All departments (${rows.length})` },
      ),
    [usedDepartments, rows.length],
  )

  /**
   * The chosen department and everything under it.
   *
   * A set rather than a walk per row: this is checked once per line on a list
   * that runs to tens of thousands, and re-climbing the tree for each of them
   * would be the one thing on this screen fast enough to notice.
   */
  const inScope = useMemo(() => {
    if (departmentFilter.length === 0) return null
    const out = new Set<number>(departmentFilter)
    let added = true
    /* Repeated passes rather than recursion — the parent column is a
       self-reference, and this terminates on the pass that adds nothing
       however the rows are ordered or mis-parented. */
    while (added) {
      added = false
      for (const d of departments) {
        if (d.parentId !== null && out.has(d.parentId) && !out.has(d.id)) {
          out.add(d.id)
          added = true
        }
      }
    }
    return out
  }, [departmentFilter, departments])

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase()
    return rows.filter((r) => {
      if (inScope && (r.departmentId === null || !inScope.has(r.departmentId))) return false
      if (onlyChanging) {
        /* A seeded list is mostly prices that are not moving — they are there
           so they CAN be edited, and they are dropped at arming. Once the
           editing is done, this is the list somebody wants to check before
           they schedule it. */
        const moves = [...r.byStructure.values()].some(
          (l) => l.oldPriceIncl === null || l.oldPriceIncl !== l.newPriceIncl,
        )
        if (!moves) return false
      }
      if (!term) return true
      return (
        r.description.toLowerCase().includes(term) || r.code.toLowerCase().includes(term)
      )
    })
  }, [rows, search, inScope, onlyChanging])

  const pageRows = useMemo(() => filtered.slice(0, shown), [filtered, shown])

  const changing = schedule.lines.filter(
    (l) => l.oldPriceIncl === null || l.oldPriceIncl !== l.newPriceIncl,
  ).length
  const unchanged = schedule.lines.length - changing

  /* ── Mutations ──────────────────────────────────────────────────────── */

  /**
   * Every mutation on this screen, and where a refusal lands.
   *
   * A refusal that NAMES a field is put under that field and scrolled to —
   * "Choose when this change should happen." is about the date box, and saying
   * so in the corner of the screen while the box itself sits unmarked is how
   * somebody ends up hunting for what is wrong. One that names no field still
   * toasts, because an error with nowhere to go is still an error.
   */
  function run(
    action: () => Promise<
      | { ok: true; message: string }
      | { ok: false; error: string; field?: string; problems?: FieldProblems }
    >,
  ) {
    startTransition(async () => {
      const result = await action()
      if (!result.ok) {
        if (!errors.showResult(result)) return
        // Nothing to pin it to — say it the old way rather than swallowing it.
        if (!result.field && !result.problems?.length) toast.error(result.error)
        return
      }
      errors.clear()
      toast.success(result.message)
      router.refresh()
    })
  }

  function saveHeader() {
    const at = date && time ? `${date}T${time}` : ''
    run(() => saveScheduleAction(schedule.id, { name: name.trim(), effectiveAt: at }))
  }

  /**
   * Copy this change and go straight into the copy.
   *
   * Navigating rather than staying put and toasting: nobody duplicates a price
   * change to admire it — they do it to work on the numbers, and leaving them
   * on the original with a copy somewhere behind them is one more thing to go
   * and find. The copy is a draft with no date, so nothing can fire off this.
   */
  function duplicate() {
    startTransition(async () => {
      const result = await duplicateScheduleAction(schedule.id)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success('Copied. This is the copy — the original is untouched.')
      router.push(`/pricing-schedules/${result.id}`)
    })
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

  /**
   * What the bulk update is about to touch, in words.
   *
   * Built from the same three narrowings the table is using, because the dialog
   * covers the filters while it is open — somebody who set a department filter
   * a minute ago needs to be told it is still on before they move four hundred
   * prices they cannot see.
   */
  const scopeLabel = (() => {
    const parts: string[] = []
    if (search.trim()) parts.push(`matching “${search.trim()}”`)
    if (departmentFilter.length > 0) {
      const named =
        departmentFilter.length === 1
          ? (departments.find((d) => d.id === departmentFilter[0])?.name ?? '1 department')
          : `${departmentFilter.length} departments`
      parts.push(`in ${named}`)
    }
    if (onlyChanging) parts.push('that already change a price')
    return parts.length === 0 ? 'everything on this change' : parts.join(', ')
  })()

  /**
   * Move every price the filters match.
   *
   * The FILTER goes to the server, never the rows — the table only holds fifty
   * of them at a time, so a posted list would silently move a fraction of what
   * the button promised. See `bulkAdjustLinesAction`.
   */
  function applyBulk(
    change: BulkPriceChange,
    rounding: RepriceRounding,
    structureIds: number[],
  ) {
    setBulking(false)
    run(() =>
      bulkAdjustLinesAction(
        schedule.id,
        {
          search: search.trim() || undefined,
          departmentIds: departmentFilter.length > 0 ? departmentFilter : undefined,
          onlyChanging,
          priceStructureIds: structureIds.length > 0 ? structureIds : undefined,
        },
        change,
        rounding,
      ),
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
            {/* Each field's mark clears as soon as it is edited: leaving it red
                while somebody is visibly fixing it reads as the form not
                noticing. */}
            <Field label="Name" className="min-w-56 flex-1" {...errors.field('name')}>
              <Input
                value={name}
                onChange={(e) => {
                  setName(e.target.value)
                  errors.clearField('name')
                }}
                onBlur={saveHeader}
                disabled={!editable || busy}
              />
            </Field>
            <Field label="Date" className="w-44" {...errors.field('effectiveDate')}>
              <Input
                type="date"
                value={date}
                onChange={(e) => {
                  setDate(e.target.value)
                  errors.clearField('effectiveDate')
                }}
                onBlur={saveHeader}
                disabled={!editable || busy}
              />
            </Field>
            <Field label="Time" className="w-32" {...errors.field('effectiveTime')}>
              <Input
                type="time"
                value={time}
                onChange={(e) => {
                  setTime(e.target.value)
                  errors.clearField('effectiveTime')
                }}
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
              /* Three narrowings side by side, because they answer different
                 questions: "where is this one product", "show me just the
                 bakery", and "what is actually moving". A list seeded from
                 three departments is thousands of rows long, and the search box
                 alone only helps somebody who can already name what they want. */
              <div className="flex flex-wrap items-center gap-2">
                {onlyChanging || departmentFilter.length > 0 ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setDepartmentFilter([])
                      setOnlyChanging(false)
                      setShown(PAGE_SIZE)
                    }}
                  >
                    Clear filters
                  </Button>
                ) : null}

                <Button
                  variant={onlyChanging ? 'secondary' : 'ghost'}
                  size="sm"
                  aria-pressed={onlyChanging}
                  onClick={() => {
                    setOnlyChanging(!onlyChanging)
                    setShown(PAGE_SIZE)
                  }}
                >
                  <Icons.Filter size={15} />
                  Only what is changing
                </Button>

                {/* Beside the filters rather than up with "Start from my current
                    prices", because what it does is decided by them: the three
                    controls to its left choose the rows, and this says what
                    happens to those rows. Put with the seeding buttons it would
                    read as another way to BUILD the list. */}
                {editable && (
                  <Button variant="secondary" size="sm" onClick={() => setBulking(true)} disabled={busy}>
                    <Icons.Calculator size={15} />
                    Update these together
                  </Button>
                )}

                {/* The same picker the products list uses, so a department is
                    found the same way in both places: one level at a time with
                    a branch opening beside it, rather than as a flat run of
                    forty entries all opening with the same two words. Ticking a
                    branch takes everything under it — `inScope` does the
                    widening here, the way descendantIds does there. */}
                {usedDepartments.length > 1 && (
                  <TreeSelect
                    aria-label="Filter by department"
                    backLabel="Back to departments"
                    icon={<Icons.LayoutGrid size={16} />}
                    options={departmentOptions}
                    values={departmentFilter.map(String)}
                    /* A callback rather than `urlFilter`: this screen is a
                       client component holding its filter in state, where the
                       products list is a Server Component that keeps its own in
                       the URL. Same picker, the other half of its interface. */
                    onChangeMany={(next) => {
                      setDepartmentFilter(next.map(Number).filter((n) => Number.isFinite(n) && n > 0))
                      setShown(PAGE_SIZE)
                    }}
                    manyNoun="departments"
                    className="w-48"
                  />
                )}

                <ToolbarSearch
                  value={search}
                  onChange={(v) => {
                    setSearch(v)
                    setShown(PAGE_SIZE)
                  }}
                  placeholder="Find a product"
                />
              </div>
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
            /* Which of the three narrowings emptied it decides what this says.
               "No product matches ''" — with the search box empty — is what it
               used to say when the department filter was the one hiding
               everything, and it sends somebody looking for a typo they did not
               make. */
            <EmptyState
              icon={<Icons.Search size={22} />}
              title="Nothing matched"
              hint={
                search.trim()
                  ? `No product here matches “${search.trim()}”.`
                  : onlyChanging
                    ? 'Nothing in this part of the list changes a price yet.'
                    : 'Nothing on this change is filed under that department.'
              }
              action={
                <Button
                  variant="secondary"
                  onClick={() => {
                    setSearch('')
                    setDepartmentFilter([])
                    setOnlyChanging(false)
                    setShown(PAGE_SIZE)
                  }}
                >
                  Show everything again
                </Button>
              }
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
                          {/* "now → new" rather than the price type alone: the cell
                              holds both figures side by side, and a bare name
                              leaves the left-hand number unexplained. */}
                          {s.name} <span className="text-faint">now → new</span>
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
            {/* On EVERY status, not just drafts. The strongest reason to copy
                one is that it has already been applied: last April's increase
                is the list October's wants, and an applied change cannot be
                edited — copying is the only way to reuse it. */}
            {schedule.lines.length > 0 && (
              <Button variant="secondary" onClick={duplicate} disabled={busy}>
                <Icons.Copy size={15} />
                Duplicate
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

      <BulkUpdateModal
        open={bulking}
        onClose={() => setBulking(false)}
        structures={usedStructures}
        matched={filtered.length}
        scopeLabel={scopeLabel}
        busy={busy}
        onApply={applyBulk}
      />

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
 * Move every price on screen at once.
 *
 * The alternative to typing four hundred numbers by hand, and the reason the
 * filters above the table matter: the owner narrows the list to what they mean
 * — a search, a department, one price type — and then says what happens to all
 * of it. "Everything in Bakery up 10%, rounded to .99."
 *
 * ── IT APPLIES TO THE FILTER, NOT TO THE PAGE ────────────────────────────
 *
 * The table shows fifty rows at a time out of a list that can run to tens of
 * thousands, so "what is displayed" has two possible meanings and only one of
 * them is any use. This takes the whole FILTERED set — every row the search and
 * the department picker match, whether or not "Show more" has been pressed —
 * and the button says the count so there is no guessing which it meant.
 *
 * The server re-derives that set from the same filter rather than trusting a
 * list of prices from the browser; see `bulkAdjustLinesAction`.
 */
function BulkUpdateModal({
  open,
  onClose,
  structures,
  matched,
  scopeLabel,
  busy,
  onApply,
}: {
  open: boolean
  onClose: () => void
  /** The price types this change touches — what the table has columns for. */
  structures: Structure[]
  /** How many rows the current filters match, for the button. */
  matched: number
  /** What those filters are, in words, so the dialog can say what it will hit. */
  scopeLabel: string
  busy: boolean
  onApply: (change: BulkPriceChange, rounding: RepriceRounding, structureIds: number[]) => void
}) {
  type Operation = BulkPriceChange['kind']

  const [operation, setOperation] = useState<Operation>('increase-percent')
  const [percent, setPercent] = useState(10)
  const [amount, setAmount] = useState(0)
  const [structureIds, setStructureIds] = useState<number[]>([])
  const [roundingKind, setRoundingKind] = useState<RepriceRounding['kind']>('none')
  const [endingCents, setEndingCents] = useState(99)
  const [nearestStep, setNearestStep] = useState(0.5)

  /* Which box the operation needs. A percentage and a rand amount are different
     questions with different sensible defaults, so they keep separate state —
     switching from "up 10%" to "up by R2" must not offer to add R10. */
  const usesPercent = operation === 'increase-percent' || operation === 'decrease-percent'

  function buildChange(): BulkPriceChange {
    switch (operation) {
      case 'increase-percent':
        return { kind: 'increase-percent', percent }
      case 'decrease-percent':
        return { kind: 'decrease-percent', percent }
      case 'increase-amount':
        return { kind: 'increase-amount', amount }
      case 'decrease-amount':
        return { kind: 'decrease-amount', amount }
      case 'set':
        return { kind: 'set', amount }
    }
  }

  function buildRounding(): RepriceRounding {
    if (roundingKind === 'ending') return { kind: 'ending', cents: endingCents, direction: 'up' }
    if (roundingKind === 'nearest') return { kind: 'nearest', step: nearestStep }
    return { kind: 'none' }
  }

  /**
   * The rule in one sentence, on a real price.
   *
   * A worked example rather than a restatement of the form: "up 10%" and "R100
   * becomes R109.99" are the same rule, but only the second one shows what the
   * rounding did to it — which is the part that surprises people.
   */
  const example = (() => {
    const from = 100
    const to = applyBulkChange(from, buildChange(), buildRounding())
    if (to === null) return 'That would take a R100.00 price to zero or less.'
    return `A R100.00 price becomes ${formatMoney(to)}.`
  })()

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Update these prices together"
      titleMedia={
        <span className="flex size-12 items-center justify-center rounded-card border border-brand/25 bg-brand-soft text-brand">
          <Icons.Calculator size={22} />
        </span>
      }
      description="Moves every price the filters are showing, so you don't have to type them one by one."
      bodyGrows
      closeOnBackdrop={false}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={() => onApply(buildChange(), buildRounding(), structureIds)}
            disabled={busy || matched === 0}
          >
            {busy
              ? 'Working…'
              : `Update ${matched.toLocaleString('en-ZA')} price${matched === 1 ? '' : 's'}`}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <FieldGroup
          step={1}
          title="What to update"
          hint="Only the price types you tick. Nothing ticked means every type on this change."
        >
          {structures.length === 1 ? (
            <p className="text-sm text-muted">
              This change only touches <span className="font-medium text-ink">{structures[0].name}</span>.
            </p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {structures.map((s) => {
                const on = structureIds.includes(s.id)
                return (
                  <Checkbox
                    key={s.id}
                    checked={on}
                    onChange={() =>
                      setStructureIds(
                        on ? structureIds.filter((x) => x !== s.id) : [...structureIds, s.id],
                      )
                    }
                    label={<span className="font-medium">{s.name}</span>}
                    className={`h-control rounded-control border px-3 transition ${
                      on
                        ? 'border-brand bg-brand-soft'
                        : 'border-border bg-surface hover:border-border-strong'
                    }`}
                  />
                )
              })}
            </div>
          )}
        </FieldGroup>

        <FieldGroup step={2} title="What to do" hint={example}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Change">
              <Select
                value={operation}
                onChange={(e) => setOperation(e.target.value as Operation)}
              >
                <option value="increase-percent">Increase by a percentage</option>
                <option value="decrease-percent">Decrease by a percentage</option>
                <option value="increase-amount">Increase by an amount</option>
                <option value="decrease-amount">Decrease by an amount</option>
                <option value="set">Set them all to one price</option>
              </Select>
            </Field>

            {usesPercent ? (
              <Field label="Percentage" hint="Of each price as it stands now.">
                <NumberInput
                  value={percent}
                  onChange={(e) =>
                    setPercent(Number(String(e.target.value).replace(',', '.')) || 0)
                  }
                  step="0.01"
                  min="0"
                />
              </Field>
            ) : (
              <Field
                label={operation === 'set' ? 'New price' : 'Amount'}
                hint="Including VAT — the figure on the shelf edge."
              >
                <CurrencyInput
                  value={amount}
                  onChange={(e) =>
                    setAmount(Number(String(e.target.value).replace(',', '.')) || 0)
                  }
                />
              </Field>
            )}
          </div>
        </FieldGroup>

        <FieldGroup step={3} title="Tidy the result" hint="Applied after the change, to the shelf price.">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Rounding">
              <Select
                value={roundingKind}
                onChange={(e) => setRoundingKind(e.target.value as RepriceRounding['kind'])}
              >
                <option value="none">None — exact</option>
                <option value="ending">Force an ending (.99, .95)</option>
                <option value="nearest">Nearest step</option>
              </Select>
            </Field>

            {roundingKind === 'ending' && (
              <Field label="Ending" hint="Every price is forced up to this ending.">
                <Select
                  value={String(endingCents)}
                  onChange={(e) => setEndingCents(Number(e.target.value))}
                >
                  <option value="99">.99</option>
                  <option value="95">.95</option>
                  <option value="90">.90</option>
                  <option value="50">.50</option>
                  <option value="0">.00 — whole rand</option>
                </Select>
              </Field>
            )}

            {roundingKind === 'nearest' && (
              <Field label="Step" hint="0.05 for cash-friendly, 1 for whole rand.">
                <NumberInput
                  value={nearestStep}
                  onChange={(e) =>
                    setNearestStep(Number(String(e.target.value).replace(',', '.')) || 0)
                  }
                  step="0.05"
                  min="0"
                />
              </Field>
            )}
          </div>
        </FieldGroup>

        {/* What it is about to touch, stated in the dialog rather than only on
            the button — somebody who opened this with a department filter still
            on needs to see that before they press anything. */}
        <Callout tone={matched === 0 ? 'warning' : 'brand'} title="What this will change">
          {matched === 0
            ? 'Nothing matches the filters on the table behind this dialog.'
            : `${matched.toLocaleString('en-ZA')} price${matched === 1 ? '' : 's'} — ${scopeLabel}.`}{' '}
          The before-prices are left alone, so you can still see what moved.
        </Callout>
      </div>
    </Modal>
  )
}

/**
 * One editable price, with what it was and how far it moves.
 *
 * The difference is coloured because it is the thing being judged: a column of
 * plain numbers makes a 40% rise look exactly like a 2% one. Held locally while
 * typing and committed on blur, so every keystroke is not a round trip.
 *
 * ── THE BUFFER LASTS ONLY AS LONG AS THE FOCUS ───────────────────────────
 *
 * `useState(line.newPriceIncl)` seeds once, at mount, and these cells do not
 * remount: the rows are keyed by product and line id, which a price change does
 * not alter. So anything that rewrote the price from OUTSIDE — the bulk update,
 * above all, which moves every row at once — re-rendered with the new figure in
 * the prop while the box went on showing the old one. It looked like the update
 * had not run; leaving the screen and coming back "fixed" it, because that is
 * what finally remounted the cell.
 *
 * Keeping the buffer only while the field has focus is what fixes it. Typing
 * still never round-trips, and a value written by anything else appears the
 * moment the server re-renders. Same arbitration NumberInput documents for the
 * recipe panel's quantity cell, one level up: whoever is not typing defers.
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
  /* null means "not being typed in" — the prop is the truth. A number means
     this cell has focus and that is what the person has typed so far. */
  const [typed, setTyped] = useState<number | null>(null)
  const value = typed ?? line.newPriceIncl
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

  /* On ONE line, not stacked. A stacked cell doubles the row height, and this
     table is scrolled through looking for a product across tens of thousands of
     rows — every row of padding is a row somebody has to scroll past. */
  return (
    <span className="flex items-center justify-end gap-2">
      <span className="flex items-baseline gap-1.5 text-xs">
        <span className="numeric text-muted">{old === null ? '—' : formatMoney(old)}</span>
        {moved !== null && Math.abs(moved) >= 0.05 && (
          <span className={`numeric ${moved > 0 ? 'text-success' : 'text-danger'}`}>
            {moved > 0 ? '+' : ''}
            {moved.toFixed(0)}%
          </span>
        )}
      </span>
      {/* Boxed to the width of a price. Left to fill the column it becomes a
          huge empty field with the figures it is meant to be compared against
          squeezed against the far edge. */}
      <span className="w-28 shrink-0">
        <CurrencyInput
          value={value}
          /* Focus opens the buffer at whatever the price is right now, so the
             first keystroke edits the figure on screen rather than a number
             this cell remembered from before the last refresh. */
          onFocus={() => setTyped(line.newPriceIncl)}
          onChange={(e) => setTyped(Number(e.target.value.replace(',', '.')) || 0)}
          /* Cleared on the way out — the prop is the truth again the moment
             this cell is no longer the one being typed in. Without this the
             next bulk update would render behind a stale buffer, which is the
             bug this whole arrangement exists to prevent. */
          onBlur={() => {
            setTyped(null)
            onCommit(value)
          }}
          disabled={busy}
        />
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
 *
 * ── WHY THE DEPARTMENT LIST IS A TREE WITH A FILTER ──────────────────────
 *
 * Departments nest, and this list used to be flat: every sub-department sat at
 * the same indent as its parent in one alphabetical run, so "Beef" and "Beer"
 * were neighbours and nothing said which shelf either belonged to. A shop with
 * a hundred of them scrolled a short window hunting for a name whose parent it
 * could already see.
 *
 * So: indented under their parents, with a filter box above. Typing keeps a
 * department whose own name matches, every ancestor above it — a hit deep in
 * the tree arrives with its context rather than as an orphan line — and
 * everything beneath it, since a branch shown with nothing under it reads as
 * empty.
 *
 * Ticking a parent means the whole branch. The ids are expanded against the
 * tree in `seedFromCurrentAction`, where the products list and bulk pricing
 * expand theirs, so all three screens agree on what "Drinks" covers. A parent
 * with only some of its children ticked shows the dash.
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
  departments: DepartmentNode[]
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
  const [find, setFind] = useState('')

  const toggle = (list: number[], id: number) =>
    list.includes(id) ? list.filter((x) => x !== id) : [...list, id]

  /* Depth-first, so a child always sits directly under its parent and one
     indent in. Built here rather than taken as a prop: it is a view of the
     tree, and the page around this dialog has no other use for it. */
  const ordered = useMemo(() => flattenDepartments(departments), [departments])

  const byId = useMemo(() => new Map(departments.map((d) => [d.id, d])), [departments])

  /**
   * Every id from `id` up to the root, itself included.
   *
   * Guarded by a seen set rather than trusted: the tree comes from a
   * self-referencing table, and one row pointing at its own descendant would
   * otherwise spin here forever.
   */
  const lineage = useCallback(
    (id: number): number[] => {
      const chain: number[] = []
      const seen = new Set<number>()
      let current: number | null = id
      while (current !== null && !seen.has(current)) {
        seen.add(current)
        chain.push(current)
        current = byId.get(current)?.parentId ?? null
      }
      return chain
    },
    [byId],
  )

  const visible = useMemo(() => {
    const term = find.trim().toLowerCase()
    if (!term) return ordered

    const keep = new Set<number>()
    for (const { department } of ordered) {
      if (!department.name.toLowerCase().includes(term)) continue
      for (const id of lineage(department.id)) keep.add(id)
    }
    /* A second pass for the descendants of a hit — done from each row's own
       lineage rather than by walking children, so it stays one pass over the
       list however wide a branch is. */
    for (const { department } of ordered) {
      if (keep.has(department.id)) continue
      if (lineage(department.id).some((id) => id !== department.id && keep.has(id))) {
        keep.add(department.id)
      }
    }
    return ordered.filter(({ department }) => keep.has(department.id))
  }, [ordered, find, lineage])

  /** Ticked, or sitting under something ticked — the branch rule, made visible. */
  const covered = useMemo(() => {
    const chosen = new Set(depts)
    const out = new Set<number>(chosen)
    for (const { department } of ordered) {
      if (out.has(department.id)) continue
      if (lineage(department.id).some((id) => id !== department.id && chosen.has(id))) {
        out.add(department.id)
      }
    }
    return out
  }, [depts, ordered, lineage])

  /** Parents showing the dash: something inside is on, they themselves are not. */
  const partial = useMemo(() => {
    const out = new Set<number>()
    for (const id of covered) {
      for (const ancestor of lineage(id)) {
        if (ancestor !== id && !covered.has(ancestor)) out.add(ancestor)
      }
    }
    return out
  }, [covered, lineage])

  function tickDepartment(id: number) {
    setDepts((current) => {
      if (current.includes(id)) return current.filter((x) => x !== id)
      /* A parent absorbs its children: with Drinks ticked, "Drinks and Beer" is
         the same scope as "Drinks", and keeping both would count the branch
         twice in the summary beside the heading. */
      const kept = current.filter((other) => other !== id && !lineage(other).includes(id))
      return [...kept, id]
    })
  }

  const chosenLabel =
    depts.length === 0
      ? 'The whole shop'
      : depts.length === 1
        ? (byId.get(depts[0])?.name ?? '1 department')
        : `${depts.length} departments`

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Start from my current prices"
      /* The subject in the corner, the way every section heading carries its
         own — a dialog arriving with no mark of what it is about reads as a
         system prompt rather than as part of pricing. */
      titleMedia={
        <span className="flex size-12 items-center justify-center rounded-card border border-accent/25 bg-accent-soft text-accent">
          <Icons.Tag size={22} />
        </span>
      }
      /* A long form: the default 60vh cap made it read through a letterbox with
         empty desktop above and below. Still a MAX, so a short one stays short. */
      bodyGrows
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
      {/* Two bordered panels rather than two bare fields. The dialog asks two
          separate questions and the second is a scrolling list — unframed, that
          list runs into the price types above it and the whole body reads as
          one undifferentiated column. */}
      <div className="flex flex-col gap-4">
        <section className="rounded-card border border-border p-4">
          <h3 className="text-sm font-semibold text-ink">Which price types?</h3>
          <p className="mt-1 text-xs text-muted">
            Pick more than one to move them together in a single change.
          </p>
          {/* Boxed targets rather than a run of bare ticks: this choice decides
              what the change even is, and it goes wrong often enough — a shop
              raising retail while wholesale quietly stays put — to deserve
              something you cannot skim past. */}
          <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {structures.map((s) => {
              const on = picked.includes(s.id)
              return (
                <Checkbox
                  key={s.id}
                  checked={on}
                  onChange={() => setPicked(toggle(picked, s.id))}
                  label={<span className="font-medium">{s.name}</span>}
                  className={`h-control rounded-control border px-3 transition ${
                    on
                      ? 'border-brand bg-brand-soft'
                      : 'border-border bg-surface hover:border-border-strong'
                  }`}
                />
              )
            })}
          </div>
        </section>

        <section className="rounded-card border border-border p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-sm font-semibold text-ink">Which departments?</h3>
            {/* The count sits with the question rather than under the list: on a
                filtered list most ticks are scrolled out of sight, and this is
                the only thing that says the filter is not the whole selection. */}
            <span className="text-xs text-muted">{chosenLabel}</span>
          </div>

          {/* Only once the list is long enough to scroll. Below that it is a box
              that can only ever hide things. */}
          {ordered.length > 8 && (
            <div className="mt-3">
              <Input
                value={find}
                onChange={(e) => setFind(e.target.value)}
                placeholder="Filter departments"
                icon={<Icons.Search size={15} />}
                aria-label="Filter departments"
              />
            </div>
          )}

          <div className="mt-3 max-h-[34vh] min-h-48 overflow-y-auto rounded-control border border-border">
            {visible.length === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-muted">
                No department matches that.
              </p>
            ) : (
              visible.map(({ department, depth }) => {
                const on = depts.includes(department.id)
                const under = !on && covered.has(department.id)
                return (
                  <div
                    key={department.id}
                    /* Full-width rows, not a stack of inline labels: a tick
                       target that stops at the end of the word is a target you
                       miss, and the banding is what makes an indented tree read
                       as levels rather than as ragged text.
                       The indent sits HERE rather than on the Checkbox, which
                       spreads everything it does not recognise onto its inner
                       <input> — a style prop passed there padded the box, not
                       the row, and every level came out flush. */
                    style={{ paddingLeft: `${0.75 + depth * 1.25}rem` }}
                    className="border-b border-border last:border-b-0 odd:bg-surface-2/50"
                  >
                    <Checkbox
                      checked={on || under}
                      indeterminate={!on && !under && partial.has(department.id)}
                      /* A department covered by its parent shows ticked and
                         locked. Leaving it clear would be a lie — its products
                         ARE coming in — and letting it toggle alone would
                         contradict the parent that put it there. */
                      disabled={under}
                      onChange={() => tickDepartment(department.id)}
                      label={department.name}
                      className="w-full py-2 pr-3"
                    />
                  </div>
                )
              })
            )}
          </div>

          <p className="mt-2 text-xs text-muted">
            Leave all unticked for the whole shop. Ticking a department takes
            everything under it.
          </p>
        </section>
      </div>
    </Modal>
  )
}
