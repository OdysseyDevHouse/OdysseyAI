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
   */
  status: 'idle' | 'checking' | 'up-to-date' | 'downloading' | 'downloaded' | 'error'
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
    default:
      return 'Not checked yet'
  }
}
