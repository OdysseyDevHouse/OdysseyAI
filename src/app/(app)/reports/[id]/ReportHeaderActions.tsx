'use client'

import { useState } from 'react'
import { Button, ButtonLink, Icons } from '@/components/ui'
import type { PeriodKey } from '@/lib/reportBuilder/spec'
import ScheduleModal from '../schedules/ScheduleModal'

/**
 * Schedule and Customise, in the PAGE header rather than the report card's own
 * toolbar.
 *
 * ── WHY THESE TWO AND NOT THE REST ───────────────────────────────────────
 *
 * Everything left in the card's toolbar answers "what am I looking at": the
 * period, the columns, the banding, the table/chart switch, and Export, which
 * hands you the thing on screen. Those belong ON the card because they describe
 * its contents.
 *
 * These two do not. Customise leaves for the builder, and Schedule sets up a
 * mail that will arrive at 06:00 whether or not anyone opens this screen. They
 * are things you do ABOUT the report, not to the view — which is what the page
 * header's action corner is for, and where every other screen in the app already
 * puts its leave-this-page actions.
 *
 * ── WHY A CLIENT COMPONENT ───────────────────────────────────────────────
 *
 * The page is a server component and cannot hold the modal's open state. Rather
 * than push the whole header into the client, the two buttons and the dialog
 * they own travel together as one small island the server page slots in.
 */
export default function ReportHeaderActions({
  reportId,
  reportName,
  savedId,
  periodKey,
  canBuild,
  canSchedule,
  scheduleUsers,
}: {
  reportId: string
  reportName: string
  /** A saved report is EDITED in the builder; a built-in is COPIED into one. */
  savedId: number | null
  periodKey: PeriodKey
  canBuild: boolean
  canSchedule: boolean
  scheduleUsers: { id: number; name: string; email: string }[]
}) {
  const [scheduling, setScheduling] = useState(false)

  // Neither permission: render nothing at all rather than an empty flex box,
  // which would still take the header's `gap-4` and pull the title off-centre.
  if (!canSchedule && !canBuild) return null

  return (
    <>
      {canSchedule && (
        <Button variant="ghost" onClick={() => setScheduling(true)}>
          <Icons.Clock size={16} />
          Schedule
        </Button>
      )}

      {canBuild && (
        <ButtonLink
          href={
            savedId
              ? `/reports/builder?saved=${savedId}`
              : `/reports/builder?from=${encodeURIComponent(reportId)}`
          }
          variant="secondary"
        >
          <Icons.Pencil size={16} />
          {savedId ? 'Edit' : 'Customise'}
        </ButtonLink>
      )}

      {scheduling && (
        <ScheduleModal
          reportId={reportId}
          reportName={reportName}
          defaultPeriod={periodKey}
          users={scheduleUsers}
          onClose={() => setScheduling(false)}
        />
      )}
    </>
  )
}
