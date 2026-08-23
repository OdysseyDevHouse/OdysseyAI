'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  Field,
  Icons,
  NumberInput,
  useToast,
} from '@/components/ui'
import { saveTicketSettingsAction } from '../../actions'

/**
 * How many tickets one person may have running at once.
 *
 * ── WHY THIS IS A NUMBER AND NOT A SWITCH ──────────────────────────────────
 *
 * Job time carries a hard one-at-a-time rule enforced by the database, because
 * an hour billed to two customers cannot be recovered. Ticket time is never
 * billed, so the question here is about attention rather than money — "should
 * somebody be working three things at once" is a judgement each desk makes
 * differently, and a fixed rule would be wrong for most of them.
 *
 * 0 means no cap, and it is the default: a limit that switched itself on after
 * an update would start refusing work nobody asked it to refuse.
 */
export default function TicketSettingsPanel({ maxRunning }: { maxRunning: number }) {
  const router = useRouter()
  const toast = useToast()
  const [pending, start] = useTransition()
  const [value, setValue] = useState(maxRunning)

  function save() {
    start(async () => {
      const result = await saveTicketSettingsAction({ maxRunningPerUser: value })
      if (result.ok) {
        toast.success('Saved.')
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  return (
    <Card>
      <CardHeader
        title="Working on several at once"
        description="A running clock means somebody is on it. This decides how many they may have going."
      />
      <CardBody className="space-y-4">
        <Field
          label="Tickets one person may run at once"
          hint="0 means no limit. Somebody at the limit is refused a third, and told which two to stop."
        >
          <div className="flex items-center gap-2">
            <div className="w-24">
              <NumberInput
                value={value}
                onChange={(e) => setValue(Math.max(0, Number(e.target.value) || 0))}
                className="numeric w-24 text-right"
              />
            </div>
            <span className="text-sm text-muted">
              {value === 0 ? 'no limit' : value === 1 ? 'one at a time' : `up to ${value}`}
            </span>
          </div>
        </Field>

        {/* Said plainly, because lowering the number cannot stop a clock that is
            already running — and somebody who expected it to would be surprised
            a week later by a figure they cannot explain. */}
        <p className="text-xs text-muted">
          Lowering this does not stop clocks already running. Anybody over the new limit is listed
          on the reconciliation screen until they finish what they have.
        </p>

        <div className="flex justify-end">
          <Button variant="primary" size="sm" onClick={save} disabled={pending}>
            <Icons.Save size={14} />
            {pending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </CardBody>
    </Card>
  )
}
