'use client'

import { useState } from 'react'
import { Button, EmptyState, Icons, TileGrid, tileClass } from '@/components/ui'
import {
  actionForSlug,
  groupMembers,
  quickKeyLabel,
  topLevelKeys,
  type QuickKeyRow,
} from '@/lib/quickKeys'

/**
 * The shop's own keys, on the till.
 *
 * ── WHY THIS IS THE DEFAULT PANE ──────────────────────────────────────────
 *
 * It is what a cashier reaches for fifty times a day. A department drill is two taps
 * before the first product; a search is three characters and a decision. The keys are one
 * tap, and putting anything else in front of them makes the common act the slow one.
 *
 * ── A FOLDER OPENS IN PLACE ───────────────────────────────────────────────
 *
 * Not a modal. A dialog over the till hides the basket — the thing the cashier is
 * building — and needs dismissing before the next item. Opening in place keeps the sale
 * visible and makes Back one tap in the same spot every time.
 */
export function QuickKeyPanel({
  keys,
  productNames,
  departmentNames,
  isEnabled,
  onPress,
}: {
  keys: readonly QuickKeyRow[]
  /** A product key with no caption reads its product's name. Resolved by the shell. */
  productNames: Record<number, string>
  departmentNames: Record<number, string>
  /** False greys the tile — see quickKeyEnabled on why that beats refusing on press. */
  isEnabled: (key: QuickKeyRow) => boolean
  onPress: (key: QuickKeyRow) => void
}) {
  const [openGroupId, setOpenGroupId] = useState<number | null>(null)

  const openGroup = openGroupId ? keys.find((k) => k.id === openGroupId) : null
  /* Hidden keys are filtered HERE rather than in the query, so the same list serves the
     designer — which must show a hidden key in order to un-hide it. */
  const visible = (rows: QuickKeyRow[]) => rows.filter((k) => !k.isHidden)
  const shown = openGroup ? visible(groupMembers(keys, openGroup.id)) : visible(topLevelKeys(keys))

  const labelFor = (key: QuickKeyRow) =>
    quickKeyLabel(
      key,
      key.kind === 'product'
        ? productNames[key.productId ?? -1]
        : key.kind === 'department'
          ? departmentNames[key.departmentId ?? -1]
          : null,
    )

  if (keys.length === 0) {
    return (
      <EmptyState
        icon={<Icons.Sparkles size={28} />}
        title="No quick keys yet"
        hint="A manager can set these up in Setup → Quick keys. Until then, pick a department on the left or scan a barcode."
      />
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Back sits ABOVE the grid, at a fixed spot — a cashier finds it by position
          rather than by reading, and it must not move as the grid changes length. */}
      {openGroup && (
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="touch" onClick={() => setOpenGroupId(null)}>
            <Icons.Reverse size={18} />
            Back
          </Button>
          <span className="truncate text-base font-semibold text-ink">
            {labelFor(openGroup)}
          </span>
        </div>
      )}

      {shown.length === 0 ? (
        <EmptyState
          icon={<Icons.LayoutGrid size={24} />}
          title="Nothing in here"
          hint="This folder is empty. Tap Back, or ask a manager to put something in it."
        />
      ) : (
        <TileGrid tileWidth={120} tileHeight={104}>
          {shown.map((key) => (
            <KeyButton
              key={key.id}
              keyRow={key}
              label={labelFor(key)}
              memberCount={key.kind === 'group' ? visible(groupMembers(keys, key.id)).length : 0}
              enabled={isEnabled(key)}
              onPress={() => {
                /* A group opens; everything else runs. Decided here rather than in the
                   runner so the runner never needs to know about panel state. */
                if (key.kind === 'group') setOpenGroupId(key.id)
                else onPress(key)
              }}
            />
          ))}
        </TileGrid>
      )}
    </div>
  )
}

function KeyButton({
  keyRow,
  label,
  memberCount,
  enabled,
  onPress,
}: {
  keyRow: QuickKeyRow
  label: string
  memberCount: number
  enabled: boolean
  onPress: () => void
}) {
  const action = keyRow.kind === 'action' ? actionForSlug(keyRow.actionSlug) : null
  const Glyph = glyphFor(keyRow.icon || action?.icon || (keyRow.kind === 'group' ? 'Shapes' : ''))

  return (
    <button
      type="button"
      data-kit-ok
      disabled={!enabled}
      onClick={onPress}
      /* h-full so every tile fills the row TileGrid measured — a grid of tiles sized to
         their own captions is a grid a finger cannot aim at. */
      className={`relative flex h-full flex-col items-center justify-center gap-1.5 overflow-hidden rounded-card px-1.5 text-center transition active:scale-[0.97] ${tileClass(
        keyRow.colourToken,
      )} ${enabled ? '' : 'opacity-40'}`}
    >
      {Glyph && <Glyph size={26} className="text-white" />}
      <span className="line-clamp-2 text-[13px] font-semibold leading-tight text-white">
        {label}
      </span>

      {keyRow.kind === 'group' && (
        <span className="absolute right-1.5 top-1.5 rounded-pill bg-ink/40 px-1.5 text-[11px] font-bold text-white">
          {memberCount}
        </span>
      )}

      {/* A cashier should know a key will ask for a PIN before they press it in front
          of a customer, not after. */}
      {keyRow.requireAuth && (
        <span className="absolute left-1.5 top-1.5 text-white/90">
          <Icons.KeyRound size={13} />
        </span>
      )}
    </button>
  )
}

/**
 * The icon a stored NAME refers to, or null.
 *
 * Null rather than a placeholder here, unlike the designer: on the till a caption alone
 * reads perfectly, and a row of identical fallback glyphs is noise that makes the tiles
 * harder to tell apart rather than easier.
 */
function glyphFor(name: string) {
  if (!name) return null
  const set = Icons as unknown as Record<string, typeof Icons.Sparkles>
  return set[name] ?? null
}
