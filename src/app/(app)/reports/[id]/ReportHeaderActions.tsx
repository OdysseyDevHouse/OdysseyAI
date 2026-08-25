'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Button, ButtonLink, ConfirmModal, Icons, useToast } from '@/components/ui'
import type { PeriodKey } from '@/lib/reportBuilder/spec'
import ScheduleModal from '../schedules/ScheduleModal'
import { deleteSavedReportAction } from '../actions'

/**
 * Schedule, Customise and Delete, in the PAGE header rather than the report
 * card's own toolbar.
 *
 * ── WHY THESE AND NOT THE REST ───────────────────────────────────────────
 *
 * Everything left in the card's toolbar answers "what am I looking at": the
 * period, the columns, the banding, the table/chart switch, and Export, which
 * hands you the thing on screen. Those belong ON the card because they describe
 * its contents.
 *
 * These do not. Customise leaves for the builder, Schedule sets up a mail that
 * will arrive at 06:00 whether or not anyone opens this screen, and Delete
 * removes the report for everybody. They are things you do ABOUT the report,
 * not to the view — which is what the page header's action corner is for, and
 * where every other screen in the app already puts its leave-this-page actions.
 *
 * ── DELETE IS ONLY EVER OFFERED ON A SAVED REPORT ────────────────────────
 *
 * A built-in has nothing to delete: it is a spec in the codebase, not a row,
 * and the nearest thing to removing one is a role that does not grant it. So
 * the button is gated on `savedId` as well as on `canBuild` — the same pairing
 * the Edit/Customise button uses to decide which of the two it is.
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
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [deleting, startDeleting] = useTransition()
  const router = useRouter()
  const toast = useToast()

  const canDelete = canBuild && savedId !== null

  function onDelete() {
    if (savedId === null) return
    startDeleting(async () => {
      const result = await deleteSavedReportAction(savedId)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      setConfirmingDelete(false)
      /* Says outright when a schedule went with it. The action returns the
         count precisely so this is not a silent side effect — somebody whose
         06:00 email stops arriving with no warning stops trusting the feature. */
      toast.success(
        result.schedulesRemoved > 0
          ? `Report deleted, and ${result.schedulesRemoved} schedule${
              result.schedulesRemoved === 1 ? '' : 's'
            } cancelled with it.`
          : 'Report deleted.',
      )
      /* Back to the hub, because the page we are on no longer has a report to
         show — staying would render a 404 for the thing just deleted. */
      router.push('/reports')
    })
  }

  // No permission for any of them: render nothing at all rather than an empty
  // flex box, which would still take the header's `gap-4` and pull the title
  // off-centre.
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

      {/* Last in the row, and ghost rather than a danger-coloured button: a
          destructive action needs to be findable, not prominent. The colour
          belongs on the confirm inside the dialog, where it applies to a
          decision actually being made. */}
      {canDelete && (
        <Button variant="ghost" onClick={() => setConfirmingDelete(true)}>
          <Icons.Trash size={16} />
          Delete
        </Button>
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

      <ConfirmModal
        open={confirmingDelete}
        onClose={() => setConfirmingDelete(false)}
        onConfirm={onDelete}
        busy={deleting}
        title="Delete this report?"
        confirmLabel="Delete report"
        message={
          <>
            <strong className="text-ink">{reportName}</strong> will be removed for
            everyone, along with any schedule that emails it. This cannot be undone.
          </>
        }
      />
    </>
  )
}
