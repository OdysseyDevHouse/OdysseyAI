'use client'

import { useEffect, useMemo, useState, useTransition } from 'react'
import {
  Badge,
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  Checkbox,
  ConfirmModal,
  DataTable,
  EmptyState,
  Field,
  Icons,
  Input,
  Modal,
  Switch,
  useToast,
  type Column,
} from '@/components/ui'
import { activeMenu, menuGaps, type PosMenu, type PosMenuItem } from '@/lib/posMenuEngine'
import {
  createMenuAction,
  deleteMenuAction,
  saveMenuAction,
  setMenuActiveAction,
  type MenusResult,
} from './actions'

type Dept = { id: number; name: string; parentId: number | null }
type Till = { id: number; code: string; name: string }

/** Monday first, matching the stored mask — see 231. */
const DAY_LETTERS = ['M', 'T', 'W', 'T', 'F', 'S', 'S']
const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

type Draft = {
  name: string
  isActive: boolean
  dailyStart: string
  dailyEnd: string
  daysOfWeek: string
  priority: number
  items: PosMenuItem[]
  /** Empty means EVERY till (232), never "no tills". */
  terminalIds: number[]
}

const blankDraft = (): Draft => ({
  name: '',
  isActive: true,
  dailyStart: '',
  dailyEnd: '',
  daysOfWeek: '1111111',
  priority: 0,
  items: [],
  terminalIds: [],
})

const draftOf = (m: PosMenu): Draft => ({
  name: m.name,
  isActive: m.isActive,
  dailyStart: m.dailyStart,
  dailyEnd: m.dailyEnd,
  daysOfWeek: m.daysOfWeek,
  priority: m.priority,
  items: m.items,
  terminalIds: m.terminalIds,
})

/** "07:00 – 11:00", or "All day" when there is no band. */
function bandLabel(m: { dailyStart: string; dailyEnd: string }): string {
  if (!m.dailyStart || !m.dailyEnd) return 'All day'
  return `${m.dailyStart} – ${m.dailyEnd}`
}

/** "Every day", "Weekdays", or the letters that are on. */
function daysLabel(mask: string): string {
  if (mask === '1111111') return 'Every day'
  if (mask === '1111100') return 'Weekdays'
  if (mask === '0000011') return 'Weekends'
  const on = DAY_NAMES.filter((_, i) => mask[i] === '1')
  if (on.length === 0) return 'Never'
  return on.map((d) => d.slice(0, 3)).join(', ')
}

