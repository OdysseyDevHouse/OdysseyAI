/**
 * What goes to the kitchen — the pure half.
 *
 * ── THE DELTA RULE ───────────────────────────────────────────────────────
 *
 * A line owes a printer `qty − (what that printer has already been sent)`,
 * clamped at zero. A new line owes everything; a bumped one owes the bump; a
 * REDUCED one owes nothing — clamping rather than going negative is what keeps
 * a reduction from silently un-sending food that is already on the grill. No
 * void notices in this version; the cancellation ticket is the stated deferral.
 *
 * PER PRINTER, and that is the whole reason 229 replaced the old scalar: a
 * steak routed to both Grill and Kitchen owes each of them separately, and
 * sending it to one must not blind the other.
 *
 * ── AND THE GROUPING RULE ────────────────────────────────────────────────
 *
 * Lines carry a free-text `kitchenGroup` — "Starters", "Mains", "Fryer". It
 * decides two things: how the ticket is laid out, and what a waiter can fire
 * separately when a table orders three courses at once.
 *
 * Groups are matched case- and whitespace-insensitively but PRINTED as the
 * first spelling seen, so "mains " and "Mains" are one course rather than two,
 * without the ticket shouting a normalised version at the chef.
 */

export type KitchenDeltaLine = {
  lineId: number
  qty: number
  /** Already sent TO THIS PRINTER. Other printers are a different question. */
  sentQty: number
}

export function kitchenDelta(lines: readonly KitchenDeltaLine[]): { lineId: number; qty: number }[] {
  return lines
    .map((l) => ({
      lineId: l.lineId,
      // Rounded to the thousandth to match the DECIMAL(12,3) the qty came
      // from — without it, 0.1 + 0.2 arithmetic leaves a line owing 1e-16.
      qty: Math.max(0, Math.round((l.qty - l.sentQty) * 1000) / 1000),
    }))
    .filter((l) => l.qty > 0)
}

/** The comparison key for a group. Not what prints — see `groupKitchenLines`. */
export function kitchenGroupKey(group: string): string {
  return group.trim().toLowerCase()
}

export type GroupedKitchenLine = {
  qty: number
  description: string
  notes: string[]
  note: string
  kitchenGroup: string
}

export type KitchenTicketGroup = {
  /** Empty for the ungrouped remainder, which prints under no heading. */
  title: string
  lines: GroupedKitchenLine[]
}

/**
 * Sorts a ticket's lines into their courses.
 *
 * Groups appear in the order they were FIRST RUNG rather than alphabetically:
 * a waiter who enters starters, then mains, then dessert gets a docket in that
 * order, and alphabetising it would put Dessert above Mains on every table in
 * the restaurant.
 *
 * Ungrouped lines always print LAST, under no heading. A shop that routes food
 * but has never thought about courses gets exactly the flat list it had before,
 * which is the point: grouping is an upgrade to the ticket, never a
 * requirement of it.
 */
export function groupKitchenLines(lines: readonly GroupedKitchenLine[]): KitchenTicketGroup[] {
  const groups: KitchenTicketGroup[] = []
  const byKey = new Map<string, KitchenTicketGroup>()
  const ungrouped: GroupedKitchenLine[] = []

  for (const line of lines) {
    const title = line.kitchenGroup.trim()
    if (!title) {
      ungrouped.push(line)
      continue
    }
    const key = kitchenGroupKey(title)
    const existing = byKey.get(key)
    if (existing) {
      existing.lines.push(line)
      continue
    }
    // The first spelling wins the heading — see the note above.
    const group: KitchenTicketGroup = { title, lines: [line] }
    byKey.set(key, group)
    groups.push(group)
  }

  if (ungrouped.length > 0) groups.push({ title: '', lines: ungrouped })
  return groups
}
