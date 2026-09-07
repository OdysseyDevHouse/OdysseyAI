'use client'

import { Modal, Switch, Button, Badge } from '@/components/ui'
import { WIDGETS, WIDGET_GROUPS, type WidgetId, type WidgetKind } from './widgets'

/**
 * Show and hide widgets.
 *
 * A modal rather than the slide-out drawer the original used: the drawer was a
 * bespoke panel with its own backdrop, focus trap and escape handling, all of
 * which `Modal` already does correctly. One less thing to keep accessible.
 *
 * GROUPED, because the catalogue outgrew a list. Twenty-three switches in one
 * column is a wall: the eye has no landmarks in it, and finding "the debtors
 * ageing" means reading every title from the top. Three headings turn the same
 * switches into three short lists a reader can skip past — and the two that
 * matter most, job cards and the back office, are exactly the ones a shop wants
 * to reach as a block rather than one at a time.
 */

/**
 * The pill beside each name, saying what shape the widget is.
 *
 * Neutral for all four. Colour in this app means STATE — success, warning,
 * danger — and a widget's shape is not a state it is in; four coloured pills
 * down the list would be four meanings the reader has to learn and then find
 * were never there. What earns the pill its place is the WORD, and the word
 * reads fine on a grey ground.
 */
const KIND_LABEL: Record<WidgetKind, string> = {
  kpi: 'KPI',
  graph: 'Graph',
  table: 'Table',
  list: 'List',
}

/**
 * The order the shapes are listed in within a section.
 *
 * Registry order is DASHBOARD order — where each widget lands on the grid — and
 * read down a column of switches it looks like no order at all: a chart, two
 * tables, another chart. Sorting by shape puts the figures at the top of each
 * section, then the charts, then the tables, so the pills line up into blocks
 * instead of speckling the list.
 *
 * It changes only this list. Nothing about the layout follows from it, and a
 * widget switched on still lands wherever the grid puts it.
 */
const KIND_ORDER: Record<WidgetKind, number> = { kpi: 0, graph: 1, table: 2, list: 3 }

export function WidgetPanel({
  open,
  hidden,
  visible,
  onToggle,
  onClose,
  onReset,
}: {
  open: boolean
  hidden: WidgetId[]
  /**
   * The widgets this user could see at all. A switch for data their role does
   * not include would only ever turn on a box saying "not available", which is
   * a worse answer than not offering the switch.
   */
  visible: readonly WidgetId[]
  onToggle: (id: WidgetId) => void
  onClose: () => void
  onReset: () => void
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Widgets"
      description="Choose what this dashboard shows. Drag and resize them on the page itself."
      /* The whole widget catalogue as a list of toggles, and it only grows as
         widgets are added. Still a MAX, so a small catalogue stays small. */
      bodyGrows
      footer={
        <>
          <Button variant="ghost" onClick={onReset}>
            Reset to default
          </Button>
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        {WIDGET_GROUPS.map((group) => {
          /* Sorted on a COPY — `filter` already made one, but say so: WIDGETS
             is the registry every other screen reads, and an in-place sort here
             would quietly reorder the default layout for the whole app. */
          const rows = WIDGETS.filter(
            (w) => w.group === group.id && visible.includes(w.id),
          ).sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind])

          /* A section with nothing in it is not rendered at all — not shown
             empty, and not shown greyed. A shop that never bought Job Cards has
             no job widgets in `visible`, and a "Job cards" heading over an empty
             box would be an advert for a module dressed as a setting. */
          if (rows.length === 0) return null

          return (
            <section key={group.id}>
              {/* The heading is a caption, not a title: it labels the block
                  below it and must not compete with the switches, which are the
                  thing being read. Hence small, warm and uppercase rather than
                  another line of ink-coloured sentence text. */}
              <h3 className="px-2 text-xs font-semibold uppercase tracking-wide text-stat-label">
                {group.title}
              </h3>
              <p className="mb-1 px-2 text-xs text-muted">{group.note}</p>

              <ul className="flex flex-col">
                {rows.map((w) => (
                  <li key={w.id}>
                    <label className="flex cursor-pointer items-center gap-3 rounded-control px-2 py-2.5 hover:bg-surface-2">
                      <span className="text-sm text-ink">{w.title}</span>
                      {/* Between the name and the switch, not after the switch:
                          it belongs to the title it qualifies, and a column of
                          pills on the far right would read as a second set of
                          controls. */}
                      <Badge tone="neutral">{KIND_LABEL[w.kind]}</Badge>
                      <span className="ml-auto">
                        <Switch
                          checked={!hidden.includes(w.id)}
                          onChange={() => onToggle(w.id)}
                        />
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </section>
          )
        })}
      </div>
    </Modal>
  )
}