export function PosMenusClient({
  initialMenus,
  departments,
  terminals,
}: {
  initialMenus: PosMenu[]
  departments: Dept[]
  terminals: Till[]
}) {
  const [menus, setMenus] = useState(initialMenus)
  const [editing, setEditing] = useState<{ id: number | null; draft: Draft } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<PosMenu | null>(null)
  const [pending, start] = useTransition()
  const toast = useToast()

  /*
   * The clock, ticking.
   *
   * This screen's whole job is "which menu is on right now", and a static
   * answer computed at render would be quietly wrong the moment the page sat
   * open across a changeover — which is exactly when somebody is watching it
   * to check their work. A minute is the resolution the windows have.
   *
   * Started in an effect rather than at module scope so the server and the
   * first client render agree; a `now` sampled during SSR would hydrate
   * against a different minute and warn.
   */
  const [now, setNow] = useState<Date | null>(null)
  useEffect(() => {
    setNow(new Date())
    const t = setInterval(() => setNow(new Date()), 30_000)
    return () => clearInterval(t)
  }, [])

  /*
   * What is showing right now — asked SHOP-WIDE, with no till narrowing.
   *
   * `activeMenu` with the terminal omitted considers every menu, which is the
   * right question for a back office that is not a till: "what is running
   * somewhere in this shop". Passing null instead would mean "a machine that
   * matches no till" and would hide every pinned menu from this screen — so
   * a bar menu could be live on the bar and the setup screen would report
   * nothing showing.
   *
   * The banner then names which tills, because since 232 the answer is no
   * longer one menu for the whole building.
   */
  const liveNow = useMemo(() => {
    if (!now) return []

    /*
     * Resolved PER TILL and then grouped, rather than once for the shop.
     *
     * Since 232 there is no single answer: the bar can be on its own menu
     * while the counter runs lunch. Asking `activeMenu` once, shop-wide, would
     * name whichever menu wins on priority anywhere — and report a bar menu as
     * though the whole building were drawing it.
     *
     * Every till named by any menu gets its own answer. Tills nobody pinned
     * anything to are represented by one extra pass over the unpinned menus,
     * which is what such a till would actually draw.
     */
    const byMenu = new Map<number, { menu: PosMenu; tills: string[]; everywhere: boolean }>()
    const note = (m: PosMenu | null, till: string | null) => {
      if (!m) return
      const hit = byMenu.get(m.id)
      if (hit) {
        if (till) hit.tills.push(till)
        else hit.everywhere = true
      } else {
        byMenu.set(m.id, { menu: m, tills: till ? [till] : [], everywhere: !till })
      }
    }

    for (const id of new Set(menus.flatMap((m) => m.terminalIds))) {
      note(activeMenu(menus, now, id), terminals.find((t) => t.id === id)?.name ?? `Till ${id}`)
    }
    // What a till nobody pinned anything to draws.
    note(
      activeMenu(
        menus.filter((m) => m.terminalIds.length === 0),
        now,
      ),
      null,
    )

    return [...byMenu.values()].map((l) => ({
      menu: l.menu,
      where: l.everywhere
        ? l.tills.length > 0
          ? `every other till, and ${l.tills.join(', ')}`
          : 'every till'
        : l.tills.join(', '),
    }))
  }, [menus, now, terminals])

  const liveIds = useMemo(() => new Set(liveNow.map((l) => l.menu.id)), [liveNow])

  /*
   * Menus pinned to a till that can never actually win it.
   *
   * Pinning says WHERE a menu may run, not that it beats anything. A bar menu
   * pinned to till 2 still loses to a shop-wide menu that covers the same hour
   * on the same priority — the tie breaks on the lower id, which is invisible
   * from this screen. The shop sees a menu pinned to a till and assumes that
   * settles it; it does not, and nothing on screen said so.
   *
   * Checked at the MIDPOINT of the pinned menu's band rather than at `now`, so
   * the warning is a fact about the arrangement rather than something that
   * appears and disappears as the day moves.
   */
  const shadowed = useMemo(() => {
    const out: { menu: PosMenu; beatenBy: string }[] = []
    for (const m of menus) {
      if (!m.isActive || m.terminalIds.length === 0) continue
      const from = m.dailyStart ? Number(m.dailyStart.slice(0, 2)) * 60 + Number(m.dailyStart.slice(3)) : 0
      const to = m.dailyEnd ? Number(m.dailyEnd.slice(0, 2)) * 60 + Number(m.dailyEnd.slice(3)) : 1440
      // Overnight bands wrap; the midpoint of the running half is close enough
      // to answer "does anything outrank this while it is on".
      const mid = from <= to ? Math.floor((from + to) / 2) : (from + 30) % 1440
      const day = m.daysOfWeek.indexOf('1')
      if (day < 0) continue
      // 2026-08-24 is a Monday, so +day lands on the mask's first live day.
      const probe = new Date(2026, 7, 24 + day, Math.floor(mid / 60), mid % 60)
      const winner = activeMenu(menus, probe, m.terminalIds[0])
      if (winner && winner.id !== m.id) out.push({ menu: m, beatenBy: winner.name })
    }
    return out
  }, [menus])

  /*
   * The hours nothing covers.
   *
   * Collapsed by WINDOW rather than listed per day: a shop whose breakfast
   * ends at 10:00 and whose lunch starts at 11:00 has the same hole seven
   * times, and seven identical lines read as seven problems. One line saying
   * "10:00–11:00, every day" is the same fact and the one a person can act on.
   *
   * Recomputed from `menus` only — deliberately NOT from the clock. A gap is a
   * property of how the week is arranged, so the warning must not appear and
   * disappear as the day moves.
   */
  const gaps = useMemo(() => menuGaps(menus), [menus])

  const gapSummary = useMemo(() => {
    if (gaps.length === 0) return []
    const byWindow = new Map<string, { from: string; to: string; days: string[]; minutes: number }>()
    for (const g of gaps) {
      const key = `${g.from}-${g.to}`
      const hit = byWindow.get(key)
      if (hit) hit.days.push(g.dayName)
      else byWindow.set(key, { from: g.from, to: g.to, days: [g.dayName], minutes: g.minutes })
    }
    /*
     * INTERIOR gaps first, then by length.
     *
     * An interior gap is one with a menu on BOTH sides — the 10:00–11:00 hole
     * between breakfast and lunch. The stretches before the first menu and
     * after the last are almost always the shop being shut, and ranking those
     * first by raw length buries the one real mistake under two non-problems.
     *
     * Judged by the clock rather than by trading hours, which this screen does
     * not know: a gap that touches midnight at either end is treated as the
     * edge of the day. A genuine 24-hour shop is the case this reads slightly
     * wrong, and it still LISTS every gap — only the order changes.
     */
    const interior = (w: { from: string; to: string }) => w.from !== '00:00' && w.to !== '24:00'
    return [...byWindow.values()]
      .sort((a, b) => {
        if (interior(a) !== interior(b)) return interior(a) ? -1 : 1
        return b.minutes * b.days.length - a.minutes * a.days.length
      })
      .map((w) => ({
        ...w,
        when:
          w.days.length === 7
            ? 'every day'
            : w.days.length > 2
              ? `${w.days.length} days a week`
              : w.days.join(' and '),
      }))
  }, [gaps])

  const apply = (res: MenusResult, okMessage: string) => {
    if (!res.ok) {
      toast.error(res.error)
      return false
    }
    setMenus(res.menus)
    toast.success(okMessage)
    return true
  }

  const save = () => {
    if (!editing) return
    const { id, draft } = editing
    const input = {
      name: draft.name,
      isActive: draft.isActive,
      dailyStart: draft.dailyStart,
      dailyEnd: draft.dailyEnd,
      daysOfWeek: draft.daysOfWeek,
      priority: draft.priority,
    }
    start(async () => {
      if (id === null) {
        // Create then save the scope: a new menu has no id to hang items on
        // until it exists. The dialog stays open on failure so the typing is
        // not lost.
        const res = await createMenuAction(input)
        if (!res.ok) {
          toast.error(res.error)
          return
        }
        const created = res.menus.find((m) => !menus.some((old) => old.id === m.id))
        /* Second call whenever there is EITHER a scope or a till pinning to
           write. Guarding on `items.length` alone used to skip it, which
           silently dropped the tills a new menu had just been pinned to. */
        if (created && (draft.items.length > 0 || draft.terminalIds.length > 0)) {
          const withScope = await saveMenuAction(
            created.id,
            input,
            draft.items,
            draft.terminalIds,
          )
          if (!apply(withScope, `${draft.name} created.`)) return
        } else {
          setMenus(res.menus)
          toast.success(`${draft.name} created.`)
        }
      } else {
        const res = await saveMenuAction(id, input, draft.items, draft.terminalIds)
        if (!apply(res, `${draft.name} saved.`)) return
      }
      setEditing(null)
    })
  }

  const toggleActive = (m: PosMenu, next: boolean) => {
    start(async () => {
      const res = await setMenuActiveAction(m.id, next)
      apply(res, next ? `${m.name} switched on.` : `${m.name} switched off.`)
    })
  }

  const doDelete = () => {
    const m = confirmDelete
    if (!m) return
    start(async () => {
      const res = await deleteMenuAction(m.id)
      apply(res, `${m.name} deleted.`)
      setConfirmDelete(null)
    })
  }

  const columns: Column<PosMenu>[] = [
    {
      key: 'name',
      header: 'Menu',
      sortValue: (m) => m.name,
      cell: (m) => (
        <div className="flex items-center gap-2">
          <span className="font-medium text-ink">{m.name}</span>
          {/* The one thing an owner opens this screen to learn. */}
          {liveIds.has(m.id) && <Badge tone="success">On now</Badge>}
          {!m.isActive && <Badge tone="neutral">Off</Badge>}
        </div>
      ),
    },
    {
      key: 'band',
      header: 'Hours',
      sortValue: (m) => m.dailyStart || '',
      cell: (m) => <span className="numeric text-ink-2">{bandLabel(m)}</span>,
    },
    {
      key: 'days',
      header: 'Days',
      sortValue: (m) => m.daysOfWeek,
      cell: (m) => <span className="text-ink-2">{daysLabel(m.daysOfWeek)}</span>,
    },
    {
      key: 'scope',
      header: 'Shows',
      sortValue: (m) => m.items.length,
      cell: (m) => {
        if (m.items.length === 0) {
          // Not an error, and worth saying plainly: an empty scope shows the
          // whole grid rather than nothing. See productsOnMenu.
          return <span className="text-muted">Everything</span>
        }
        const inc = m.items.filter((i) => i.effect === 'include').length
        const exc = m.items.length - inc
        return (
          <span className="text-ink-2">
            {inc} included{exc > 0 && <span className="text-muted"> · {exc} excluded</span>}
          </span>
        )
      },
    },
    {
      key: 'tills',
      header: 'Tills',
      sortValue: (m) => m.terminalIds.length,
      cell: (m) => {
        // Empty is "every till" (232) and must SAY so — a blank cell here
        // would read as "no tills", which is the opposite of what it means.
        if (m.terminalIds.length === 0) return <span className="text-muted">All tills</span>
        const names = m.terminalIds
          .map((id) => terminals.find((t) => t.id === id)?.name)
          .filter(Boolean)
        // A pinned till that has since been deleted leaves an id with no name.
        // Counted rather than hidden, so the number still matches the picker.
        const label =
          names.length <= 2
            ? names.join(', ')
            : `${names.length} tills`
        return <span className="text-ink-2">{label || `${m.terminalIds.length} tills`}</span>
      },
    },
    {
      key: 'priority',
      header: 'Priority',
      sortValue: (m) => m.priority,
      numeric: true,
      cell: (m) => <span className="numeric text-ink-2">{m.priority}</span>,
    },
    {
      key: 'active',
      header: 'On',
      cell: (m) => (
        <Switch
          checked={m.isActive}
          onChange={(next) => toggleActive(m, next)}
          ariaLabel={`Switch ${m.name} ${m.isActive ? 'off' : 'on'}`}
          disabled={pending}
        />
      ),
    },
  ]

  return (
    <>
      {menus.length > 0 && (
        <Callout
          tone={liveNow.length > 0 ? 'success' : 'neutral'}
          title={
            liveNow.length === 0
              ? 'No menu is showing right now'
              : liveNow.length === 1
                ? `Showing now: ${liveNow[0].menu.name}`
                : 'Showing now — different menus on different tills'
          }
        >
          {liveNow.length === 0 ? (
            'No menu covers this hour, so the tills are showing the whole catalogue — which is the safe answer at an unplanned time of day.'
          ) : (
            <>
              {/* Says WHICH tills, because since 232 "showing now" is no longer
                  one answer for the whole shop. Claiming "every till" over a
                  menu pinned to the bar would be plainly false to anyone who
                  walked over and looked at the counter. */}
              <ul className="flex flex-col gap-1">
                {liveNow.map((l) => (
                  <li key={l.menu.id}>
                    <span className="font-medium">{l.menu.name}</span>
                    <span className="text-muted"> · {l.where}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-muted">
                Off-menu products stay sellable by scan or search.
              </p>
            </>
          )}
        </Callout>
      )}

      {/* The gap warning. Below the "showing now" line because that answers
          "is it working"; this answers "will it work all week" — and a shop
          reads the first question first. */}
      {/* Pinned but outranked. Above the gap warning because a menu that never
          runs is a bigger surprise than an hour with no menu — the shop has
          deliberately assigned this one to a till and it is doing nothing. */}
      {shadowed.length > 0 && (
        <Callout
          tone="warning"
          title={
            shadowed.length === 1
              ? `${shadowed[0].menu.name} never runs — ${shadowed[0].beatenBy} outranks it`
              : `${shadowed.length} pinned menus never run`
          }
        >
          <p>
            Pinning a menu to a till says <em>where</em> it may run, not that it wins. These are
            beaten by a menu covering the same hours at the same or lower priority:
          </p>
          <ul className="mt-2 flex flex-col gap-1">
            {shadowed.slice(0, 4).map((s) => (
              <li key={s.menu.id}>
                <span className="font-medium">{s.menu.name}</span>
                <span className="text-muted"> · loses to {s.beatenBy}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-muted">
            Give the pinned menu a lower priority number than the menu beating it.
          </p>
        </Callout>
      )}

      {gapSummary.length > 0 && (
        <Callout
          tone="warning"
          /* Names the WORST gap rather than counting them. "There are 3
             periods with no menu" makes somebody go looking; "Nothing is on
             the menu between 10:00 and 11:00" is already the sentence they
             would have had to work out for themselves. */
          title={`Nothing is on the menu between ${gapSummary[0].from} and ${gapSummary[0].to}${
            gapSummary.length > 1 ? `, and at ${gapSummary.length - 1} other time${gapSummary.length > 2 ? 's' : ''}` : ''
          }`}
        >
          <p>
            The tills fall back to showing the whole catalogue during these hours, which is
            probably not what you want:
          </p>
          <ul className="mt-2 flex flex-col gap-1">
            {gapSummary.slice(0, 4).map((w) => (
              <li key={`${w.from}-${w.to}`}>
                <span className="numeric font-medium">
                  {w.from} – {w.to}
                </span>
                <span className="text-muted"> · {w.when}</span>
              </li>
            ))}
            {gapSummary.length > 4 && (
              <li className="text-muted">and {gapSummary.length - 4} more</li>
            )}
          </ul>
          <p className="mt-2 text-muted">
            Close a gap by making one menu end where the next begins, or add an all-day menu at a
            higher priority number to sit underneath the others.
          </p>
        </Callout>
      )}

      <Card>
        <CardHeader
          title="Menus"
          description="A menu takes over the till's grid during its hours. Lower priority wins when two overlap."
          action={
            <Button
              variant="primary"
              onClick={() => setEditing({ id: null, draft: blankDraft() })}
              disabled={pending}
            >
              <Icons.Plus className="size-4" aria-hidden />
              New menu
            </Button>
          }
        />
        <CardBody>
          {menus.length === 0 ? (
            <EmptyState
              title="No rotating menus yet"
              hint="Add one for each service — breakfast, lunch, dinner — and the till will switch between them on its own clock. Until then every till shows the whole catalogue, exactly as it does today."
              action={
                <Button variant="primary" onClick={() => setEditing({ id: null, draft: blankDraft() })}>
                  Create the first menu
                </Button>
              }
            />
          ) : (
            <DataTable
              columns={columns}
              rows={menus}
              getRowKey={(m) => m.id}
              actions={(m) => (
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    iconOnly
                    aria-label={`Edit ${m.name}`}
                    onClick={() => setEditing({ id: m.id, draft: draftOf(m) })}
                  >
                    <Icons.Pencil className="size-4" aria-hidden />
                  </Button>
                  <Button
                    variant="danger-ghost"
                    size="sm"
                    iconOnly
                    aria-label={`Delete ${m.name}`}
                    onClick={() => setConfirmDelete(m)}
                  >
                    <Icons.Trash className="size-4" aria-hidden />
                  </Button>
                </div>
              )}
              empty={{ title: 'No menus', hint: 'Add one to get started.' }}
            />
          )}
        </CardBody>
      </Card>

      {editing && (
        <MenuEditor
          draft={editing.draft}
          isNew={editing.id === null}
          departments={departments}
          terminals={terminals}
          saving={pending}
          onChange={(patch) =>
            setEditing((e) => (e ? { ...e, draft: { ...e.draft, ...patch } } : e))
          }
          onClose={() => setEditing(null)}
          onSave={save}
        />
      )}

      <ConfirmModal
        open={confirmDelete !== null}
        onClose={() => setConfirmDelete(null)}
        onConfirm={doDelete}
        title={`Delete ${confirmDelete?.name ?? ''}?`}
        confirmLabel="Delete menu"
        tone="danger"
        busy={pending}
        message="The tills will stop switching to it. Nothing about your products changes — this only controls what the grid shows and when."
      />
    </>
  )
}

/** The one dialog: a menu's hours, its days, and what it shows. */
function MenuEditor({
  draft,
  isNew,
  departments,
  terminals,
  saving,
  onChange,
  onClose,
  onSave,
}: {
  draft: Draft
  isNew: boolean
  departments: Dept[]
  terminals: Till[]
  saving: boolean
  onChange: (patch: Partial<Draft>) => void
  onClose: () => void
  onSave: () => void
}) {
  const setDay = (i: number, on: boolean) => {
    const days = draft.daysOfWeek.split('')
    days[i] = on ? '1' : '0'
    onChange({ daysOfWeek: days.join('') })
  }

  const includedDepts = useMemo(
    () =>
      new Set(
        draft.items.filter((i) => i.effect === 'include' && i.departmentId !== null).map((i) => i.departmentId!),
      ),
    [draft.items],
  )

  const toggleDept = (id: number, on: boolean) => {
    const rest = draft.items.filter((i) => i.departmentId !== id)
    onChange({
      items: on ? [...rest, { effect: 'include', productId: null, departmentId: id }] : rest,
    })
  }

  /*
   * The band and the day mask both feed `menuActiveAt`, so the dialog says in
   * words what the rule will do — an owner should not have to run the shop for
   * a day to find out that an end before a start means overnight.
   */
  const overnight =
    !!draft.dailyStart && !!draft.dailyEnd && draft.dailyStart > draft.dailyEnd

  return (
    <Modal
      open
      onClose={onClose}
      title={isNew ? 'New menu' : draft.name || 'Edit menu'}
      description="The till switches to this menu during its hours, on its own clock."
      size="lg"
      /* This form is long — hours, days, a department list and a till list —
         and the default 60vh cap made it read through a letterbox with empty
         desktop above and below. `bodyGrows` is a MAX rather than a height, so
         a shop with three departments still gets a short dialog; only a form
         with enough content to earn the height takes it. */
      bodyGrows
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" onClick={onSave} disabled={saving}>
            {saving ? 'Saving…' : isNew ? 'Create menu' : 'Save menu'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <Field label="Name" hint="What staff call this service — it shows on the till.">
          {/* Short field for short content, per the craft guidance. */}
          <span className="block max-w-xs">
            <Input
              value={draft.name}
              onChange={(e) => onChange({ name: e.target.value })}
              placeholder="Breakfast"
              autoFocus
            />
          </span>
        </Field>

        <Field
          label="Hours"
          hint={
            overnight
              ? 'Runs overnight — from the start time, through midnight, until the end time.'
              : 'Leave both blank to run all day. The end time is when the next menu takes over.'
          }
        >
          <div className="flex items-center gap-2">
            <span className="w-28 shrink-0">
              <Input
                type="time"
                aria-label="Start time"
                value={draft.dailyStart}
                onChange={(e) => onChange({ dailyStart: e.target.value })}
              />
            </span>
            <span className="text-sm text-muted">to</span>
            <span className="w-28 shrink-0">
              <Input
                type="time"
                aria-label="End time"
                value={draft.dailyEnd}
                onChange={(e) => onChange({ dailyEnd: e.target.value })}
              />
            </span>
            {(draft.dailyStart || draft.dailyEnd) && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onChange({ dailyStart: '', dailyEnd: '' })}
              >
                All day
              </Button>
            )}
          </div>
        </Field>

        <Field label="Days">
          <div className="flex flex-wrap items-center gap-1.5">
            {DAY_LETTERS.map((label, i) => {
              const on = draft.daysOfWeek[i] === '1'
              return (
                <Button
                  key={DAY_NAMES[i]}
                  variant={on ? 'primary' : 'secondary'}
                  size="sm"
                  aria-pressed={on}
                  aria-label={DAY_NAMES[i]}
                  onClick={() => setDay(i, !on)}
                >
                  {label}
                </Button>
              )
            })}
            <span className="mx-1 h-5 w-px bg-border" aria-hidden />
            {/* Presets REPLACE the mask and never look selected — they are
                actions, not a third state. Same as the specials form. */}
            <Button variant="ghost" size="sm" onClick={() => onChange({ daysOfWeek: '1111111' })}>
              All
            </Button>
            <Button variant="ghost" size="sm" onClick={() => onChange({ daysOfWeek: '1111100' })}>
              Weekdays
            </Button>
            <Button variant="ghost" size="sm" onClick={() => onChange({ daysOfWeek: '0000011' })}>
              Weekend
            </Button>
          </div>
        </Field>

        <Field
          label="What this menu shows"
          hint="Pick the departments on this menu. Choose none and it shows everything — useful for an all-day menu that only exists to sit under the others."
        >
          {/* No inner scroller, deliberately. It used to cap at max-h-64 and
              scroll on its own, which under `bodyGrows` would mean TWO
              scrollbars — a short list stuck in a letterbox while the dialog
              around it had height to spare. The department list now grows and
              the dialog's own body does the scrolling, so the tall panel is
              actually spent on the content that needed it. */}
          <div className="rounded-card border border-border p-3">
            {departments.length === 0 ? (
              <p className="text-sm text-muted">
                No departments yet. Add some under Products › Departments and they will appear
                here.
              </p>
            ) : (
              <div className="flex flex-col gap-2">
                {departments.map((d) => (
                  <Checkbox
                    key={d.id}
                    checked={includedDepts.has(d.id)}
                    onChange={(e) => toggleDept(d.id, e.target.checked)}
                    label={d.name}
                  />
                ))}
              </div>
            )}
          </div>
        </Field>

        <Field
          label="Which tills"
          hint={
            draft.terminalIds.length === 0
              ? 'Running on every till, including any added later. Tick individual tills to limit it.'
              : `Running on ${draft.terminalIds.length} of ${terminals.length} tills. Untick them all to go back to every till.`
          }
        >
          {terminals.length === 0 ? (
            <p className="text-sm text-muted">
              No tills registered yet. This menu runs on every till, which is the right answer
              until there is more than one.
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {/* "All tills" is a real choice, not the absence of one — so it
                  gets its own row rather than being implied by an empty list.
                  Selecting it CLEARS the pinning, which is what empty means. */}
              <Checkbox
                checked={draft.terminalIds.length === 0}
                onChange={(e) => {
                  if (e.target.checked) onChange({ terminalIds: [] })
                }}
                label="All tills"
              />
              <div className="flex flex-col gap-2 border-l border-border pl-4">
                {terminals.map((t) => (
                  <Checkbox
                    key={t.id}
                    checked={draft.terminalIds.includes(t.id)}
                    onChange={(e) =>
                      onChange({
                        terminalIds: e.target.checked
                          ? [...draft.terminalIds, t.id]
                          : draft.terminalIds.filter((id) => id !== t.id),
                      })
                    }
                    label={`${t.name} (${t.code})`}
                  />
                ))}
              </div>
            </div>
          )}
        </Field>

        <Field
          label="Priority"
          /* Spells out that pinning does NOT win on its own. A menu pinned to
             the bar still loses to a shop-wide menu on the same priority — the
             tie breaks on the lower id, which is invisible from this screen.
             It surprised the person who built this feature; it will surprise a
             shop the same way, and the fix is one number. */
          hint={
            draft.terminalIds.length > 0
              ? 'Lower wins when two menus cover the same moment. Pinning to a till does NOT make this menu win — give it a lower number than the shop-wide menus it overlaps, or they take the till instead.'
              : 'Lower wins when two menus cover the same moment — breakfast at 0 beats an all-day menu at 10.'
          }
        >
          <span className="block w-24">
            <Input
              type="number"
              value={String(draft.priority)}
              onChange={(e) => onChange({ priority: Number(e.target.value) || 0 })}
            />
          </span>
        </Field>

        <Switch
          checked={draft.isActive}
          onChange={(next) => onChange({ isActive: next })}
          label="Switched on"
          hint="Off keeps the menu and its hours, but the tills ignore it."
        />
      </div>
    </Modal>
  )
}
