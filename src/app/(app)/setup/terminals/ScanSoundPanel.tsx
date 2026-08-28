'use client'

import { useState, useTransition } from 'react'
import { Card, CardHeader, CardBody, Button, Checkbox, Icons, useToast } from '@/components/ui'
import { scanOk, scanFailed } from '@/lib/posOffline/scanSound'
import { setScanSoundsAction } from './actions'

/**
 * Whether the till beeps when something is rung up.
 *
 * ── WHY THIS PANEL HAS PLAY BUTTONS ───────────────────────────────────────
 *
 * Because the setting is a SOUND, and a checkbox is a poor way to decide about
 * one. A manager turning this on has no idea what they have agreed to until the
 * first cashier hears it, and the thing they actually need to judge — whether
 * the two are distinguishable across a shop floor — cannot be read off a label
 * at all.
 *
 * The buttons play the real functions the till plays. Not a recording of them,
 * not an approximation: `scanOk` and `scanFailed` are imported from the same
 * module the POS imports, so what is auditioned here is what happens there. A
 * preview that could drift from the thing it previews would be worse than none.
 *
 * They also work while the setting is OFF, deliberately — hearing it is how
 * somebody decides whether to turn it on, so gating the audition on the switch
 * would put the decision behind itself.
 */
export default function ScanSoundPanel({ scanSounds }: { scanSounds: boolean }) {
  const toast = useToast()
  const [on, setOn] = useState(scanSounds)
  const [pending, startTransition] = useTransition()

  const dirty = on !== scanSounds

  function save() {
    startTransition(async () => {
      const result = await setScanSoundsAction(on)
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
        title="Scan sounds at the till"
        description="Whether ringing something up makes a noise, and a different one when nothing matched."
      />
      <CardBody>
        <div className="flex flex-wrap items-center gap-4">
          <Checkbox
            label="Beep when a product is rung up"
            checked={on}
            onChange={(e) => setOn(e.target.checked)}
          />
          <Button variant="primary" onClick={save} disabled={!dirty || pending}>
            Save
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-3 pt-4">
          <span className="text-sm text-muted">Hear them:</span>
          {/* type="button" on both: they sit inside a Card, and a stray submit
              would reload the screen instead of playing anything. */}
          <Button variant="secondary" type="button" onClick={() => scanOk()}>
            <Icons.Sound size={15} />
            Scanned
          </Button>
          <Button variant="secondary" type="button" onClick={() => scanFailed()}>
            <Icons.Sound size={15} />
            Not found
          </Button>
        </div>

        <p className="pt-3 text-sm text-muted">
          The one that matters is the second. A cashier working through a trolley watches the
          goods and the customer, not the screen — so a barcode that did not match puts a search
          panel in front of somebody who never looks at it, and the item goes into the bag
          unscanned. The noise is the only feedback that reaches them.
        </p>
        <p className="pt-2 text-sm text-muted">
          Retail and hospitality tills only. A trade counter rings items up across a desk at a
          pace where every line is read, so it stays silent whatever this is set to.
        </p>
      </CardBody>
    </Card>
  )
}
