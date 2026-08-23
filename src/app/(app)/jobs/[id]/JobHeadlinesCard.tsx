'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Badge, Button, Card, CardBody, CardHeader, Checkbox, useToast } from '@/components/ui'
import { applyHeadlinesAction } from '../actions'

/**
 * What kind of work this job is (§8).
 *
 * ── WHY THIS IS ITS OWN CARD NOW ───────────────────────────────────────────
 *
 * It used to live inside JobChecks, which 224 deleted along with the checklist.
 * Headlines themselves are not going anywhere — they are how a job says what
 * kind of work it is, they carry the standard parts, and they are what DECIDES
 * WHICH FORMS a job is asked for.
 *
 * That last part is why this could not be dropped with the screen that happened
 * to host it: removing the picker would leave a job unable to acquire a
 * headline, and therefore unable to acquire a form, which would quietly make
 * the whole of 222 unreachable from a job card.
 */
export default function JobHeadlinesCard({
  jobId,
  jobClosed,
  canEdit,
  headlines,
  selectedIds,
}: {
  jobId: number
  jobClosed: boolean
  canEdit: boolean
  headlines: { id: number; name: string; formCount: number }[]
  selectedIds: number[]
}) {
  const router = useRouter()
  const toast = useToast()
  const [pending, start] = useTransition()
  const [chosen, setChosen] = useState<number[]>(selectedIds)

  const editable = canEdit && !jobClosed
  // Compared as SETS rather than by length: swapping one headline for another
  // leaves the count identical and is very much a change.
  const dirty =
    chosen.length !== selectedIds.length || chosen.some((id) => !selectedIds.includes(id))

  function toggle(id: number, on: boolean) {
    setChosen((prev) => (on ? [...new Set([...prev, id])] : prev.filter((x) => x !== id)))
  }

  function save() {
    start(async () => {
      const result = await applyHeadlinesAction(jobId, chosen)
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
        title="What kind of work this is"
        description="Decides the standard parts, and which forms the job is asked to fill in."
        action={
          editable && dirty ? (
            <Button onClick={save} disabled={pending}>
              {pending ? 'Saving…' : 'Save'}
            </Button>
          ) : undefined
        }
      />
      <CardBody>
        {headlines.length === 0 ? (
          <p className="text-sm text-muted">
            No kinds of work are set up yet. Add them under Job cards → Setup → Workflow.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {headlines.map((h) => (
              <div key={h.id} className="flex items-center gap-2">
                <Checkbox
                  checked={chosen.includes(h.id)}
                  disabled={!editable || pending}
                  onChange={(e) => toggle(h.id, e.target.checked)}
                  label={h.name}
                />
                {/* Said on the row rather than only after saving, so somebody
                    ticking a headline knows it will ask for paperwork. */}
                {h.formCount > 0 && (
                  <Badge tone="neutral">
                    {h.formCount} {h.formCount === 1 ? 'form' : 'forms'}
                  </Badge>
                )}
              </div>
            ))}
          </div>
        )}
      </CardBody>
    </Card>
  )
}
