'use client'

import { useEffect, useState } from 'react'
import { Button, Icons } from '@/components/ui'
import FloorDesigner from './FloorDesigner'
import type { FloorRoom, FloorFeature } from '@/lib/site/posFloor'
import type { PosTable } from '@/lib/site/posTables'

/**
 * The floor plan, in the page or filling the screen.
 *
 * ── WHY THIS EXISTS AT ALL ────────────────────────────────────────────────
 *
 * The designer is a drawing tool sitting in a column of a settings page, under a mode
 * switch, a table list and a visit-type card. Arranging a room meant scrolling past all
 * of that to reach the canvas, then back up to change a setting, then down again — and
 * the canvas itself only got whatever width the page column allowed. Full screen gives it
 * the room it needs without moving it out of the setup screen, where it belongs.
 *
 * ── THE DESIGNER NEVER UNMOUNTS, AND THAT IS THE WHOLE DESIGN ─────────────
 *
 * `<FloorDesigner>` is rendered at ONE fixed position in this tree, in both states. Only
 * the wrapper around it changes: in the page it is an ordinary block, and full-screen it
 * is a `fixed` overlay. React therefore reconciles it as the same element and keeps every
 * piece of its state — the draft, the selection, the undo stack, which room is open.
 *
 * That is why this is a hand-built overlay rather than the kit's `<Modal>`. A `<dialog>`
 * hides its children when closed, so the collapsed card would vanish from the page; and
 * the Modal deliberately remounts its body on open, which exists to stop a form
 * inheriting the last person's answers but would here throw away an arrangement in
 * progress. Both are right for a dialog that asks a question and wrong for one that IS
 * the workspace.
 *
 * The alternative was lifting the draft, the history stack and the selection up into this
 * component and passing them down — which would make this page the owner of the
 * designer's internals for no gain, since the goal was only to keep them alive.
 *
 * Because nothing is lost on the switch, expanding and collapsing are free: no
 * save-first rule, no confirm, no warning. Unsaved work simply travels with you.
 */
export function FloorPlanSection({
  rooms,
  tables,
  features,
}: {
  rooms: FloorRoom[]
  tables: PosTable[]
  features: FloorFeature[]
}) {
  const [expanded, setExpanded] = useState(false)

  /*
   * Escape leaves full screen, and the page behind must not scroll while it is open.
   *
   * Both are things `<dialog>` would have given us free; this is the cost of the overlay,
   * paid deliberately and in one place. Focus trapping is deliberately NOT reimplemented:
   * the overlay covers the viewport and every control inside it is reachable by tab, so
   * the practical failure — tabbing to something invisible — does not arise here.
   */
  useEffect(() => {
    if (!expanded) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const el = e.target as HTMLElement | null
      /* Not while a field or a nested dialog has the key — the add-table modal closes
         itself on Escape, and this would close the whole workspace out from under it. */
      if (el?.closest("input, textarea, select, [contenteditable='true'], dialog")) return
      setExpanded(false)
    }
    window.addEventListener('keydown', onKey)
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = previous
    }
  }, [expanded])

  return (
    <>
      {/* Holds the card's place in the page flow while the designer is lifted out of it,
          so the cards below do not jump up and back. */}
      {expanded && <div aria-hidden className="h-px" />}

      <div
        className={
          expanded
            ? /* A full-viewport overlay. `z-40` sits above the page and below the kit's
                 own dialogs (the add-table modal is a real <dialog>, which the browser
                 paints in the top layer regardless). */
              'fixed inset-0 z-40 flex flex-col gap-3 bg-canvas p-4'
            : 'contents'
        }
      >
        {expanded && (
          <div className="flex shrink-0 items-center justify-between gap-4">
            <div>
              <h2 className="text-base font-semibold text-ink">Floor plan</h2>
              <p className="text-sm text-muted">
                Drag the tables into place. Everything here saves with the plan.
              </p>
            </div>
            <Button variant="secondary" onClick={() => setExpanded(false)}>
              <Icons.Minimize size={16} />
              Close full screen
            </Button>
          </div>
        )}

        {/*
          ONE element, one position in the tree, in both states — see the note above.
          Moving this line inside a conditional branch would reintroduce the remount and
          silently start discarding unsaved arrangements again.
        */}
        <FloorDesigner
          rooms={rooms}
          tables={tables}
          features={features}
          chrome={expanded ? 'bare' : 'card'}
          /* Only offered when collapsed — inside the overlay the way out is Close, and a
             second "open full screen" on an already-full-screen tool is a dead control. */
          onExpand={expanded ? undefined : () => setExpanded(true)}
        />
      </div>
    </>
  )
}
