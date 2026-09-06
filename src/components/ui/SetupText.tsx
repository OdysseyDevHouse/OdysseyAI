import { Fragment, type ReactNode } from 'react'
import Link from 'next/link'
import { findTrail } from '@/lib/nav'

/**
 * SetupText — turns "…under Setup › My store information first." into a
 * sentence whose screen name is a link, and leaves everything else alone.
 *
 * ── WHY THIS IS A RENDERER AND NOT 150 EDITS ────────────────────────────────
 *
 * The app tells somebody to go and set something up in about 150 places, and
 * almost all of them are REFUSALS returned by a server action: `{ ok: false,
 * error: string }`. A string is all that can cross that boundary — JSX cannot —
 * so the message physically cannot carry its own link, and the screen showing
 * it has no idea which of the ~40 settings screens the sentence named. Every
 * one of those messages was therefore a dead end: it told you where to go and
 * then made you go and find it.
 *
 * Fixing that at the call sites would mean threading an href through 150
 * returns, and the 151st would still be written as plain text. So the knowledge
 * lives here instead: the text names a screen, and the RENDERER recognises the
 * name. Nothing upstream changes, and a message written tomorrow in the same
 * house style is a link the day it is written.
 *
 * ── WHAT IT WILL NOT DO ─────────────────────────────────────────────────────
 *
 * It links only a name that follows a hub word ("Setup → …") AND resolves in
 * `SUBPAGE_LABELS`. An unrecognised name renders as the plain text it always
 * was, so a message pointing at a screen that has since been renamed or
 * removed degrades to what it says rather than to a link that 404s.
 */
export function SetupText({ children }: { children: ReactNode }) {
  if (typeof children !== 'string') return <>{children}</>

  const parts: ReactNode[] = []
  let rest = children
  let key = 0

  /* A message may name more than one screen ("…under Setup → Email, or Setup →
     Text messages"), so this walks the whole string rather than linking the
     first hit and giving up. */
  for (;;) {
    const hit = findTrail(rest)
    if (!hit) break
    parts.push(rest.slice(0, hit.start))
    parts.push(
      <Link
        key={key++}
        href={hit.href}
        className="font-medium text-brand underline decoration-brand/40 underline-offset-2 hover:decoration-brand"
      >
        {rest.slice(hit.start, hit.end)}
      </Link>,
    )
    rest = rest.slice(hit.end)
  }

  if (!parts.length) return <>{children}</>
  parts.push(rest)
  return (
    <>
      {parts.map((p, i) => (
        <Fragment key={i}>{p}</Fragment>
      ))}
    </>
  )
}
