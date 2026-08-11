'use client'

import { useState } from 'react'
import {
  ActionTile,
  Button,
  EmptyState,
  Icons,
  TileGrid,
  toneForId,
  toneForTileToken,
} from '@/components/ui'
import {
  actionForSlug,
  groupMembers,
  quickKeyLabel,
  topLevelKeys,
  type QuickKeyRow,
} from '@/lib/quickKeys'
import { quickKeyArt, quickKeyArtSrc } from '@/lib/quickKeyArt'
import { useTileSizeValue } from '@/lib/posOffline/useTileSize'

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
  /* The same tile size the product and department grids use. A quick-key grid at its
     own fixed size beside a product grid at the cashier's chosen one reads as two
     screens that happen to be adjacent. */
  const tiles = useTileSizeValue()

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
      {openGroup ? (
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="touch" onClick={() => setOpenGroupId(null)}>
            <Icons.Reverse size={18} />
            Back
          </Button>
          <span className="truncate text-base font-semibold text-ink">
            {labelFor(openGroup)}
          </span>
        </div>
      ) : (
        /* Says what the grid IS and what tapping does, in one line. The tiles below
           are now white cards like the product tiles, so without this a cashier
           landing on the till has no cue that these run rather than sell. */
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">
          Quick keys — tap to run
        </p>
      )}

      {shown.length === 0 ? (
        <EmptyState
          icon={<Icons.LayoutGrid size={24} />}
          title="Nothing in here"
          hint="This folder is empty. Tap Back, or ask a manager to put something in it."
        />
      ) : (
        <TileGrid tileWidth={tiles.width} tileHeight={tiles.height}>
          {shown.map((key) => (
            <KeyButton
              key={key.id}
              keyRow={key}
              label={labelFor(key)}
              tileHeight={tiles.height}
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

/**
 * One key.
 *
 * ── WHAT A KEY SHOWS, AND IN WHICH ORDER IT IS DECIDED ────────────────────
 *
 * Three things are resolved separately because they come from different places and a
 * shop can override each on its own:
 *
 *   PICTURE  drawn art for the slug, else drawn art for the chosen icon name, else
 *            the lucide glyph. A product key falls all the way through, which is
 *            right — there is no drawing of "Coca-Cola 2L".
 *   TONE     the art's own hue when there is art, so disc and drawing agree; a tone
 *            derived from the key's id otherwise, which is what gives a grid of
 *            product keys distinguishable colours with nothing stored.
 *   HINT     the action's one-liner. A group says how many are inside instead, and a
 *            product key says nothing — its caption is already the whole story.
 */
function KeyButton({
  keyRow,
  label,
  memberCount,
  enabled,
  tileHeight,
  onPress,
}: {
  keyRow: QuickKeyRow
  label: string
  memberCount: number
  enabled: boolean
  tileHeight: number
  onPress: () => void
}) {
  const action = keyRow.kind === 'action' ? actionForSlug(keyRow.actionSlug) : null
  const art = quickKeyArt({ actionSlug: keyRow.actionSlug, icon: keyRow.icon })
  const Glyph = glyphFor(keyRow.icon || action?.icon || (keyRow.kind === 'group' ? 'Shapes' : ''))

  /* The art is a picture, so it gets an empty alt and the caption beside it carries
     the meaning — a screen reader reading "cashup.svg" after the word "Cash up" is
     the same thing said twice. */
  const icon = art ? (
    <img src={quickKeyArtSrc(art.file)} alt="" className="h-7 w-7" />
  ) : Glyph ? (
    <Glyph size={22} />
  ) : null

  const hint =
    keyRow.kind === 'group'
      ? `${memberCount} ${memberCount === 1 ? 'key' : 'keys'}`
      : (action?.hint ?? undefined)

  return (
    <ActionTile
      title={label}
      hint={hint}
      icon={icon}
      tone={art ? art.tone : toneForId(keyRow.id)}
      /* The colour the SHOP chose for this key, not the one derived from its art.
         A manager who set a key green expects a green edge, and a key with no
         colour stored simply gets none — an edge invented for it would look like a
         choice nobody made. */
      edge={toneForTileToken(keyRow.colourToken) ?? undefined}
      tileHeight={tileHeight}
      chevron={keyRow.kind === 'group'}
      disabled={!enabled}
      onClick={onPress}
      /* A cashier should know a key will ask for a PIN before they press it in front
         of a customer, not after. */
      corner={keyRow.requireAuth ? <Icons.KeyRound size={13} /> : undefined}
    />
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
