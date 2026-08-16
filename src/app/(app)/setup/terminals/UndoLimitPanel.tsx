'use client'

import { useState, useTransition } from 'react'
import { Card, CardHeader, CardBody, Button, Field, NumberInput, useToast } from '@/components/ui'
import { setUndoLimitAction } from './actions'

/**
 * How many times a cashier may undo within one sale.
 *
 * ── WHY A NUMBER AND NOT A SWITCH ─────────────────────────────────────────
 *
 * "Allow undo / do not allow undo" is the wrong question. A till with no undo at
 * all makes an honest mis-scan expensive — the cashier has to void and re-ring
 * the basket, in front of the customer — so shops turn it back on and are no
 * further forward. What a shop actually wants is a small number: enough to fix
 * the ordinary mistake, few enough that taking a basket apart line by line has to
 * be a decision somebody makes rather than a habit.
 *
 * ── WHAT THE LIMIT IS AND IS NOT ──────────────────────────────────────────
 *
 * It is not an audit control. EVERY undo is written to the activity log with the
 * operator, the line and its value, whatever this is set to — including when it
 * is set to 0. So this decides what the till PERMITS, and the trail is complete
 * either way. Saying so on the screen matters: a manager who thought this was the
 * recording switch would set it to zero and believe they had turned the trail
 * off, or set it low and believe they had turned it on.
 */
export default function UndoLimitPanel({ limit }: { limit: number }) {
  const toast = useToast()
  const [value, setValue] = useState(limit)
  const [pending, startTransition] = useTransition()

  const dirty = value !== limit

  function save() {
    startTransition(async () => {
      const result = await setUndoLimitAction(value)
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
        title="Undo on the till"
        description="How many times a cashier can take the last line back off one sale."
      />
      <CardBody>
        <div className="flex flex-wrap items-end gap-4">
          {/* Constrained, because it is a one- or two-digit number and a
              full-width box would suggest otherwise. */}
          <div className="w-40">
            <Field
              label="Undos per sale"
              hint={value === 0 ? 'No limit.' : `Then the till refuses until the sale is done.`}
            >
              <NumberInput
                value={value}
                min={0}
                max={99}
                onChange={(e) => setValue(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
              />
            </Field>
          </div>

          <Button variant="primary" onClick={save} disabled={!dirty || pending}>
            Save
          </Button>
        </div>

        <p className="pt-3 text-sm text-muted">
          Set it to 0 for no limit. Every undo is recorded either way — who did it, which
          line, and what it was worth — so this decides what the till allows, not what it
          keeps track of.
        </p>
      </CardBody>
    </Card>
  )
}
