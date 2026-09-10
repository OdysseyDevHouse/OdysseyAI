'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  Field,
  Select,
  Switch,
  TextLink,
  useToast,
} from '@/components/ui'
import { saveJobSettingsAction } from '../../actions'
import {
  STOCK_WARN_MODES,
  STOCK_WARN_LABEL,
  STOCK_WARN_HINT,
  type StockWarnMode,
} from '@/lib/jobStatusModel'

/**
 * How parts get onto a job.
 *
 * Two settings, and they are a pair: what happens when a job asks for more of a
 * part than the shop holds, and whether the job moves itself out of the way while
 * it waits. Both answer "what does this business do about a part it has not got",
 * which is why they read together rather than as two switches in a list of
 * twenty-two.
 */
export default function PartsStockPanel({
  stockWarnMode: initialWarnMode,
  autoAwaitingParts: initialAwaitingParts,
  awaitingPartsStage,
}: {
  /** What happens when a job asks for more of a part than the shop has (§26.7). */
  stockWarnMode: string
  /** Whether a job moves itself in and out of Awaiting Parts (§28). */
  autoAwaitingParts: boolean
  /**
   * The name of the stage with code 'parts', or null if this shop has none.
   *
   * The switch below moves a job to that stage, which is found by CODE rather
   * than by role — waiting for a part is not one of the six required roles, so a
   * shop that deleted or deactivated the seeded status has nowhere for the
   * switch to move anything. That is a real state, not an error, and the switch
   * then silently does nothing: the same class of silent failure the cron
   * warnings exist for, so it is reported the same way.
   *
   * The NAME rather than a boolean, because a shop that renamed it to "Waiting
   * on supplier" should see its own word confirmed back.
   */
  awaitingPartsStage: string | null
}) {
  const router = useRouter()
  const toast = useToast()
  const [pending, start] = useTransition()

  const [warnMode, setWarnMode] = useState(initialWarnMode)
  const [awaitingParts, setAwaitingParts] = useState(initialAwaitingParts)

  function save() {
    start(async () => {
      // Only the two keys this screen owns. See the action for why a patch.
      const result = await saveJobSettingsAction({
        stockWarnMode: warnMode,
        autoAwaitingParts: awaitingParts,
      })
      if (result.ok) {
        toast.success(result.message)
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  return (
    <Card>
      <CardHeader
        title="Parts and stock"
        description="How parts and stock get onto a job, and what happens when the shelf is empty."
        action={
          <Button onClick={save} disabled={pending}>
            {pending ? 'Saving…' : 'Save'}
          </Button>
        }
      />
      <CardBody>
        <div className="space-y-3">
          <Field
            label="When a job needs more of a part than the shop has"
            hint="The shelf still has the last word: none of these can conjure stock that is not there."
          >
            <Select
              value={warnMode}
              onChange={(e) => setWarnMode(e.target.value)}
              disabled={pending}
              className="max-w-[20rem]"
            >
              {STOCK_WARN_MODES.map((m) => (
                <option key={m} value={m}>
                  {STOCK_WARN_LABEL[m]}
                </option>
              ))}
            </Select>
          </Field>
          {/* The chosen mode explains itself, rather than four hints stacked
              up where three of them are always wrong. */}
          <p className="text-xs text-muted">
            {
              STOCK_WARN_HINT[
                (warnMode as StockWarnMode) in STOCK_WARN_LABEL
                  ? (warnMode as StockWarnMode)
                  : 'inform'
              ]
            }
          </p>

          <div className="border-t border-border pt-5">
            <Switch
              checked={awaitingParts}
              onChange={setAwaitingParts}
              label="Move a job to Awaiting Parts by itself"
              hint="In when somebody asks for a part, and back out once every request is settled. A job that could only leave by hand would be a trap."
            />
            {/* Not a Callout either way: this is a consequence of the switch
                immediately above it, and reads as that switch's own footnote. */}
            {awaitingParts &&
              (awaitingPartsStage ? (
                /* The shop's OWN name for the stage, confirmed back: a business
                   that renamed it to "Waiting on supplier" would otherwise have
                   to take on trust that this switch means the same stage. */
                <p className="mt-1.5 text-xs text-muted">
                  Jobs move to <span className="text-ink-2">{awaitingPartsStage}</span>, and back
                  out once every request is settled.
                </p>
              ) : (
                <p className="mt-1.5 text-xs text-warning">
                  This shop has no Awaiting Parts stage, so nothing will move. Restore one under{' '}
                  <TextLink href="/jobs/setup/statuses">Statuses</TextLink>.
                </p>
              ))}
          </div>
        </div>
      </CardBody>
    </Card>
  )
}
