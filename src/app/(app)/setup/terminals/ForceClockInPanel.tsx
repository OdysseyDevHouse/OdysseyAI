'use client'

import { useState, useTransition } from 'react'
import { Card, CardHeader, CardBody, Button, Checkbox, useToast } from '@/components/ui'
import { setForceClockInAction } from './actions'

/**
 * Whether each person must be on duty before the till will let them trade.
 *
 * ── THE DISTINCTION THIS PANEL HAS TO MAKE ────────────────────────────────
 *
 * A shop already cannot trade without an open SHIFT — that gate is
 * unconditional and not a setting. The confusion worth heading off is that the
 * two sound like the same rule:
 *
 *   The shift is the DRAWER, opened once for the till.
 *   This is the PERSON, answered for each cashier who signs in.
 *
 * In terminal mode the second cashier of the day never meets the shift gate at
 * all — the drawer is already counted — so without this there is nothing that
 * asks whether they are on duty. The copy below leads with that, because a
 * manager reading "force clock in" beside a till that already gates on shifts
 * will reasonably wonder what is left to force.
 *
 * ── WHAT TURNING IT ON COSTS ──────────────────────────────────────────────
 *
 * A cashier who forgets to clock in cannot sell, and at 07:00 with a queue the
 * person who can fix that is a manager. Worth it for a shop paying from these
 * hours; expensive for a shop that keeps the clock as a rough record. Said
 * plainly here rather than discovered at a counter.
 */
export default function ForceClockInPanel({ forceClockIn }: { forceClockIn: boolean }) {
  const toast = useToast()
  const [on, setOn] = useState(forceClockIn)
  const [pending, startTransition] = useTransition()

  const dirty = on !== forceClockIn

  function save() {
    startTransition(async () => {
      const result = await setForceClockInAction(on)
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
        title="Clocking on at the till"
        description="Whether each cashier must go on duty before they can ring up a sale."
      />
      <CardBody>
        <div className="flex flex-wrap items-center gap-4">
          <Checkbox
            label="Require a cashier to clock on before trading"
            checked={on}
            onChange={(e) => setOn(e.target.checked)}
          />
          <Button variant="primary" onClick={save} disabled={!dirty || pending}>
            Save
          </Button>
        </div>

        <p className="pt-3 text-sm text-muted">
          Separate from opening the till. A shift is the drawer — counted in once, by whoever
          starts the day — and every cashier after that walks straight past it. This asks the
          other question: is the person now standing at the till on duty. With it on, signing
          in without an open time entry gets a PIN pad to clock on instead of the sale screen.
        </p>
        <p className="pt-2 text-sm text-muted">
          Somebody who is not set up to clock in is never stopped — their hours are not what
          this records. A till with no connection is not stopped either, because hours are
          recorded on the server and a shop should not close because the line dropped.
        </p>
      </CardBody>
    </Card>
  )
}
