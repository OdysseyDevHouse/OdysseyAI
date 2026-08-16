'use client'

import { Icons } from '@/components/ui'
import { QUICK_KEY_ICONS } from '@/lib/quickKeys'
import { quickKeyArt, quickKeyArtSrc } from '@/lib/quickKeyArt'

/**
 * Choosing a key's icon.
 *
 * ── NAMES, NEVER PICTURES ─────────────────────────────────────────────────
 *
 * Every option here stores a kit icon NAME. The reference POS stores emoji and
 * `iconify:set:name` strings, which is the right call in a system with no design
 * system — and the wrong one here, where a raw glyph would be the single element that
 * survives a restyle unchanged. A name resolves through the kit, so an icon swap
 * repaints every key that ever chose it.
 *
 * ── SOME NAMES DRAW AS ART, AND THE PICKER SHOWS THAT ─────────────────────
 *
 * A handful of names have hand-drawn SVGs behind them, and the till prefers the art
 * where it exists. The picker therefore renders each option exactly as the till would —
 * art if there is art, the line glyph otherwise. A grid of flat glyphs that turn into
 * drawings after saving is a picker that lies about what it is offering.
 */
export function IconPicker({
  value,
  actionSlug,
  disabled,
  onChange,
}: {
  /** The stored name, or '' for "whatever the key works out for itself". */
  value: string
  /** An action key's slug — its art wins over any chosen icon, so the picker says so. */
  actionSlug: string
  disabled: boolean
  onChange: (name: string) => void
}) {
  /* An action key with drawn art cannot be re-iconed in any visible way: quickKeyArt
     resolves the SLUG first, so whatever is chosen here would be ignored by both the
     till and the canvas. Saying so beats offering a grid that does nothing. */
  const slugArt = quickKeyArt({ actionSlug, icon: '' })
  if (slugArt) {
    return (
      <div className="flex items-center gap-2.5 rounded-control border border-border bg-surface-2 px-3 py-2.5">
        <img src={quickKeyArtSrc(slugArt.file)} alt="" className="h-7 w-7" />
        <p className="text-xs text-muted">
          This key has its own artwork, drawn for what it does.
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {/* "None" first, and always available — a key whose icon is cleared falls back to
          what its kind implies, which is what most keys should look like. */}
      <div className="flex flex-wrap gap-1.5">
        <IconButton
          name=""
          selected={value === ''}
          disabled={disabled}
          onChange={onChange}
        />
        {QUICK_KEY_ICONS.map((group) => (
          <div key={group.group} className="flex w-full flex-col gap-1.5">
            <p className="text-[11px] font-bold uppercase tracking-[0.8px] text-muted">
              {group.group}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {group.names.map((name) => (
                <IconButton
                  key={name}
                  name={name}
                  selected={value === name}
                  disabled={disabled}
                  onChange={onChange}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function IconButton({
  name,
  selected,
  disabled,
  onChange,
}: {
  name: string
  selected: boolean
  disabled: boolean
  onChange: (name: string) => void
}) {
  /* Drawn art wins where a name has it — the same resolution order the till uses, so
     what is picked is what appears. */
  const art = name ? quickKeyArt({ actionSlug: '', icon: name }) : null
  const Glyph = name ? glyphFor(name) : null

  return (
    /* Not a kit Button: it is a 32px square swatch in a grid of forty, and every Button
       variant carries padding and a label slot that would make the grid unreadable. */
    <button
      type="button"
      data-kit-ok
      disabled={disabled}
      aria-pressed={selected}
      aria-label={name || 'No icon'}
      title={name || 'No icon'}
      onClick={() => onChange(name)}
      className={`flex size-8 items-center justify-center rounded-control border transition ${
        selected
          ? 'border-brand bg-brand-soft text-brand-ink'
          : 'border-border bg-surface text-ink-2 hover:border-border-strong hover:bg-surface-2'
      } ${disabled ? 'cursor-not-allowed opacity-50' : ''}`}
    >
      {art ? (
        <img src={quickKeyArtSrc(art.file)} alt="" className="h-5 w-5" />
      ) : Glyph ? (
        <Glyph size={16} />
      ) : (
        <Icons.Ban size={14} />
      )}
    </button>
  )
}

function glyphFor(name: string) {
  const set = Icons as unknown as Record<string, typeof Icons.Sparkles>
  return set[name] ?? null
}
