'use client'

import { useState, useTransition } from 'react'
import { Card, CardHeader, CardBody, Button, Radio, useToast } from '@/components/ui'
import { setScanFocusAction } from './actions'

/**
 * Where the cursor goes at the invoicing counter once a line has been added.
 *
 * ── WHY THIS IS A SETTING AND NOT A DECISION WE MAKE ──────────────────────
 *
 * Because the two answers describe different trades and each is genuinely wrong
 * for the other, which is the test for whether something deserves to be asked.
 *
 * A counter working through a trolley scans continuously. Every hop into a
 * quantity cell is a hop back out again, and a clerk who does not notice the
 * move types the next barcode into the quantity box — where it becomes a
 * quantity of 8901234, and is noticed at the total rather than at the moment.
 *
 * A counter selling by the box types a figure on nearly every line. Under
 * "scan box" that is a reach for the mouse each time, all day.
 *
 * ── AND WHY IT IS RADIOS RATHER THAN A CHECKBOX ───────────────────────────
 *
 * A checkbox would have to be named for one of the two and leave the other as
 * "not that", which reads as a default somebody failed to change. These are two
 * equal choices about how a shop works, so both are written out and neither is
 * the absence of the other.
 */
export default function ScanFocusPanel({ scanFocus }: { scanFocus: 'scan' | 'qty' }) {
  const toast = useToast()
  const [focus, setFocus] = useState<'scan' | 'qty'>(scanFocus)
  const [pending, startTransition] = useTransition()

  const dirty = focus !== scanFocus

  function save() {
    startTransition(async () => {
      const result = await setScanFocusAction(focus)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(result.message)
    })
  }

  return (
    <Card id="scan-focus">
      <CardHeader
        title="After a scan at the invoicing counter"
        description="Where the cursor lands once a line has been added."
      />
      <CardBody>
        {/* The reason for each choice sits UNDER its label rather than in the
            label itself: Radio takes a `label` and nothing else, and a sentence
            long enough to be worth reading makes a poor click target. Indented
            to the label's text so it reads as belonging to it. */}
        <div className="flex flex-col gap-4">
          <div>
            <Radio
              name="scan-focus"
              label="Back in the scan box"
              checked={focus === 'scan'}
              onChange={() => setFocus('scan')}
            />
            <p className="pl-6 text-sm text-muted">
              Ready for the next barcode. Best where most lines are one of something.
            </p>
          </div>
          <div>
            <Radio
              name="scan-focus"
              label="In the new line's quantity"
              checked={focus === 'qty'}
              onChange={() => setFocus('qty')}
            />
            <p className="pl-6 text-sm text-muted">
              Ready for a number, with the 1 selected so typing replaces it. Best where most
              lines need a count typed.
            </p>
          </div>
        </div>

        <div className="pt-4">
          <Button variant="primary" onClick={save} disabled={!dirty || pending}>
            Save
          </Button>
        </div>

        <p className="pt-3 text-sm text-muted">
          The invoicing counter only. A till line is opened through its own editor, which
          already chooses the field to open on, so this changes nothing about the POS.
        </p>
      </CardBody>
    </Card>
  )
}
