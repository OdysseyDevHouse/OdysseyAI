'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Badge, Callout, Checkbox, EmptyState, Field, Input } from '@/components/ui'
import { Printer } from '@/components/ui/icons'
import type { KitchenPrinter } from '@/lib/site/kitchenPrinters'

/**
 * Where this product's docket prints, and under which heading.
 *
 * ── TWO INDEPENDENT ANSWERS ──────────────────────────────────────────────
 *
 * The PRINTERS decide which paper it comes out of; the GROUP decides where on
 * that paper it sits. They are genuinely separate — a steak and a side salad
 * can share the Grill and still belong to different courses — so they are two
 * controls rather than one clever one.
 *
 * ── NO PRINTER IS A REAL ANSWER ──────────────────────────────────────────
 *
 * Most products have none, and that is not an unfinished setting: a bag of ice
 * has nothing to tell a chef. There is no default printer anywhere in this
 * feature, so leaving every box unticked is how a product stays out of the
 * kitchen entirely.
 *
 * The one combination worth warning about is a group with no printer — somebody
 * has said which course this belongs to and then given it nowhere to print,
 * which is almost always a half-finished edit rather than an intention.
 *
 * Ticked ids submit as kitchenPrinter[]; the action replaces the product's whole
 * set, so unticking really unroutes.
 */
export default function ProductKitchenPanel({
  printers,
  attached,
  group: initialGroup,
  /** Groups already used elsewhere, so a shop reuses "Starters" rather than inventing it twice. */
  knownGroups,
}: {
  printers: KitchenPrinter[]
  attached: number[]
  group: string
  knownGroups: string[]
}) {
  const [selected, setSelected] = useState<Set<number>>(
    () => new Set(attached.filter((id) => printers.some((p) => p.id === id))),
  )
  const [group, setGroup] = useState(initialGroup)

  function toggle(id: number) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const orphanGroup = group.trim() !== '' && selected.size === 0

  if (printers.length === 0) {
    return (
      <EmptyState
        icon={<Printer size={20} />}
        title="No kitchen printers set up"
        hint="Add the stations this shop sends food to under Setup → Printing — a Bar and a Kitchen is the usual pair — then come back and point this product at one."
      />
    )
  }

  return (
    <div className="flex flex-col gap-4 px-4 py-3">
      <div className="flex flex-col gap-2">
        <span className="text-sm font-semibold text-ink">Print this to</span>
        <p className="text-xs text-muted">
          Tick every station that needs a docket. More than one is fine — each prints its
          own copy, and each is tracked separately, so a re-send to the bar never re-fires
          the food. Nothing ticked means this product never goes to a kitchen.
        </p>
        <div className="mt-1 flex flex-col gap-1.5">
          {printers.map((printer) => (
            <label
              key={printer.id}
              className="flex items-center justify-between gap-3 rounded-control border border-border px-3 py-2"
            >
              <Checkbox
                name="kitchenPrinter"
                value={printer.id}
                label={printer.name}
                checked={selected.has(printer.id)}
                onChange={() => toggle(printer.id)}
              />
              {/* The trap worth surfacing here as well as in Setup: a printer
                  nobody finished setting up takes this product's dockets
                  nowhere, however many products point at it. */}
              {printer.unconfigured && <Badge tone="warning">Not set up yet</Badge>}
            </label>
          ))}
        </div>
      </div>

      <Field
        label="Group on the docket"
        hint="The heading this prints under — “Starters”, “Mains”, “Fryer”. Leave blank and it prints last, under no heading. This is also what a waiter fires by course from the till."
      >
        <Input
          name="kitchenGroup"
          className="w-64"
          value={group}
          maxLength={60}
          list="kitchen-group-suggestions"
          placeholder="Mains"
          onChange={(e) => setGroup(e.target.value)}
        />
      </Field>
      {/* Free text, but suggested — two shops spell "Starters" one way each, and
          one shop spelling it two ways is a course that cannot be fired in one
          tap. Matching ignores case and spacing, so this is a convenience
          rather than a constraint. */}
      <datalist id="kitchen-group-suggestions">
        {knownGroups.map((known) => (
          <option key={known} value={known} />
        ))}
      </datalist>

      {orphanGroup && (
        <Callout tone="warning" title="This has a course but nowhere to print">
          A group decides where on the docket this sits, not whether it prints at all.
          Tick a station above, or the kitchen never sees it.
        </Callout>
      )}

      <p className="text-xs text-muted">
        Stations are managed under{' '}
        <Link href="/setup/printing" className="underline">
          Setup → Printing
        </Link>
        , where each till also says which of its printers each station means.
      </p>
    </div>
  )
}
