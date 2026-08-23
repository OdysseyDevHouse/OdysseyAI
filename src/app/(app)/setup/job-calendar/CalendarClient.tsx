'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Checkbox,
  EmptyState,
  Icons,
  useToast,
} from '@/components/ui'
import { TABLE, TABLE_TD, TABLE_TH } from '@/components/ui/styles'
import { PROVIDER_LABEL } from '@/lib/calendarModel'
import type { CalendarAccount, ProposedChange } from '@/lib/site/jobCalendar'
import { unlinkAction, setDirectionsAction, acceptAction, declineAction } from './actions'

/**
 * The linked accounts, and the queue of things somebody moved.
 *
 * ── THE QUEUE IS THE TOP HALF, DELIBERATELY ────────────────────────────────
 *
 * Accounts are configured once and then forgotten. Proposals are the part that
 * needs a person, and a proposal nobody sees is worse than no sync at all: the
 * technician believes the visit moved, Odyssey believes it did not, and the
 * customer finds out which is right.
 */
export default function CalendarClient({
  accounts,
  changes,
  providers,
}: {
  accounts: CalendarAccount[]
  changes: ProposedChange[]
  providers: { google: boolean; microsoft: boolean }
}) {
  const router = useRouter()
  const toast = useToast()
  const [pending, start] = useTransition()
  const [busy, setBusy] = useState<number | null>(null)

  const when = (d: Date) =>
    d.toLocaleString(undefined, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      // The stored value is a UTC wall clock; rendering it in the reader's
      // timezone would shift every visit by two hours in South Africa.
      timeZone: 'UTC',
    })

  function decide(id: number, accept: boolean) {
    setBusy(id)
    start(async () => {
      const result = accept ? await acceptAction(id) : await declineAction(id)
      setBusy(null)
      if (result.ok) {
        toast.success(accept ? 'The visit has been moved.' : 'The calendar will be put back.')
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  function unlink(account: CalendarAccount) {
    start(async () => {
      const result = await unlinkAction(account.id)
      if (result.ok) {
        toast.success(`${PROVIDER_LABEL[account.provider]} unlinked.`)
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  function setDirection(account: CalendarAccount, push: boolean, pull: boolean) {
    start(async () => {
      const result = await setDirectionsAction(account.id, push, pull)
      if (result.ok) router.refresh()
      else toast.error(result.error)
    })
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          title="Moved in a calendar"
          description="Somebody dragged a visit. Odyssey has not moved it — that is this decision."
        />
        <CardBody>
          {changes.length === 0 ? (
            <EmptyState
              icon={<Icons.Calendar />}
              title="Nothing waiting"
              hint="When somebody moves a job visit in their own calendar it appears here, rather than quietly rewriting the booking."
            />
          ) : (
            <table className={TABLE}>
              <thead>
                <tr>
                  <th className={TABLE_TH}>Job</th>
                  <th className={TABLE_TH}>Who</th>
                  <th className={TABLE_TH}>Was</th>
                  <th className={TABLE_TH}>Wants</th>
                  <th className={TABLE_TH} />
                </tr>
              </thead>
              <tbody>
                {changes.map((c) => (
                  <tr key={c.id}>
                    <td className={TABLE_TD}>
                      <div className="font-medium">{c.jobNumber ?? c.jobTitle}</div>
                      <div className="text-sm text-muted">{c.customerName ?? c.jobTitle}</div>
                    </td>
                    <td className={TABLE_TD}>{c.userName}</td>
                    <td className={`${TABLE_TD} text-muted`}>{when(c.previousStartsAt)}</td>
                    <td className={TABLE_TD}>
                      <div>{when(c.proposedStartsAt)}</div>
                      {/*
                        The appointment moved after the proposal was raised — a
                        dispatcher rescheduled it while the drag was waiting to
                        be read. Shown rather than hidden: accepting would
                        silently undo whatever they did, and the person deciding
                        needs to know that is the choice.
                      */}
                      {c.isStale && (
                        <Badge tone="warning">The visit has changed since</Badge>
                      )}
                    </td>
                    <td className={`${TABLE_TD} text-right whitespace-nowrap`}>
                      <Button
                        variant="ghost"
                        onClick={() => decide(c.id, true)}
                        disabled={pending || busy === c.id}
                      >
                        Move it
                      </Button>
                      <Button
                        variant="danger-ghost"
                        onClick={() => decide(c.id, false)}
                        disabled={pending || busy === c.id}
                      >
                        Put it back
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Linked calendars"
          description="Visits are written out. Busy time is read back, without titles."
          action={
            <div className="flex gap-2">
              {providers.google && (
                <Button
                  variant="secondary"
                  onClick={() => {
                    window.location.href = '/api/jobs/calendar/link?provider=google'
                  }}
                >
                  Link Google
                </Button>
              )}
              {providers.microsoft && (
                <Button
                  variant="secondary"
                  onClick={() => {
                    window.location.href = '/api/jobs/calendar/link?provider=microsoft'
                  }}
                >
                  Link Outlook
                </Button>
              )}
            </div>
          }
        />
        <CardBody>
          {accounts.length === 0 ? (
            <EmptyState
              icon={<Icons.Calendar />}
              title="No calendars linked"
              hint="Linking writes job visits into somebody's own calendar and reads back when they are busy — which stops the scheduler booking over a dentist appointment it cannot see."
            />
          ) : (
            <table className={TABLE}>
              <thead>
                <tr>
                  <th className={TABLE_TH}>Person</th>
                  <th className={TABLE_TH}>Account</th>
                  <th className={TABLE_TH}>Write visits out</th>
                  <th className={TABLE_TH}>Read busy time back</th>
                  <th className={TABLE_TH} />
                </tr>
              </thead>
              <tbody>
                {accounts.map((a) => (
                  <tr key={a.id}>
                    <td className={TABLE_TD}>
                      <div className="font-medium">{a.userName}</div>
                      <div className="text-sm text-muted">{PROVIDER_LABEL[a.provider]}</div>
                      {/*
                        Why this account stopped working, in words.

                        A refresh token dies when somebody changes their
                        password or revokes access, and the sync then fails
                        silently forever — the technician believing their
                        calendar is authoritative while it has been stale for a
                        month. So it is shown, here, next to the fix.
                      */}
                      {a.lastError && (
                        <div className="mt-1 text-sm text-danger">
                          {a.lastError} Link it again to fix this.
                        </div>
                      )}
                      {!a.lastError && !a.isUsable && (
                        <div className="mt-1 text-sm text-danger">
                          The stored access cannot be read. Link it again.
                        </div>
                      )}
                    </td>
                    <td className={`${TABLE_TD} text-muted`}>{a.accountEmail || '—'}</td>
                    <td className={TABLE_TD}>
                      <Checkbox
                        label=""
                        checked={a.pushEnabled}
                        disabled={pending}
                        onChange={(e) => setDirection(a, e.target.checked, a.pullEnabled)}
                      />
                    </td>
                    <td className={TABLE_TD}>
                      <Checkbox
                        label=""
                        checked={a.pullEnabled}
                        disabled={pending}
                        onChange={(e) => setDirection(a, a.pushEnabled, e.target.checked)}
                      />
                    </td>
                    <td className={`${TABLE_TD} text-right`}>
                      <Button
                        variant="danger-ghost"
                        onClick={() => unlink(a)}
                        disabled={pending}
                      >
                        Unlink
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <p className="mt-4 text-sm text-muted">
            The two switches are separate on purpose. Somebody may be glad to have work
            appear in their calendar and unwilling to let their employer read what else is
            in it — and what is read back is only when they are busy, never what they are
            doing.
          </p>
        </CardBody>
      </Card>
    </div>
  )
}
