'use client'

import {
  Modal,
  Button,
  Field,
  Slider,
  TileGrid,
  ProductTile,
  Icons,
  type CategoryTone,
} from '@/components/ui'
import {
  TILE_HEIGHT_MAX,
  TILE_HEIGHT_MIN,
  TILE_WIDTH_MAX,
  TILE_WIDTH_MIN,
  type TileSize,
} from '@/lib/posOffline/useTileSize'

/**
 * How big this till draws its product tiles.
 *
 * ── WHY A LIVE PREVIEW AND NOT JUST TWO NUMBERS ────────────────────────────
 *
 * "190 × 150" tells nobody anything. What a person setting up a till actually wants
 * to know is how many products they will see at once and whether a description still
 * fits — and both are answers you can only get by looking. So the dialog draws real
 * tiles at the chosen size, with a long description and a price in them, because a
 * preview full of short words would hide the exact failure the sliders exist to avoid.
 *
 * The preview is deliberately NOT the whole catalogue: six tiles is enough to show the
 * proportions and the column count, and rendering forty thousand behind a slider that
 * fires on every pixel of drag is how a settings dialog locks up a till.
 *
 * ── WHY THIS IS A DIALOG AND NOT A PANEL ON THE TILL ───────────────────────
 *
 * It is set once, when a till is commissioned, and then essentially never. Two
 * permanent sliders on the surface would cost basket width on every sale for the sake
 * of that one moment — and the basket is the part of this screen a cashier looks at.
 */
export function TileSizeModal({
  open,
  size,
  onChange,
  onReset,
  onClose,
}: {
  open: boolean
  size: TileSize
  onChange: (next: TileSize) => void
  onReset: () => void
  onClose: () => void
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Tile size"
      /* A long form: the default 60vh cap made it read through a letterbox with
         empty desktop above and below. Still a MAX, so a short one stays short. */
      bodyGrows
      description="How this screen draws the product grid. Remembered on this machine only."
      footer={
        <div className="flex w-full items-center justify-between gap-3">
          {/* A way back. Someone who has dragged both sliders into an unusable grid
              needs one tap to a known-good state, not a memory of what it was. */}
          <Button variant="ghost" size="touch" onClick={onReset}>
            Reset
          </Button>
          <Button variant="primary" size="touch" onClick={onClose}>
            Done
          </Button>
        </div>
      }
    >
      <div className="space-y-5">
        <Field label="Width">
          <Slider
            value={size.width}
            onChange={(width) => onChange({ ...size, width })}
            min={TILE_WIDTH_MIN}
            max={TILE_WIDTH_MAX}
            step={10}
            unit="px"
            size="touch"
            minLabel="More on screen"
            maxLabel="Bigger targets"
          />
        </Field>

        <Field label="Height">
          <Slider
            value={size.height}
            onChange={(height) => onChange({ ...size, height })}
            min={TILE_HEIGHT_MIN}
            max={TILE_HEIGHT_MAX}
            step={10}
            unit="px"
            size="touch"
            minLabel="Short rows"
            maxLabel="Tall tiles"
          />
        </Field>

        <div>
          <p className="mb-2 text-sm font-medium text-ink-2">Preview</p>
          {/*
            Fixed height with its own scroll, so dragging a slider to 200px tall does
            not grow the dialog past the viewport and push the footer — and its Done
            button — off the bottom of the screen. Modal's body scrolls at 60vh; a
            preview that pushes the footer out of reach is how a dialog traps someone.
          */}
          <div className="till-pane max-h-[30vh] min-h-56 overflow-y-auto rounded-card border border-border p-2">
            <TileGrid tileWidth={size.width} tileHeight={size.height}>
              {PREVIEW.map((p) => (
                <ProductTile
                  key={p.title}
                  title={p.title}
                  subtitle={p.subtitle}
                  price={p.price}
                  icon={<Icons.Package size={20} />}
                  tone={p.tone}
                  onClick={() => {}}
                />
              ))}
            </TileGrid>
          </div>
        </div>
      </div>
    </Modal>
  )
}

/**
 * Six sample tiles.
 *
 * The first title is deliberately long: a preview of short names would look fine at
 * every width and hide the one thing these sliders are for — finding the width where
 * a real product description stops fitting.
 */
const PREVIEW: { title: string; subtitle: string; price: string; tone: CategoryTone }[] = [
  {
    title: 'Ceres Mixed Berry Juice 1 Litre',
    subtitle: '12 on hand',
    price: 'R24.99',
    tone: 'indigo',
  },
  { title: 'White Bread', subtitle: 'none on hand', price: 'R18.50', tone: 'amber' },
  { title: 'Full Cream Milk 2L', subtitle: '6 on hand', price: 'R36.99', tone: 'sky' },
  { title: 'Eggs · Large · 18s', subtitle: '4 on hand', price: 'R59.99', tone: 'emerald' },
  { title: 'Coca-Cola 500ml', subtitle: '48 on hand', price: 'R14.00', tone: 'rose' },
  { title: 'Bar One 55g', subtitle: '30 on hand', price: 'R12.50', tone: 'violet' },
]
