/**
 * What goes to the kitchen — the pure half.
 *
 * The DELTA rule, stated once: a line owes the kitchen `qty − kitchen_sent_qty`,
 * clamped at zero. A new line owes everything; a bumped one owes the bump; a
 * REDUCED one owes nothing — v1 prints no void notices, and clamping (rather
 * than a negative) is what keeps a reduction from silently un-sending food
 * that is already on the grill. The cancellation ticket is the stated
 * deferral.
 */

export type KitchenDeltaLine = {
  lineId: number
  qty: number
  kitchenSentQty: number
}

export function kitchenDelta(lines: readonly KitchenDeltaLine[]): { lineId: number; qty: number }[] {
  return lines
    .map((l) => ({ lineId: l.lineId, qty: Math.max(0, Math.round((l.qty - l.kitchenSentQty) * 1000) / 1000) }))
    .filter((l) => l.qty > 0)
}
