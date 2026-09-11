'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Badge,
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Icons,
  SummaryList,
  SummaryRow,
  ConfirmModal,
  useToast,
} from '@/components/ui'
import { isDesktopShell, statusLabel, updatesBridge, type UpdateState } from '@/lib/updates'

/**
 * Updates, for the person standing at the machine.
 *
 * ── WHY A SCREEN EXISTS AT ALL ──────────────────────────────────────────────
 *
 * The updater is built to be invisible: it checks every four hours and applies
 * what it finds when somebody closes the app, so a shop never thinks about it.
 * That is right for a shop and wrong for a technician, who has just published a
 * fix, is standing at the counter, and has no way to make it arrive except to
 * wait up to four hours or close and reopen the app and hope.
 *
 * So this screen answers two questions the background timer cannot: "what is
 * this machine actually running", and "get it now".
 *
 * ── IT DRIVES THE SAME UPDATER, NOT A SECOND ONE ────────────────────────────
 *
 * Every button here calls the same functions the timer calls, and reads the
 * same state object those events write. A screen with its own idea of progress
 * would open blank over a download already in flight, and its Check button
 * would start a second one. See the note on `state` in electron/updater.js.
 */
export default function UpdatesClient() {
  const toast = useToast()
  const [state, setState] = useState<UpdateState | null>(null)
  const [checking, setChecking] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [unavailable, setUnavailable] = useState(false)

  /* Held in a ref so the poll below can stop itself without being torn down and
     rebuilt every time the state it is polling for changes. */
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const read = useCallback(async () => {
    const bridge = updatesBridge()
    if (!bridge) {
      setUnavailable(true)
      return null
    }
    try {
      const next = await bridge.state()
      setState(next)
      return next
    } catch {
      /* The bridge exists but the main process refused. Rare enough that a
         message would be noise; the screen simply keeps what it had. */
      return null
    }
  }, [])

  useEffect(() => {
    void read()
  }, [read])

  /* ── POLLED, BECAUSE PROGRESS ARRIVES IN THE MAIN PROCESS ──────────────────
   *
   * download-progress fires in the shell, not here, and pushing each tick over
   * IPC would mean a channel this screen has to be listening on before the
   * download starts — which it usually is not, because the timer starts most of
   * them. Asking twice a second while something is moving is cheaper than that
   * and cannot miss a download already in flight when the screen opened.
   *
   * It stops the moment nothing is moving, so an idle screen costs nothing. */
  useEffect(() => {
    const moving = state?.status === 'checking' || state?.status === 'downloading'
    if (!moving) {
      if (pollRef.current) {
        clearInterval(pollRef.current)
        pollRef.current = null
      }
      return
    }
    if (pollRef.current) return
    pollRef.current = setInterval(() => void read(), 500)
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current)
        pollRef.current = null
      }
    }
  }, [state?.status, read])

  async function check() {
    const bridge = updatesBridge()
    if (!bridge) return
    setChecking(true)
    try {
      const next = await bridge.check()
      setState(next)
      /* Every outcome gets a toast, including "nothing to do". Somebody pressed
         a button and is owed an answer — silence reads as a broken button, and
         "you are already current" is a perfectly good answer. */
      if (next.status === 'error') toast.error(next.error || 'Could not check for updates.')
      else if (next.status === 'up-to-date') toast.info(`Odyssey ${next.currentVersion} is up to date.`)
      else if (next.status === 'downloaded') toast.success(`Version ${next.availableVersion} is ready to install.`)
      else if (next.availableVersion) toast.success(`Downloading version ${next.availableVersion}…`)
    } catch {
      toast.error('Could not check for updates.')
    } finally {
      setChecking(false)
    }
  }

  async function install() {
    const bridge = updatesBridge()
    if (!bridge) return
    setInstalling(true)
    try {
      const result = await bridge.install()
      if (!result.ok) {
        toast.error(result.error || 'Could not install the update.')
        setInstalling(false)
        setConfirming(false)
        return
      }
      /* Deliberately left in the installing state with no success toast: the
         app is closing behind this. A toast nobody can read, followed by a
         window vanishing, looks like a crash — the disabled button and its
         label are the honest last thing on screen. */
      setConfirming(false)
    } catch {
      toast.error('Could not install the update.')
      setInstalling(false)
      setConfirming(false)
    }
  }

  if (unavailable) {
    return (
      <Card>
        <CardBody>
          <EmptyState
            icon={<Icons.Online />}
            title={isDesktopShell() ? 'This build cannot update itself' : 'Odyssey is running in a browser'}
            hint={
              isDesktopShell()
                ? 'It was installed before automatic updates existed. Reinstall from the current installer and it will keep itself current from then on.'
                : 'This copy is served from a server rather than installed on this machine, so there is nothing here to update. Open this screen on a desktop install to check its version.'
            }
          />
        </CardBody>
      </Card>
    )
  }

  if (!state) {
    return (
      <Card>
        <CardBody>
          <p className="text-muted">Reading this machine's version…</p>
        </CardBody>
      </Card>
    )
  }

  const busy = checking || state.status === 'checking' || state.status === 'downloading'
  const ready = state.status === 'downloaded'

  return (
    <>
      <Card>
        <CardHeader
          title="This machine"
          description="What it is running now, and where it looks for new versions."
        />
        <CardBody className="space-y-5">
          {/* The loudest thing on the screen is the answer to "is there an
              update", so it leads — and it is the only place colour is spent. */}
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="space-y-1">
              <p className="text-2xl font-semibold text-ink">
                Version <span className="numeric">{state.currentVersion}</span>
              </p>
              <p className="text-sm text-muted">{statusLabel(state)}</p>
            </div>
            <StatusBadge state={state} />
          </div>

          {state.status === 'downloading' && (
            <div className="space-y-1.5">
              <div className="h-2 w-full overflow-hidden rounded-pill bg-surface-2">
                <div
                  className="h-full rounded-pill bg-brand transition-[width] duration-300"
                  style={{ width: `${Math.max(2, state.percent)}%` }}
                />
              </div>
              <p className="numeric text-xs text-muted">{state.percent}%</p>
            </div>
          )}

          {ready && (
            <Callout tone="success" title={`Version ${state.availableVersion} is downloaded`}>
              It installs automatically the next time this app is closed. Install it now only if
              nobody is mid-sale or mid-invoice on this machine — the app closes and reopens.
            </Callout>
          )}

          {state.status === 'error' && state.error && (
            <Callout tone="warning" title="The last check did not complete">
              {state.error}
            </Callout>
          )}

          {/* ── A QUIET MACHINE HAS TO SAY WHY IT IS QUIET ─────────────────

              A held-back device never checks, downloads or installs, so every
              other signal on this screen reads exactly as it would on a broken
              updater: "Not checked yet", no version, nothing happening. Without
              this the technician standing at it has no way to tell a machine
              that is behaving as instructed from one that is failing, and the
              support call that follows is the one this feature would otherwise
              create rather than prevent. */}
          {!state.autoUpdate && (
            <Callout
              tone={state.scheduledAt ? 'brand' : 'warning'}
              title={
                state.scheduledAt
                  ? `Scheduled to update from ${formatScheduled(state.scheduledAt)}`
                  : 'Automatic updates are off for this machine'
              }
            >
              {state.scheduledAt ? (
                <>
                  This machine downloads and installs the newest version from that time,
                  then restarts on its own. It is a start time rather than a deadline — the
                  download happens then too, so a slow connection can push the restart a
                  few minutes later.
                </>
              ) : (
                <>
                  Nothing is scheduled, so this machine stays on the version it has —
                  including for security fixes. Ask support to book a time that suits you.
                </>
              )}
            </Callout>
          )}

          {!state.configured && (
            <Callout tone="warning" title="No update server is configured for this build">
              It was built without ODYSSEY_UPDATE_URL, so it cannot fetch new versions. Nothing on
              this machine is wrong — the installer it came from was built without the setting.
            </Callout>
          )}

          <div className="flex flex-wrap gap-3">
            {/* One primary per screen, and it is whichever action the moment
                calls for: install when something is staged, otherwise check. */}
            {ready ? (
              <Button
                variant="primary"
                onClick={() => setConfirming(true)}
                disabled={installing}
              >
                <Icons.Download />
                {installing ? 'Restarting…' : `Install ${state.availableVersion} and restart`}
              </Button>
            ) : (
              /* ── DISABLED, NOT HIDDEN, ON A HELD MACHINE ─────────────────

                 Pressing it would run the same gated check the timer runs and
                 return "held" without doing anything, which reads as a broken
                 button. Hiding it instead would remove the thing somebody came
                 to this screen to look for, leaving them to conclude the screen
                 itself is broken. Present and inert, with the callout above
                 saying why, is the only version that answers the question. */
              <Button
                variant="primary"
                onClick={check}
                disabled={busy || !state.configured || !state.autoUpdate}
              >
                <Icons.Refresh />
                {busy ? 'Checking…' : 'Check for updates'}
              </Button>
            )}
            {ready && (
              <Button variant="secondary" onClick={check} disabled={busy}>
                <Icons.Refresh />
                Check again
              </Button>
            )}
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Where updates come from"
          description="Support may ask for these when a machine is on an unexpected version."
        />
        <CardBody>
          <SummaryList>
            <SummaryRow label="Installed version" value={state.currentVersion} />
            <SummaryRow
              label="Release channel"
              value={state.channel === 'stable' ? 'Stable' : state.channel}
              /* Beta is the exception worth seeing at a glance — it is the
                 answer to "why is this machine on a version nobody else has". */
              tone={state.channel === 'stable' ? 'default' : 'warning'}
            />
            <SummaryRow
              label="Automatic updates"
              value={state.autoUpdate ? 'On' : 'Off — managed by support'}
              /* Off is the exception worth seeing at a glance, for the same
                 reason beta is on the row above: it is the answer to "why has
                 this machine not taken the fix everybody else has". */
              tone={state.autoUpdate ? 'default' : 'warning'}
            />
            {!state.autoUpdate && (
              <SummaryRow
                label="Scheduled update"
                value={state.scheduledAt ? formatScheduled(state.scheduledAt) : 'Nothing booked'}
                tone={state.scheduledAt ? 'default' : 'warning'}
              />
            )}
            <SummaryRow label="Last checked" value={formatChecked(state.lastCheckedAt)} />
            <SummaryRow label="Update server" value={state.feedUrl ?? 'Not configured'} />
          </SummaryList>
        </CardBody>
      </Card>

      <ConfirmModal
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={install}
        busy={installing}
        tone="primary"
        title={`Install version ${state.availableVersion} now?`}
        message={
          <>
            Odyssey will close and reopen on the new version. Anything unsaved on this machine is
            lost, and a sale in progress on a till is interrupted.
            <br />
            <br />
            If nobody is waiting, you can leave it — it installs on its own the next time this app
            is closed.
          </>
        }
        confirmLabel="Install and restart"
      />
    </>
  )
}

