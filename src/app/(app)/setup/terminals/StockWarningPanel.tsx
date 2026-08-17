'use client'

import { useState, useTransition } from 'react'
import { Card, CardHeader, CardBody, Button, Checkbox, useToast } from '@/components/ui'
import { setWarnOutOfStockAction } from './actions'

/**
 * Whether the till mentions stock when a sale is paid for.
 *
 * ── WHY A SHOP WOULD TURN THIS OFF ────────────────────────────────────────
 *
 * Many do not track stock. The counts in the system are approximate, nobody
 * reconciles them, and a till that argued about them would be wrong several
 * times a day in front of customers. For those shops the warning is noise — and
 * noise at the payment step is worse than silence, because a cashier who
 * dismisses a warning fifty times has stopped reading the fifty-first.
 *
 * So it is off unless a shop asks for it, and the copy below says what it does
 * rather than implying every shop should want it.
 *
 * ── WHAT IT IS NOT ────────────────────────────────────────────────────────
 *
 * Not a block. The till warns and carries on, because a shop selling something
 * it cannot hand over right now usually knows: the customer collects tomorrow,
 * the delivery is in the yard, the count is out and everybody knows it. Saying
 * so here matters, or a manager turns this on expecting the till to refuse.
 */
export default function StockWarningPanel({ warnOutOfStock }: { warnOutOfStock: boolean }) {
  const toast = useToast()
  const [on, setOn] = useState(warnOutOfStock)
  const [pending, startTransition] = useTransition()

  const dirty = on !== warnOutOfStock

  function save() {
    startTransition(async () => {
      const result = await setWarnOutOfStockAction(on)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(result.message)
    })
  }

  return (
    <Card>
      <CardHeader
        title="Stock warnings at the till"
        description="Whether the till says something when a sale is for more than the shop has."
      />
      <CardBody>
        <div className="flex flex-wrap items-center gap-4">
          <Checkbox
            label="Warn when a sale outruns stock on hand"
            checked={on}
            onChange={(e) => setOn(e.target.checked)}
          />
          <Button variant="primary" onClick={save} disabled={!dirty || pending}>
            Save
          </Button>
        </div>

        <p className="pt-3 text-sm text-muted">
          The warning appears when the cashier presses Pay, not as items are added — stock
          moves while a sale is being rung up, so the last moment is the accurate one. It
          never stops the sale, and a till with no connection stays quiet rather than
          guessing from figures it cannot check.
        </p>
      </CardBody>
    </Card>
  )
}
