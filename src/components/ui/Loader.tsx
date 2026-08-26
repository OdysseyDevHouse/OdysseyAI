import type { CSSProperties, ReactNode } from 'react'

/*
 * ── THE LOADERS ───────────────────────────────────────────────────────────
 *
 * Five of them, one family. Every rule that gives them their appearance lives
 * in the LOADING block of src/app/globals.css — keyframes, conic gradients and
 * a radial mask, none of which can be said in Tailwind. These components exist
 * to supply the markup, the size and the aria, so that no screen has to
 * remember that an Orbit is four <circle>s in a particular order.
 *
 * The colours are the --color-load-* tokens, which are themselves references
 * to `brand`, `brand-ink`, `muted` and `border-strong`. Nothing here names a
 * colour, and nothing here needs a dark-mode branch.
 *
 * WHICH ONE TO REACH FOR
 *
 *   <Skeleton>      First load, when the SHAPE of what is coming is known —
 *                   a table, a form, a stat strip. Always preferred to a
 *                   spinner, because it holds the page still. See Skeleton.tsx.
 *   <Orbit>         A whole panel or page with nothing on it yet and no known
 *                   shape. The full mark, in motion.
 *   <Sweep>         Inside a button, or beside a single field. Small.
 *   <LoadingBar>    The top edge of a panel that is refreshing itself.
 *   <LoadingDots>   Inline, mid-sentence: "Recalculating totals …".
 *   <LoadingVeil>   Figures that are ALREADY on screen and are being replaced.
 *
 * ACCESSIBILITY. Each takes a `label`. It is announced — the element is a live
 * region — so it should say what is happening ("Loading products"), not what
 * the widget is. Pass `label={null}` when something adjacent already says it,
 * e.g. a button whose own text has changed to "Saving…"; that hides the loader
 * from the screen reader instead of announcing "Loading" over the top of it.
 */

/** Turns the numeric `size` prop into the --ody-size the CSS reads. */
function sized(size: number, style?: CSSProperties): CSSProperties {
  return { ...style, ['--ody-size' as string]: `${size}px` }
}

/**
 * Props shared by every loader that announces itself.
 *
 * `label` is the announced text; `null` marks the loader decorative, for when
 * the surrounding copy already carries the message.
 */
type LoaderAria = { label?: string | null }

function aria(label: string | null | undefined, fallback: string) {
  const text = label === undefined ? fallback : label
  return text === null
    ? ({ 'aria-hidden': true } as const)
    : ({ role: 'status' as const, 'aria-label': text })
}

/**
 * Orbit — the mark in motion. A still core, a fast arc, and a slow grey ribbon
 * turning the other way.
 *
 * The biggest of the five and the only one that reads as the Odyssey mark, so
 * it is for the case where a whole panel or page is waiting on its first
 * payload and there is no known shape to skeleton. Anything smaller than about
 * 32px loses the ribbon and should be a <Sweep> instead.
 */
export function Orbit({
  size = 44,
  label,
  className = '',
}: LoaderAria & { size?: number; className?: string }) {
  return (
    <svg
      viewBox="0 0 64 64"
      className={`ody-orbit ${className}`}
      style={sized(size)}
      {...aria(label, 'Loading')}
    >
      <circle className="track" cx="32" cy="32" r="24" />
      <ellipse className="ribbon" cx="32" cy="32" rx="24" ry="9" />
      <circle className="arc" cx="32" cy="32" r="24" />
      <circle className="core" cx="32" cy="32" r="9" />
    </svg>
  )
}

/**
 * Sweep — one ring, small enough to sit inside a control.
 *
 * `onFill` recolours it from `currentColor` for use on a filled button, where
 * the page's blues would disappear into the fill. It works on brand, success
 * and danger alike, because it borrows the button's own ink rather than naming
 * a tone of its own.
 *
 *   <Button variant="primary" disabled>
 *     <Sweep size={15} onFill label={null} /> Saving…
 *   </Button>
 */
export function Sweep({
  size = 28,
  onFill = false,
  label,
  className = '',
}: LoaderAria & { size?: number; onFill?: boolean; className?: string }) {
  return (
    <span
      className={`ody-sweep ${onFill ? 'ody-sweep-on-fill' : ''} ${className}`}
      style={sized(size)}
      {...aria(label, 'Loading')}
    />
  )
}

/**
 * LoadingBar — an indeterminate sweep, 3px tall, for the top edge of a panel.
 *
 * Full-bleed and unpadded on purpose: it belongs to the panel's edge rather
 * than to its content, so it can appear and disappear without moving a row.
 * Sit it directly under a CardHeader, above the body it describes.
 */
export function LoadingBar({ label, className = '' }: LoaderAria & { className?: string }) {
  /* progressbar rather than status, and with no value: a progressbar carrying
     no aria-valuenow is precisely how "indeterminate" is spelt to a reader. */
  const text = label === undefined ? 'Loading' : label
  return (
    <div
      className={`ody-bar ${className}`}
      {...(text === null
        ? { 'aria-hidden': true }
        : { role: 'progressbar', 'aria-label': text })}
    />
  )
}

/**
 * LoadingDots — three dots that wave, sized to sit inline with running text.
 *
 * For the small, frequent waits that happen inside a sentence: a total being
 * recalculated, a code being checked. A spinner at this size in the middle of a
 * paragraph reads as an error icon.
 */
export function LoadingDots({ label, className = '' }: LoaderAria & { className?: string }) {
  return (
    <span className={`ody-dots ${className}`} {...aria(label, 'Loading')}>
      <i />
      <i />
      <i />
    </span>
  )
}

/**
 * LoadingVeil — the refresh pattern. Keeps the old figures on screen, washes
 * over them, and orbits on top.
 *
 * This is the one to reach for whenever a panel that ALREADY has content is
 * fetching new content: a filter changed, a date range moved, a report reran.
 * Clearing the panel back to a spinner in that moment throws away the only
 * thing on screen worth looking at and collapses the layout twice — once when
 * the figures go and again when they come back.
 *
 * It wraps its children rather than expecting the caller to remember
 * `position: relative`, which is the way every hand-rolled version of this has
 * been got wrong. `aria-busy` goes on the wrapper, so a reader is told the
 * region is stale rather than being read the stale numbers as current.
 *
 *   <LoadingVeil show={isFetching} message="Fetching figures">
 *     <StatStrip>…</StatStrip>
 *   </LoadingVeil>
 */
export function LoadingVeil({
  show,
  message,
  children,
  className = '',
}: {
  show: boolean
  /**
   * A short line under the orbit, set in the small caps the veil uses. Say what
   * is being fetched — "Fetching figures", "Reloading stock" — or leave it off
   * for a wash with no words.
   */
  message?: string
  children: ReactNode
  className?: string
}) {
  return (
    <div className={`relative ${className}`} aria-busy={show || undefined}>
      {children}
      {show && (
        /* One announcement between them: the veil is the live region, and the
           orbit inside it is decorative — labelling both reads "Fetching
           figures" twice, once for the spinner and once for the caption. */
        <div className="ody-veil" role="status" aria-label={message ?? 'Loading'}>
          <div className="grid justify-items-center gap-3">
            <Orbit size={44} label={null} />
            {message && (
              <span className="text-xs font-semibold tracking-[0.13em] text-muted uppercase">
                {message}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
