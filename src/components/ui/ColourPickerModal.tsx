'use client'

import { Modal } from './Modal'
import { Ban, Check } from './icons'
import { CATEGORY_SWATCHES, TILE_NONE } from './tiles'

/**
 * The colour picker: twenty named category colours, plus "no background".
 *
 * ── WHY A DIALOG RATHER THAN AN INLINE GRID ───────────────────────────────
 *
 * Twenty labelled tiles cannot sit inside a form field without dominating the
 * screen they are on — the colour is one small decision among many on the
 * product form, and inline it was costing more room than the description. The
 * trigger shows the CURRENT colour, which is the only part worth standing space
 * once the choice is made.
 *
 * ── PICKING COMMITS AND CLOSES ────────────────────────────────────────────
 *
 * There is nothing else to say in here, so a Cancel/Apply pair would only make
 * the user confirm what they can already see. The caller's own Save is still
 * what writes it — this dialog changes the form, not the record.
 */
export function ColourPickerModal({
  open,
  onClose,
  value,
  onChange,
  title = 'Choose a colour',
}: {
  open: boolean
  onClose: () => void
  /** The selected token, `TILE_NONE.token`, or null when nothing is set. */
  value: string | null
  onChange: (token: string) => void
  title?: string
}) {
  function choose(token: string) {
    onChange(token)
    onClose()
  }

  return (
    /*
     * xl and bodyGrows, so twenty tiles fit without a scrollbar on a normal
     * screen. Measured at 1584x905: at `lg` in three columns the body wanted
     * 878px against a 60vh cap of 543 and scrolled by 335. Width is the lever
     * that actually helps — a fourth column removes two of the seven rows —
     * and bodyGrows then lets the panel use the height the window has instead
     * of stopping at 60vh.
     *
     * `xl` is the documented size for a dialog whose content is a GRID rather
     * than a form; see MODAL_SIZE in styles.ts.
     */
    <Modal open={open} onClose={onClose} title={title} size="xl" bodyGrows>
      <div className="flex flex-col gap-4 p-6">
        {/* Two across at the narrowest so a label like "Confectionery" keeps one
            line, four once there is room. */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {CATEGORY_SWATCHES.map((c) => {
            const selected = value === c.token
            return (
              <button
                key={c.token}
                data-kit-ok
                type="button"
                aria-pressed={selected}
                onClick={() => choose(c.token)}
                /* The swatch IS the control — a bordered card around a colour
                   chip would put a second rectangle around every option and
                   halve the colour actually on screen.

                   Height keys off the VIEWPORT HEIGHT, not the width — the
                   constraint here is vertical, and a laptop is short rather
                   than narrow. Measured: h-24 in five rows overflowed a
                   768px-tall screen by ~100px. 76px is the floor at which the
                   name and hex still sit comfortably; the full 96 returns on a
                   screen tall enough to pay for it. */
                className={`relative flex h-[76px] flex-col justify-end rounded-card p-3 text-left text-white transition [@media(min-height:860px)]:h-24 ${c.className} ${
                  selected
                    ? 'ring-2 ring-ink ring-offset-2 ring-offset-surface'
                    : 'hover:brightness-110'
                }`}
              >
                {selected && (
                  <span className="absolute right-2 top-2 flex size-5 items-center justify-center rounded-full bg-white/25">
                    <Check size={13} />
                  </span>
                )}
                <span className="text-sm font-semibold">{c.label}</span>
                {/* The hex, as in the supplied palette. Worth the line: it is
                    how a shop matches a tile to signage or a printed shelf
                    label, which the name alone cannot do. */}
                <span className="text-xs text-white/70">{c.hex}</span>
              </button>
            )
          })}
        </div>

        {/* "None" is a different KIND of answer from the twenty, so it sits
            apart rather than becoming a twenty-first tile. */}
        <button
          data-kit-ok
          type="button"
          aria-pressed={value === TILE_NONE.token}
          onClick={() => choose(TILE_NONE.token)}
          className={`flex w-fit items-center gap-1.5 rounded-control border px-3 py-2 text-sm transition ${
            value === TILE_NONE.token
              ? 'border-ink text-ink'
              : 'border-border text-muted hover:bg-surface-2'
          }`}
        >
          <Ban size={15} />
          No background
        </button>
      </div>
    </Modal>
  )
}
