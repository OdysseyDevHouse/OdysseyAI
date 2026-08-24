'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Badge,
  Button,
  Card,
  CardHeader,
  ConfirmModal,
  EmptyState,
  Field,
  Icons,
  Modal,
  Select,
  useToast,
} from '@/components/ui'
import { deviceId, deviceLabel } from '@/lib/deviceId'
import type { LicenceSpot, PaidSlots } from '@/lib/control/devices'
import type { Terminal } from '@/lib/site/terminals'
import { releaseLicenceAction, linkDeviceAction } from './actions'

/**
 * The shop's till licences, and which machine uses each.
 *
 * ── THIS IS WHERE A TILL IS RE-ARRANGED ─────────────────────────────────────
 *
 * Not the only place one is set up, any more. A machine at the refusal screen
 * can now put ITSELF into service, but only within what the shop already has: a
 * paid licence that is free, or one thirty-day trial per machine. That covers
 * the shop starting out, which used to arrive here to find an empty panel.
 *
 * What still belongs here is everything that COSTS something or takes something
 * away — unlinking a machine that is trading, deciding which of two tills keeps
 * the last licence, reading which spot has not been seen for a month. A cashier
 * must not be able to do any of that from the counter, which is why the panel is
 * behind `setup.edit` and the door is not.
 *
 * The counts at the top are the part a manager actually comes for: when every
 * paid licence is in use, the till that will not start is waiting on somebody
 * unlinking one here.
 *
 * ── A LICENCE AND A TILL ARE DIFFERENT THINGS ───────────────────────────────
 *
 * A LICENCE (`cp2_devices`, control database) is what Odyssey sold: the shop
 * cannot create one, cannot mark it paid, cannot extend a trial.
 * A TILL (`terminals`, the shop's own database) is master data the shop owns:
 * "Front counter", its number, its own invoice sequence.
 *
 * Linking sets both at once, because a licensed machine with no till numbers its
 * invoices from the shop-wide sequence instead of its own — a fault nobody
 * notices until an accountant reads the numbering months later.
 */
