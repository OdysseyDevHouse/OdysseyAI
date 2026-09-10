import type { ReactNode } from 'react'

/**
 * Card — the panel every block of content sits in.
 *
 * Compose it as Card > CardHeader + CardBody. CardHeader draws its own bottom
 * rule, so a card with a header and a table needs no extra dividers.
 *
 * `data-card` is not decoration: it is how the brand rule finds this element.
 * A brand-toned heading marks itself and the card turns its own left border
 * into the rule — see the note in globals.css.
 */
export function Card({
  children,
  className = '',
  id,
}: {
  children: ReactNode
  className?: string
  /**
   * Names this card so the global search can land ON it.
   *
   * A settings result opens `/setup/terminals#idle-logout`, and <SettingAnchor>
   * in the layout scrolls to the element with that id and flashes it. Set it
   * wherever `SETTINGS` in lib/settingSearch.ts names an anchor — the test in
   * scripts/test-setting-search.ts fails if an anchor names a card that no
   * screen renders.
   */
  id?: string
}) {
  return (
    <div
      id={id}
      data-card
      className={`rounded-card border border-border bg-surface shadow-card ${className}`}
    >
      {children}
    </div>
  )
}

export function CardHeader({
  icon,
  title,
  description,
  action,
  className = '',
  tone = 'brand',
}: {
  /**
   * A glyph in a tinted tile, left of the title.
   *
   * Same 36px disc `SettingRow` draws, so a card whose header carries one sits
   * in the same column as the rows beneath it rather than half a tile off. Use
   * an icon from '@/components/ui/icons'; omit it and the header is unchanged.
   */
  icon?: ReactNode
  title: ReactNode
  /** One line saying what this block is for — muted, sentence case. */
  description?: ReactNode
  action?: ReactNode
  className?: string
  /**
   * The brand rule is the default, matching <SectionTitle>, so a screen that
   * mixes the two headings reads as one stack rather than two. 'default' opts
   * out — use it for a card nested inside another card, where a second rule
   * would compete with the outer one.
   */
  tone?: 'default' | 'brand'
}) {
  const brand = tone === 'brand'
  return (
    <div
      /* The marker the card's left border keys off — the rule itself is drawn
         by the card, because a border here could only be as tall as the
         header. See globals.css. */
      data-accent-rule={brand ? '' : undefined}
      /* Lets the block BELOW the header square off its top corners. A table
         frame inherits the card's radius so it can clip its opaque header band
         to the card's curve; directly under a CardHeader there is no curve to
         clip to, and the inherited radius bit a notch of card colour out of
         each top corner of the band. The header is the one element that knows
         it owns the card's top edge, so it says so here and TABLE_FRAME keys
         off it. Not `:first-child` on the frame: a Card renders dialogs as
         siblings, so a table flush against the card top is often not the first
         child and would square off corners that really are in the curve. */
      data-card-header=""
      className={[
        /* Wraps rather than squeezing. The action is shrink-0 and the title
           min-w-0, so without a wrap a header carrying a real toolbar — the
           report screen runs to six controls — wrung the description down to
           one word per line. `flex-wrap` lets the toolbar drop to its own row
           when the two cannot share one, and changes nothing for the two or
           three buttons most cards carry. */
        'flex flex-wrap justify-between gap-4 border-b border-border px-5 py-4',
        /* CENTRED when the title stands alone, TOP-ALIGNED when it has a
           description under it.
           A one-line title beside a 32px button is a single row, and
           `items-start` hung the words above the button's middle — visible on
           every dashboard widget with a "View more". Once there is a
           description the block is two lines tall and centring it would float
           the button against the gap between them, so the two cases genuinely
           want different alignment rather than one compromise. Decided from
           the content rather than from a prop, so no call site has to remember
           which it is. */
        description ? 'items-start' : 'items-center',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {/* basis-64 with grow: the title keeps a readable width and pushes the
          toolbar onto the next line instead of being crushed by it. */}
      <div
        className={`flex min-w-0 shrink grow basis-64 gap-3 ${
          /* Same rule as the row above, one level in: with no description the
             icon tile and the single line of title are one row and centre on
             each other. */
          description ? 'items-start' : 'items-center'
        }`}
      >
        {/* `accent`, not `brand`: the medallion is the kit's one coloured mark
            on a page, so it is what carries the module you are in — amber in
            Back-office, emerald in Job cards. Outside the module shell the pair
            still resolves to the brand. See components/ModuleAccent.tsx. */}
        {icon && (
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-control bg-accent-soft text-accent">
            {icon}
          </span>
        )}
        <div className="min-w-0">
          {/* Ink, not brand. The rule down the card's edge is what marks the
              heading; colouring the words as well said the same thing twice, and
              a blue title reads as a link. */}
          <h2 className="text-sm font-semibold text-ink">{title}</h2>
          {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
        </div>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  )
}

export function CardBody({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`p-5 ${className}`}>{children}</div>
}

export function CardFooter({
  children,
  className = '',
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <div className={`flex items-center justify-end gap-2 border-t border-border px-5 py-3.5 ${className}`}>
      {children}
    </div>
  )
}
