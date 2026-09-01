import Image from 'next/image'

/**
 * The Odyssey lockup — the mark, the name, and a subline flanked by rules.
 *
 * ── WHY THIS IS ONE COMPONENT ──────────────────────────────────────────────
 *
 * The printed logo is three things arranged in a fixed relationship: the globe,
 * "ODYSSEY" set solid beneath it, and a tracked-wide subline with a rule either
 * side. Every corner of the product that names the product was drawing a
 * DIFFERENT subset of that by hand — the back-office rail had the full stack,
 * the till and the counter had a one-line "Odyssey Invoicing" with the second
 * word simply coloured. Two shapes for one brand, in two rooms of the same app,
 * a shift apart.
 *
 * So the arrangement lives here once and the only thing a caller chooses is the
 * WORD on the subline: the company's own rooms say "Software", a till says
 * "Retail" or "Hospitality" or "Invoicing". Nothing else varies, which is the
 * point — a lockup whose proportions are decided at the call site is not a
 * lockup, it is a suggestion.
 *
 * ── WHY THE SUBLINE AND NOT THE NAME ───────────────────────────────────────
 *
 * The module could have been appended to the name ("ODYSSEY INVOICING" on one
 * line), and that is what these screens used to do. But the artwork's second
 * line is exactly the slot for "which of these is it" — it is set smaller,
 * lighter and wider precisely so it reads as a qualifier rather than as half of
 * the name. Putting the module there means a shop running tables sees its own
 * product named in the shape it already knows from the box and the invoice.
 */
export function BrandLockup({
  /**
   * The word on the subline — the module, or the company.
   *
   * "Software" is the default because the back office is not one module; it is
   * the whole product, and the rail there names the COMPANY.
   */
  sub = 'Software',
  /**
   * How large the name is set. The subline and the mark scale with it, so the
   * three keep their relationship at every size.
   *
   * Written as full class strings in a lookup rather than interpolated —
   * Tailwind scans source text and would emit nothing for a built name.
   */
  size = 'md',
  /** Extra classes on the wrapper — for `min-w-0` in a rail, or a gap tweak. */
  className = '',
  /**
   * A heading, when this lockup IS the page's heading (a sign-in door, a till's
   * status bar). Default is a plain span: the rail's copy sits inside a link to
   * the dashboard and is not the heading of anything.
   */
  as = 'span',
}: {
  sub?: string
  size?: 'sm' | 'md' | 'lg'
  className?: string
  as?: 'span' | 'h1'
}) {
  const s = SIZES[size]
  const Name = as === 'h1' ? 'h1' : 'span'

  /**
   * The subline, stepped down when the word is long.
   *
   * `.wordmark-sub` tracks at 0.34em, which is a third of a letter's width
   * added after EVERY letter — so the subline's width grows much faster than
   * its character count suggests. Set at the same size for every module,
   * "HOSPITALITY" rendered 512px wide against "INVOICING"'s 235px and more than
   * twice the width of the name it sits under: the rules ended up level with
   * nothing, and the lockup stopped resembling the logo it is copying.
   *
   * So the size is a function of the WORD, not only of the lockup's size. The
   * thresholds are where each step stops fitting under "ODYSSEY" — seven
   * characters is the name's own length, and a subline of about ten is the
   * widest that still reads as sitting beneath it rather than sticking out.
   */
  const subScale = sub.length > 10 ? 'long' : sub.length > 7 ? 'mid' : 'short'

  return (
    /* gap-3 (12px), not the kit's usual gap-2: the mark is a round globe, so its
       bounding box touches the text only at the sphere's widest point and an 8px
       gap reads tighter than 8px does beside a square icon. */
    <span className={`flex min-w-0 items-center gap-3 ${className}`}>
      {/* Decorative beside the wordmark text, so no alt of its own.
          Vector artwork: the mark is set at 28–56px here but is also the thing
          a rail or a till renders on a HiDPI panel, and the raster it replaced
          softened at every one of those steps. `width`/`height` are the SVG's
          own viewBox, present only so Next reserves the right aspect box. */}
      <Image
        src="/logo-icon.svg"
        alt=""
        aria-hidden
        width={1902}
        height={1726}
        unoptimized
        className={`${s.mark} w-auto shrink-0 object-contain`}
      />
      <span className="flex min-w-0 flex-col gap-1">
        {/* Set in the LOGO's own treatment, not the UI stack: it sits directly
            against the mark and the two have to read as one lockup.

            `.wordmark-lockup`, not `.wordmark` — this is the name standing on
            its own rather than a title beside the artwork, and it wants open
            tracking to read as a wordmark. See globals.css. */}
        <Name className={`wordmark-lockup truncate leading-none text-ink ${s.name}`}>
          Odyssey
        </Name>
        {/* The flanking rules are DRAWN, not typed. Em dashes either side would
            be read out as punctuation by a screen reader and would come along
            when the name is copied; these are 1px lines that inherit the
            subline's own colour.

            `text-brand` on the WRAPPER, not on the word: the rules are
            `bg-current`, so colouring the parent carries the letters and both
            rules together and there is one place to change it. */}
        <span className={`flex items-center text-brand ${s.rules}`}>
          {/* `flex-1`, not a fixed width: the rules take whatever the word does
              not, so the pair always reaches the ends of the row and the
              subline stays centred under the name however long the module is.
              A fixed rule was what let "HOSPITALITY" push its rules 200px past
              the name's edge — see the note on the row's width below. */}
          <span className="h-px min-w-[0.4em] flex-1 bg-current" />
          {/* -0.34em back: letter-spacing is applied AFTER the last letter too,
              so without this the right-hand rule sits a tracking-step further
              out than the left one and the pair looks unbalanced. */}
          <span className={`wordmark-sub -mr-[0.34em] leading-none ${s.sub[subScale]}`}>
            {sub}
          </span>
          <span className="h-px min-w-[0.4em] flex-1 bg-current" />
        </span>
      </span>
    </span>
  )
}

/**
 * The three sizes, as whole class strings.
 *
 * The subline is roughly half the name's size at every step — the ratio measured
 * off the artwork — held here rather than left to each caller, because a subline
 * set by eye at one size is what made these lockups drift apart.
 *
 * Each size carries THREE sublines rather than one, picked by word length (see
 * `subScale`). "Software", "Retail" and "Invoicing" get the artwork's own ratio;
 * "Hospitality" would overrun the name at that size, so the longer steps trade
 * a little size for a lockup that still holds its shape.
 *
 * Written as whole class strings, never interpolated: Tailwind scans source text
 * and emits nothing for a name it cannot see.
 */
const SIZES = {
  sm: {
    mark: 'h-7',
    name: 'text-base',
    sub: { short: 'text-[8px]', mid: 'text-[7px]', long: 'text-[6px]' },
    rules: 'gap-1',
  },
  md: {
    mark: 'h-8',
    name: 'text-lg',
    sub: { short: 'text-[9px]', mid: 'text-[8px]', long: 'text-[7px]' },
    rules: 'gap-1',
  },
  lg: {
    mark: 'h-14',
    name: 'text-3xl',
    sub: { short: 'text-[15px]', mid: 'text-[13px]', long: 'text-[11px]' },
    rules: 'gap-1.5',
  },
} as const
