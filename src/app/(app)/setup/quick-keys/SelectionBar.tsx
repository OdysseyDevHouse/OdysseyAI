'use client'

import {
  Button,
  Menu,
  MenuItem,
  SwatchPicker,
  Icons,
} from '@/components/ui'
import { SUPERVISOR_GROUP_SIG, type QuickKeyRow } from '@/lib/quickKeys'

/**
 * What you get once more than one key is ticked.
 *
 * ── WHY BULK AT ALL, WHEN THE INSPECTOR EXISTS ────────────────────────────
 *
 * Because the jobs are different. The inspector is for making ONE key right — its
 * caption, whether it wants a PIN. The bulk bar is for the sweep: colour the eight
 * drinks keys the same, file the six admin ones into a folder, clear out last season's.
 * Doing any of those one key at a time is the same click eight times, and it is the
 * moment a manager decides the screen is not worth using.
 *
 * The inspector KEEPS renaming and per-key settings — this repo's version is not a
 * replacement for it. (The reference POS removed its per-key editor when it added this
 * bar, on the argument that a renamed built-in key causes support calls. That argument
 * does not carry here: this app's captions fall back to the action's own label, so a key
 * with no caption is self-naming and a shop that types one has said what it wants.)
 *
 * ── ABOVE THE CANVAS, NEVER FLOATING OVER IT ──────────────────────────────
 *
 * The canvas is a drop target for the whole width of the card. A floating bar would sit
 * over the tiles a manager is aiming at, and the one gesture this screen is built around
 * would be the one it obstructs. Sticky, so it survives a long bar.
 */
export function SelectionBar({
  selected,
  groups,
  inGroup,
  busy,
  allSelected,
  onColour,
  onMoveTo,
  onDelete,
  onSelectAll,
  onClear,
}: {
  selected: QuickKeyRow[]
  /** Groups on this bar the selection could be filed into — never the open one. */
  groups: QuickKeyRow[]
  /** The canvas is inside a group, so "take them out" is on offer. */
  inGroup: boolean
  busy: boolean
  allSelected: boolean
  onColour: (token: string) => void
  onMoveTo: (parentId: number | null) => void
  onDelete: () => void
  onSelectAll: () => void
  onClear: () => void
}) {
  const count = selected.length

  /* A group cannot go inside a group — the same one-level rule the drag gesture and the
     server both enforce. With a folder in the selection there is no move to offer, so
     the control is hidden rather than shown disabled: a greyed button invites a hunt for
     the setting that would enable it, and there is none. */
  const anyGroups = selected.some((k) => k.kind === 'group')
  const canMove = !anyGroups && (groups.length > 0 || inGroup)

  /* The supervisor group can be recoloured like anything else; only its REMOVAL is
     refused, server-side too. Dropping the whole bar for it would mean the one tile
     every cashier sees first is the one tile a shop cannot restyle. */
  const anyLocked = selected.some((k) => k.sig === SUPERVISOR_GROUP_SIG)

  return (
    <div className="sticky top-0 z-30 flex flex-wrap items-center gap-2 border-b border-border bg-brand-soft px-4 py-3">
      <span className="text-sm font-semibold text-ink">{count} selected</span>

      <span aria-hidden className="mx-1 h-5 w-px bg-border" />

      {/* The palette inline rather than behind a "Colour" button: recolouring is the
          commonest bulk act by a distance, and a menu in front of it is one click on
          every one of them. */}
      <SwatchPicker
        value={null}
        disabled={busy}
        onChange={(token) => onColour(token ?? 'tile-none')}
      />

      {canMove && (
        <Menu label="Move to" variant="secondary" size="sm" align="left">
          {inGroup && (
            <MenuItem onClick={() => onMoveTo(null)}>Take out of the group</MenuItem>
          )}
          {groups.map((g) => (
            <MenuItem key={g.id} onClick={() => onMoveTo(g.id)}>
              {g.caption || 'Untitled group'}
            </MenuItem>
          ))}
        </Menu>
      )}

      {/* Hidden, not disabled, when the supervisor group is in the selection — same
          reasoning as the move control above. */}
      {!anyLocked && (
        <Button variant="danger-ghost" size="sm" disabled={busy} onClick={onDelete}>
          <Icons.Trash size={14} />
          Remove
        </Button>
      )}

      <span className="ml-auto flex items-center gap-1">
        {!allSelected && (
          <Button variant="ghost" size="sm" disabled={busy} onClick={onSelectAll}>
            Select all
          </Button>
        )}
        <Button variant="ghost" size="sm" disabled={busy} onClick={onClear}>
          Done
        </Button>
      </span>
    </div>
  )
}
