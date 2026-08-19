/**
 * The band a section sits on.
 *
 * ── ITS OWN FILE, AND THAT IS THE POINT ──────────────────────────────────
 *
 * `HomeSections` reaches the database through its imports, so anything living
 * beside it can only run inside a request. This is pure — a section and a node
 * in, an element out — which means the builder’s canvas draws bands through the
 * same function the shop does, and a test can ask what it produces without a
 * connection.
 */

import type { ReactNode } from 'react'
import type { HomeSection } from '@/lib/storefrontModel'

/**
 * The band a section sits on: its background, its room, and how wide it runs.
 *
 * ── EVERY VALUE IS A ROLE ────────────────────────────────────────────────
 *
 * Nothing here reads a colour from the section. `tinted` mixes the shop’s own
 * brand, `surface` and `contrast` are theme tokens, and all three follow a
 * theme change without this function knowing a theme exists — which is the
 * same property `StoreChrome` relies on for the whole storefront.
 *
 * ── BREAKING OUT OF THE PAGE ─────────────────────────────────────────────
 *
 * The width cap lives on `<main>`, so `full` cannot be a wider max-width — it
 * has to escape a container it is already inside. The viewport-relative
 * negative margin below is that escape, and it is written once here rather
 * than per section: getting it slightly wrong produces a horizontal scrollbar
 * on a phone, which is the bug nobody reproduces on a desktop.
 */
export function banded(section: HomeSection, node: ReactNode): ReactNode {
  if (node === null) return node

  const background = section.background ?? (section.tone === 'tinted' ? 'tinted' : 'none')
  const padding = section.padding ?? 'normal'
  const width = section.width ?? 'contained'

  // The plainest section is untouched, so a page saved before any of this
  // existed renders through exactly the markup it always did.
  if (background === 'none' && padding === 'normal' && width === 'contained') return node

  const PAD: Record<string, string> = {
    none: '',
    tight: 'py-3',
    normal: 'py-6',
    loose: 'py-12',
  }

  /*
   * A value this build does not know falls back rather than reaching the class
   * list. These come from a stored layout, so an unrecognised one is a build
   * that offered a key this one does not — and  interpolated into a
   * className is a literal "undefined" class, which is silent and permanent.
   */

  /*
   * `full` bleeds to the viewport, not to the container.
   *
   * 50% of the viewport minus 50% of the element is the distance from a
   * centred box to the screen edge, whatever the page is capped at — so this
   * keeps working when a shop changes its page width. `100vw` alone would
   * include the scrollbar and overflow by its width.
   */
  const bleed =
    width === 'full'
      ? 'w-screen relative left-1/2 right-1/2 -ml-[50vw] -mr-[50vw]'
      : width === 'wide'
        ? '-mx-4 @sm:-mx-6'
        : ''

  const inner = width === 'full' ? 'mx-auto w-full max-w-[var(--storefront-page-max,72rem)] px-4' : ''

  const surface =
    background === 'tinted'
      ? { background: 'color-mix(in srgb, var(--color-brand) 7%, transparent)' }
      : background === 'surface'
        ? { background: 'var(--color-surface)' }
        : background === 'contrast'
          ? {
              /*
               * The inverse of the shop’s own ink and canvas, not a hardcoded
               * dark. A shop that chose the dark theme gets a LIGHT band here,
               * which is what "contrast" has to mean or it is just "dark".
               */
              background: 'var(--color-ink)',
              color: 'var(--color-canvas)',
            }
          : undefined

  return (
    <div
      /* No rounded corners on a full-bleed band: a card radius against the
         screen edge leaves two slivers of page showing through the corners,
         which reads as a rendering fault rather than a choice. */
      className={`${bleed} ${background !== 'none' && width !== 'full' ? 'rounded-card' : ''} ${PAD[padding] ?? PAD.normal}`.trim()}
      style={surface}
    >
      {inner ? <div className={inner}>{node}</div> : node}
    </div>
  )
}