function StatusBadge({ state }: { state: UpdateState }) {
  if (!state.configured) return <Badge tone="warning">Not configured</Badge>
  if (state.status === 'downloaded') return <Badge tone="success">Ready to install</Badge>
  if (state.status === 'downloading') return <Badge tone="brand">Downloading</Badge>
  if (state.status === 'checking') return <Badge tone="brand">Checking</Badge>
  if (state.status === 'error') return <Badge tone="warning">Check failed</Badge>
  /* Before the up-to-date and idle answers below, because a held machine is
     usually NEITHER — it is sitting on an old version on purpose, and both of
     those badges would state the opposite. */
  if (state.status === 'held') {
    return <Badge tone={state.scheduledAt ? 'brand' : 'warning'}>
      {state.scheduledAt ? 'Scheduled' : 'Held back'}
    </Badge>
  }
  if (state.status === 'up-to-date') return <Badge tone="success">Current</Badge>
  return <Badge tone="neutral">Not checked</Badge>
}

/**
 * A booked window, as the person who booked it wrote it down.
 *
 * ── PARSED BY HAND, BECAUSE new Date() WOULD BE WRONG HERE ─────────────────
 *
 * The value is "2026-09-11 02:00:00" — a wall clock with no zone, which is
 * exactly what it should be: somebody chose two in the morning at the shop.
 * Passing that to new Date() gets an implementation-defined reading of a
 * non-ISO string, and appending a Z would declare it UTC and redraw a 02:00
 * window as 04:00 to the reader.
 *
 * Splitting the parts and building a LOCAL date keeps the number somebody
 * typed on the screen of the person reading it.
 */
function formatScheduled(value: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(value)
  if (!m) return value
  const at = new Date(
    Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]),
  )
  if (Number.isNaN(at.getTime())) return value
  return at.toLocaleString()
}

/**
 * When the feed last actually answered.
 *
 * "Never" rather than a dash, because the two mean different things here: a
 * machine that has never had an answer may have no line at all, and that is the
 * first thing worth knowing when somebody rings to ask why a fix has not
 * arrived.
 */
function formatChecked(value: string | null): string {
  if (!value) return 'Never this session'
  const at = new Date(value)
  if (Number.isNaN(at.getTime())) return 'Never this session'
  return at.toLocaleString()
}
