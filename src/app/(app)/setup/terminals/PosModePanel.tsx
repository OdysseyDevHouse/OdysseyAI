'use client'

import { useState, useTransition } from 'react'
import { Card, CardHeader, CardBody, Button, useToast } from '@/components/ui'
import { POS_MODES, POS_MODE_LABELS, POS_MODE_HINTS, type PosMode } from '@/lib/posMode'
import { setPosModeChoiceAction } from './actions'

/**
 * Which till this shop runs.
 *
 * ── WHY IT MOVED HERE ─────────────────────────────────────────────────────
 *
 * This used to be a switch on Setup → Tables, which was fine while the only
 * question was "tables, yes or no". It is the wrong home for a three-way choice:
 * a paint shop setting up a trade counter should not have to go to a screen
 * about restaurant furniture to say what kind of shop it is, and a switch cannot
 * express a third option anyway.
 *
 * The tables screen keeps its own switch, which still turns tables on and off —
 * it simply no longer forces a shop back to 'retail' when turned off, since that
 * would quietly undo a trade counter the first time somebody saved that screen.
 *
 * ── WHY IT IS THREE CARDS AND NOT A DROPDOWN ──────────────────────────────
 *
 * The choice changes the whole screen a cashier stands at all day, and it is
 * made once. A dropdown shows one option and hides the rest behind a click; a
 * shop deciding this should see all three side by side, with what each is FOR,
 * because the names alone do not tell somebody which of them describes their
 * trade.
 */
export default function PosModePanel({ mode }: { mode: PosMode }) {
  const toast = useToast()
  const [picked, setPicked] = useState<PosMode>(mode)
  const [pending, startTransition] = useTransition()

  const dirty = picked !== mode

  function save() {
    startTransition(async () => {
      const result = await setPosModeChoiceAction(picked)
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
        title="What kind of till"
        description="The screen a cashier works on all day. One answer per shop."
      />
      <CardBody>
        <div className="grid gap-3 sm:grid-cols-3">
          {POS_MODES.map((value) => {
            const selected = picked === value
            return (
              <button
                key={value}
                type="button"
                onClick={() => setPicked(value)}
                /* Aria-pressed rather than a radio group: these are large
                   choice cards, and a radio's own dot beside a selected card
                   states the same thing twice. */
                aria-pressed={selected}
                className={`flex flex-col gap-1 rounded-card border p-4 text-left transition ${
                  selected
                    ? 'border-brand bg-brand-soft'
                    : 'border-border bg-surface hover:border-brand'
                }`}
              >
                <span className="font-semibold text-ink">{POS_MODE_LABELS[value]}</span>
                <span className="text-sm text-muted">{POS_MODE_HINTS[value]}</span>
              </button>
            )
          })}
        </div>

        <div className="flex items-center gap-3 pt-4">
          <Button variant="primary" onClick={save} disabled={!dirty || pending}>
            Save
          </Button>
          {dirty && (
            <span className="text-sm text-muted">
              Tills pick this up on their next refresh — no reload needed.
            </span>
          )}
        </div>

        <p className="pt-3 text-sm text-muted">
          Nothing is migrated when this changes. Open bills stay exactly where they are and
          can be settled from whichever screen the till now shows, because underneath all
          three are the same sale.
        </p>
      </CardBody>
    </Card>
  )
}