export default function LicencesPanel({
  licences,
  slots,
  terminals,
}: {
  licences: LicenceSpot[]
  /**
   * What the shop pays for, and how much of it is spoken for.
   *
   * The list below cannot answer this on its own: a trial row and a paid row sit
   * in it looking alike, and the question a manager arrives with — "why will
   * this machine not start" — is usually answered by the count rather than by
   * any single row. Trials are deliberately outside it; they are not billed.
   */
  slots: PaidSlots
  /** The shop's registered tills, for the picker when linking. */
  terminals: Terminal[]
}) {
  const router = useRouter()
  const toast = useToast()
  const [pending, startTransition] = useTransition()
  const [releasing, setReleasing] = useState<LicenceSpot | null>(null)
  const [linking, setLinking] = useState<LicenceSpot | null>(null)
  const [terminalChoice, setTerminalChoice] = useState('')

  /* Resolved after mount rather than during render: the id lives in
     localStorage or the Electron shell, so the server cannot see it and reading
     it during render would mismatch hydration. */
  const [me, setMe] = useState<{ id: string | null; label: string; ready: boolean }>({
    id: null,
    label: '',
    ready: false,
  })
  useEffect(() => {
    setMe({ id: deviceId(), label: deviceLabel(), ready: true })
  }, [])

  function link() {
    if (!linking || !terminalChoice) return
    startTransition(async () => {
      const result = await linkDeviceAction(
        linking.deviceRowId,
        Number(terminalChoice),
        me.id ?? '',
        me.label,
      )
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(result.message)
      setLinking(null)
      setTerminalChoice('')
      router.refresh()
    })
  }

  function release(spot: LicenceSpot) {
    startTransition(async () => {
      const result = await releaseLicenceAction(spot.deviceRowId)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(result.message)
      setReleasing(null)
      router.refresh()
    })
  }

  const entitled = (s: LicenceSpot) => s.status === 'active' && (s.isPaid || trialLive(s))
  /* Live trials only. A lapsed one is not "on trial", it is a row waiting to be
     retired, and counting it would inflate a figure whose whole job is to say
     how much is trading right now. */
  const trialCount = licences.filter((s) => s.status === 'active' && !s.isPaid && trialLive(s)).length

  return (
    <Card>
      <CardHeader
        icon={<Icons.ShieldCheck size={16} />}
        title="Till licences"
        description="What this shop is licensed for, and which machine uses each one."
      />

      {/* WHAT THIS SHOP IS ENTITLED TO, in the two numbers that decide it.

          Paid and trial are counted SEPARATELY and never added up, because they
          answer different questions. The paid figure is the cap: nothing new can
          be put into service until it has room, and the fix for that is an
          Unlink on this screen. A trial is outside the cap entirely — it costs
          nothing, so it can never be the reason a paid licence is unavailable,
          and totalling the two would make it look as though it were. */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-1 border-b border-border px-4 py-3 text-[13px]">
        <span className="text-ink-2">
          <span className="numeric font-semibold text-ink">
            {slots.inUse} of {slots.paidFor}
          </span>{' '}
          {slots.paidFor === 1 ? 'licence' : 'licences'} you pay for
          {slots.free > 0 && (
            <span className="text-success-ink"> · {slots.free} free</span>
          )}
        </span>
        {trialCount > 0 && (
          <span className="text-muted">
            <span className="numeric font-semibold text-ink">{trialCount}</span> on trial, not
            billed
          </span>
        )}
        {slots.paidFor > 0 && slots.free === 0 && (
          <span className="text-warning-ink">
            All in use — unlink one below to free it for another machine.
          </span>
        )}
      </div>

      {/* WHICH MACHINE AM I? The number support asks for, and the thing the
          buttons below are about — "use this machine" is meaningless if you
          cannot tell which machine you are on.

          TINTED, unlike the licence rows below it. This is a statement about the
          browser you are sitting at rather than one of the shop's licences, and
          the band is what stops it reading as a third row in that list. */}
      <div className="flex items-center gap-3 border-b border-border bg-brand-soft/40 px-4 py-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-control bg-brand-soft text-brand">
          <Icons.Terminal size={16} />
        </span>
        <div className="min-w-0">
          <span className="block text-xs font-semibold uppercase tracking-wide text-muted">
            This machine
          </span>
          {/* NOTHING until the browser has been asked.
              The id lives in localStorage, so the server renders null and the
              client renders a UUID — printing a placeholder in the meantime makes
              the two markups differ, which is a hydration mismatch and takes the
              whole page down with it. (It did exactly that.) An empty line for one
              frame is invisible; a broken page is not. */}
          <div className="mt-0.5 flex min-h-[1.25rem] flex-wrap items-baseline gap-x-2 gap-y-1">
            {me.ready && (
              <>
                <code className="select-all break-all text-[13px] text-ink">
                  {me.id ?? 'No device number — storage is blocked in this browser'}
                </code>
                {me.label && <span className="text-[13px] text-muted">· {me.label}</span>}
              </>
            )}
          </div>
        </div>
      </div>

      {licences.length === 0 ? (
        <EmptyState
          icon={<Icons.StatusWarning size={26} />}
          title="No till licences"
          hint="Nothing has been registered yet. Open the till on the machine you want to use and it can start a 30-day trial itself, or contact Odyssey to buy licences."
        />
      ) : (
        <div className="flex flex-col divide-y divide-border">
          {licences.map((spot) => {
            /* `ready` gates this for the same reason the block above is gated:
               the server cannot know which machine this is, so anything keyed on
               it must render identically on both sides until the effect runs. */
            const isThis = me.ready && !!me.id && spot.serial === me.id
            const till = terminals.find((t) => t.id === spot.terminalId)
            return (
              <div key={spot.deviceRowId} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-semibold text-ink">
                      {spot.name || `Licence ${spot.deviceRowId}`}
                    </span>
                    {isThis && <Badge tone="brand">This machine</Badge>}
                    <LicenceBadge spot={spot} />
                  </div>
                  <p className="mt-0.5 truncate text-[13px] text-muted">
                    {spot.serial
                      ? `${till ? `${till.code} — ${till.name}` : 'No till chosen'} · last seen ${lastSeen(spot.lastSeenAt)}`
                      : 'Not linked to a machine yet'}
                  </p>

                  {/* ── THE LICENCE AND THE TILL POINT AT DIFFERENT MACHINES ──
                      Nothing in the current UI can create this — linking sets
                      both at once — but older data can, and so can a row edited
                      by hand. It is worth saying out loud because the symptom is
                      otherwise baffling: the screen reads "linked", and the till
                      still refuses to open, because the till checks the LICENCE
                      and the licence belongs to a machine that is not this one.

                      Gated on `me.ready` so it renders only once the browser has
                      been asked what it is. Server-side `me.id` is null, and a
                      warning that appears in the server markup and vanishes on
                      the client is a hydration mismatch. */}
                  {/* NAMES WHICH machine, or says there is none.
                      The old wording said "a different machine" in BOTH cases,
                      and the commoner case by far is that the till has NO device
                      on it at all — `null !== serial` is true, so an empty field
                      was reported as a rival machine. Somebody then reads "POS1
                      is this machine" and "registered to a different machine" on
                      one row, with nothing on the screen naming the other one,
                      because there isn't one. (Reported exactly that way.) */}
                  {me.ready && spot.serial && till && till.deviceId !== spot.serial && (
                    <p className="mt-1 text-[13px] text-danger">
                      {till.deviceId ? (
                        <>
                          {till.code} is registered to{' '}
                          <b className="font-semibold">
                            {terminalHolder(till.deviceId, licences) ?? till.deviceLabel ?? 'another machine'}
                          </b>
                          {' '}({till.deviceId.slice(0, 8)}…), not to this licence, so the till
                          will be refused. Re-link it from the machine that should be using it.
                        </>
                      ) : (
                        <>
                          {till.code} has no machine registered to it — this licence names it,
                          but the till itself is still unclaimed, so it will be refused.
                          Press <b className="font-semibold">Unlink</b> and then{' '}
                          <b className="font-semibold">Use this machine</b> to set both together.
                        </>
                      )}
                    </p>
                  )}
                </div>

                {/* Linkable only when the licence can actually trade. Offering a
                    machine an expired licence would walk it into a refusal. */}
                {!spot.serial && entitled(spot) && (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={pending || !me.ready || !me.id || terminals.length === 0}
                    onClick={() => {
                      setLinking(spot)
                      setTerminalChoice(terminals[0] ? String(terminals[0].id) : '')
                    }}
                  >
                    Use this machine
                  </Button>
                )}

                {spot.serial && (
                  <Button
                    variant="danger-ghost"
                    size="sm"
                    disabled={pending}
                    onClick={() => setReleasing(spot)}
                  >
                    Unlink
                  </Button>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Which till this machine rings up as. Asked at the same moment as the
          licence, because a licensed machine with no till numbers its invoices
          from the wrong sequence. */}
      <Modal
        open={linking !== null}
        onClose={() => setLinking(null)}
        title="Use this machine as a till"
        description={
          linking
            ? `Links this browser to the “${linking.name}” licence. It can then ring up sales.`
            : ''
        }
        size="sm"
        footer={
          <>
            <Button variant="secondary" size="md" disabled={pending} onClick={() => setLinking(null)}>
              Cancel
            </Button>
            <Button variant="primary" size="md" disabled={pending || !terminalChoice} onClick={link}>
              {pending ? 'Linking…' : 'Link this machine'}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Field
            label="Ring up as"
            hint="The till a sale is recorded against. Each one keeps its own invoice numbering."
          >
            <Select value={terminalChoice} onChange={(e) => setTerminalChoice(e.target.value)}>
              {terminals.map((t) => (
                <option key={t.id} value={String(t.id)}>
                  {t.code} — {t.name}
                </option>
              ))}
            </Select>
          </Field>
          {terminals.length === 0 && (
            <p className="text-[13px] text-danger">
              Register a till first, under Tills above — a licence has to ring up as one.
            </p>
          )}
        </div>
      </Modal>

      <ConfirmModal
        open={releasing !== null}
        title="Unlink this machine?"
        confirmLabel="Unlink it"
        tone="danger"
        message={
          releasing && releasing.serial === me.id
            ? 'This is the machine you are using. It will no longer be able to open the till until it is linked again.'
            : 'The machine currently using this licence will no longer be able to open the till. Another machine can then be linked to it.'
        }
        onClose={() => setReleasing(null)}
        onConfirm={() => releasing && release(releasing)}
      />
    </Card>
  )
}

/** Is an unpaid licence still inside its evaluation period? */
function trialLive(spot: LicenceSpot): boolean {
  return !!spot.expiryDate && spot.expiryDate >= new Date().toISOString().slice(0, 10)
}

/** Paid, on trial, or not entitled — the state that decides whether it trades. */
/**
 * The NAME of whichever machine holds a device id.
 *
 * The refusal above used to say "a different machine" and stop there, which is
 * the one thing a person reading it already knows. What they need is WHICH —
 * and the licence list on this very screen has the answer, because every
 * licensed machine appears in it with the name it was given ("POS1", "POS2").
 *
 * Returns null when the id matches no licence at all. That is a real state
 * rather than a lookup failure: a machine can claim a till without ever having
 * been licensed, and saying "another machine" is then the honest answer — so
 * the caller falls back to the till's own `deviceLabel`, then to that phrase.
 */
function terminalHolder(deviceId: string, licences: LicenceSpot[]): string | null {
  const holder = licences.find((l) => l.serial === deviceId)
  return holder?.name?.trim() || null
}

function LicenceBadge({ spot }: { spot: LicenceSpot }) {
  if (spot.status !== 'active') return <Badge tone="neutral">Retired</Badge>
  if (spot.isPaid) return <Badge tone="success">Licensed</Badge>
  if (spot.expiryDate) {
    return trialLive(spot) ? (
      <Badge tone="warning">Trial to {spot.expiryDate}</Badge>
    ) : (
      <Badge tone="danger">Trial ended</Badge>
    )
  }
  return <Badge tone="danger">No licence</Badge>
}

/** "today", "3 days ago" — enough to spot the dead machine in a list. */
function lastSeen(at: Date | string | null): string {
  if (!at) return 'never'
  const then = typeof at === 'string' ? Date.parse(at) : at.getTime()
  if (!Number.isFinite(then)) return 'never'
  const days = Math.floor((Date.now() - then) / 86_400_000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  return `${days} days ago`
}
