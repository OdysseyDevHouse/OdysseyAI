/**
 * The Electron shell's update bridge, as the browser sees it.
 *
 * ── ITS OWN NARROW TYPE, LIKE ITS NEIGHBOURS ────────────────────────────────
 *
 * appRole.ts and deviceId.ts each declare the slice of `window.odyssey` they
 * use rather than sharing one big declaration, and this follows them. A single
 * global interface would make every one of these files a reason to edit the
 * others, and would quietly assert that a bridge exists on builds where it does
 * not.
 *
 * Everything here answers undefined in a browser. That is the ordinary case,
 * not an error: the web build is served rather than installed, so there is
 * nothing on it to update, and the screen says exactly that.
 */

/** What `updater.snapshot()` in the shell returns. */
export type UpdateState = {
  /**
   * idle       nothing has happened yet this session
   * checking   a check is in flight
   * up-to-date the feed answered and this version is current
   * downloading
   * downloaded staged, waiting for a restart
   * error      the last check or download failed; `error` says why
   * held       automatic updates are off for this device and no booked window
   *            has come round, so the machine deliberately did nothing
   */
  status: 'idle' | 'checking' | 'up-to-date' | 'downloading' | 'downloaded' | 'error' | 'held'
  message: string | null
  availableVersion: string | null
  percent: number
  lastCheckedAt: string | null
  error: string | null
  currentVersion: string
  channel: string
  feedUrl: string | null
  /**
   * Whether this build has a release feed at all.
   *
   * Distinct from every status: a dev checkout and a machine that simply has
   * not checked yet are both `idle`, and only one of them has anything to say
   * for itself.
   */
  configured: boolean
  /**
   * Whether this device updates itself.
   *
   * Set in Control Panel v2 → Releases, never on the machine — the whole point
   * is that a large customer's estate is governed centrally. The screen shows it
   * read-only so somebody standing at a quiet machine can see that it is quiet
   * ON PURPOSE, which is the difference between this and a broken updater.
   */
  autoUpdate: boolean
  /**
   * The booked window, as the wall clock somebody typed, or null.
   *
   * A START time, not a deadline: a held-back machine does not pre-download, so
   * the window covers the download too and a slow line can put the restart some
   * minutes past it. Worded that way wherever it is shown.
   */
  scheduledAt: string | null
}

type UpdatesBridge = {
  state: () => Promise<UpdateState>
  check: () => Promise<UpdateState>
  install: () => Promise<{ ok: boolean; error?: string }>
}

type OdysseyBridge = {
  isDesktop?: boolean
  updates?: UpdatesBridge
}

function bridge(): OdysseyBridge | undefined {
  if (typeof window === 'undefined') return undefined
  return (window as unknown as { odyssey?: OdysseyBridge }).odyssey
}

/**
 * The bridge, or undefined in a browser and during SSR.
 *
 * Callers branch on this rather than on `isDesktop`, because the question that
 * matters is "can I actually call these verbs" — and a desktop build cut before
 * this feature existed answers true to the first and undefined to the second.
 */
export function updatesBridge(): UpdatesBridge | undefined {
  return bridge()?.updates
}

/** Is this a desktop install at all? Used only to word the empty state. */
export function isDesktopShell(): boolean {
  return Boolean(bridge()?.isDesktop)
}

/**
 * How a status reads to a person standing at the machine.
 *
 * Kept here rather than in the component so the wording is in one place — the
 * screen shows it twice, in the headline and on the button, and two copies
 * drift.
 */
export function statusLabel(state: UpdateState): string {
  switch (state.status) {
    case 'checking':
      return 'Checking…'
    case 'downloading':
      return `Downloading ${state.availableVersion ?? ''}`.trim()
    case 'downloaded':
      return `Version ${state.availableVersion ?? ''} is ready to install`.trim()
    case 'up-to-date':
      return 'Up to date'
    case 'error':
      return 'Last check failed'
    case 'held':
      /* Deliberately not "Up to date" — a held-back machine usually is NOT, and
         saying so would hide exactly the fact somebody is looking for. */
      return state.scheduledAt ? 'Waiting for its scheduled update' : 'Updates are managed for you'
    default:
      return 'Not checked yet'
  }
}
