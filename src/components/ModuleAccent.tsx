'use client'

import { usePathname } from 'next/navigation'
import type { CSSProperties, ReactNode } from 'react'
import { accentForModule, moduleForPath } from '@/lib/navModules'

/**
 * The module's colour, handed to everything on the page.
 *
 * ── WHAT IT IS FOR ──────────────────────────────────────────────────────────
 *
 * The rail says which product you are in by wearing its colour. This carries
 * that same answer across the seam into the screen, so a dashboard opened from
 * Back-office draws its figures in amber and the same component opened from Job
 * cards draws them in emerald — with neither the dashboard nor the medallion it
 * uses knowing that modules exist.
 *
 * It sets four variables and nothing else. Every icon chip in the kit paints
 * with `--color-accent` on `--color-accent-soft`, and every line — a tab bar's
 * rule, a card's left edge — with `--color-accent-rule`, and a label that has to carry the colour — a
 * selected tab — with `--color-accent-text`; all four default to the brand. This overrides them for the subtree and the whole page follows on
 * the same paint. Adding a colour to a new component is `text-accent`, not a
 * prop threaded down from here.
 *
 * They are SET here, never derived from one another in CSS: a
 * `--color-x: var(--color-accent)` written on :root resolves once up there, to
 * the brand, and inherits that computed value straight past this override. The
 * note beside --color-accent in globals.css records what that looked like.
 *
 * ── WHY IT IS A CLIENT COMPONENT ────────────────────────────────────────────
 *
 * The colour depends on which page you are on, and the layout that renders this
 * is a server component that runs once per navigation without being told the
 * path. `usePathname` is the only honest source. It renders no box of its own —
 * `display: contents` — so it can wrap the page without being a layout element:
 * custom properties inherit down the DOM tree whether or not a box is drawn,
 * and `<main>`'s own positioning and scrolling are untouched.
 *
 * ── WHY THE PATH RATHER THAN THE RAIL'S SELECTION ───────────────────────────
 *
 * The same reason the rail derives its own chip from the path — see the note on
 * `derivedModule` in Sidebar.tsx. A page reached by a link that crosses modules
 * (a ticket that becomes a job card) has to arrive wearing the colour of where
 * it landed, not of where it was opened from.
 */
export default function ModuleAccent({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  const accent = accentForModule(moduleForPath(pathname))

  const vars = {
    '--color-accent': accent.ink,
    '--color-accent-soft': accent.soft,
    '--color-accent-rule': accent.rule,
    '--color-accent-text': accent.text,
  } as CSSProperties

  return (
    <div className="contents" style={vars}>
      {children}
    </div>
  )
}
