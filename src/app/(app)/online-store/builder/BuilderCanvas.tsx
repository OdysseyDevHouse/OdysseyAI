'use client'

import { useEffect, useRef, type ReactNode } from 'react'
import { useDroppable } from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Button, Icons, SegmentedControl, Switch } from '@/components/ui'
import { themeVars, type DesignTokens } from '@/lib/storefront/tokens'
import {
  MAX_SECTIONS,
  isScheduledNow,
  // One definition, shared with the publish summary — two copies of "what do
  // we call this section" would drift the moment either changed.
  sectionName,
  shopToday,
  type HomeSection,
  type StorefrontTheme,
} from '@/lib/storefrontModel'
import type { StorefrontDepartment } from '@/lib/site/storefront'
import HomeSections, {
  type ProductDisplay,
  type SectionContent,
} from '@/app/store/[token]/HomeSections'
import { CartProvider } from '@/app/store/[token]/CartContext'
import { WishlistProvider } from '@/app/store/[token]/WishlistContext'

/**
 * The live preview — the real storefront, arranged in place.
 *
 * ── IT RENDERS THE ACTUAL SHOP ───────────────────────────────────────────
 *
 * The same `HomeSections` a shopper gets, given a `renderSection` wrapper that
 * adds the drag handle and toolbar. Not a mock, not an approximation: there is
 * no second implementation, so the preview cannot drift from the shop.
 *
 * ── NOT AN IFRAME ────────────────────────────────────────────────────────
 *
 * Every section is already a client component and the storefront borrows the
 * same design tokens, so it renders correctly inside this page's cascade. An
 * iframe would isolate it from a cascade it was never isolated from, and would
 * cost a hand-rolled pointer bridge — dnd-kit's sensors bind to the document
 * they are mounted in, so a drag starting out here would go deaf the moment
 * the cursor crossed the frame boundary.
 */

/**
 * Storage key for the preview's basket.
 *
 * Deliberately NOT the store's real token. The cart is browser storage keyed
 * by token, so sharing it would let a stray click in the builder add a line to
 * the owner's own basket on the live shop.
 */
const PREVIEW_TOKEN = '__odyssey_builder_preview__'

/**
 * How wide the preview is drawn.
 *
 * ── AND WHY IT IS EXACT ──────────────────────────────────────────────────
 *
 * Most shoppers are on a phone, and a builder that only ever showed the
 * desktop layout would let an owner arrange a page they will never see.
 *
 * Narrowing this box is enough because the storefront's grids are container
 * queries — `@sm:`/`@lg:` in HomeSections and ProductGrid, which watch the
 * element they are in rather than the window. So a 390px canvas produces the
 * SAME column counts, spacing and type sizes a 390px phone would, not a
 * desktop layout squeezed into a narrow column.
 *
 * That was the one thing about this preview that used to be a guess. It is the
 * reason the grids were converted.
 */
const WIDTHS = {
  phone: 'max-w-[390px]',
  // 768px, where the storefront's grids go from two columns to three — so this
  // is the width that shows the layout most likely to surprise somebody who has
  // only checked the other two.
  tablet: 'max-w-[768px]',
  desktop: 'max-w-none',
} as const
type PreviewWidth = keyof typeof WIDTHS

export function BuilderCanvas({
  sections,
  content,
  theme,
  tokens,
  display,
  storeName,
  blurb,
  departments,
  selected,
  width,
  dropEdge,
  over,
  dragging,
  placing,
  onWidthChange,
  onSelect,
  onToggle,
  onDuplicate,
  onRemove,
  onSelectAppearance,
  onShowPalette,
}: {
  sections: HomeSection[]
  content: SectionContent[]
  theme: StorefrontTheme
  /**
   * The look being edited, so the preview shows what publishing would do.
   *
   * The draft’s, not the published one: the whole point of the canvas is
   * that it is the shop as it WOULD be, and a preview still wearing the live
   * palette while the panel beside it says "Dark" is the one thing this
   * screen must never do.
   */
  tokens: DesignTokens
  /** The shop's display choices, so the preview matches the shop. */
  display: ProductDisplay
  storeName: string
  blurb: string
  departments: StorefrontDepartment[]
  selected: string | null
  width: PreviewWidth
  /** Which edge of the hovered section the drop line goes on. */
  dropEdge: 'top' | 'bottom' | null
  /** The droppable currently under the cursor, if any. */
  over: string | null
  /** What is in flight, so a section can dim itself while it is the one moving. */
  dragging: string | null
  /**
   * True while a PALETTE tile is in flight.
   *
   * The gaps between sections are invisible at rest — see `InsertPoint`. While
   * something is being carried they have to be visible, or the owner is aiming
   * a drop at a target the screen has not admitted exists.
   */
  placing: boolean
  onWidthChange: (width: PreviewWidth) => void
  onSelect: (id: string) => void
  onToggle: (id: string, enabled: boolean) => void
  onDuplicate: (id: string) => void
  onRemove: (id: string) => void
  /** Clicking the masthead or footer opens the shop-wide settings. */
  onSelectAppearance: () => void
  /** Unfold the palette in the panel, for the empty page's own Add button. */
  onShowPalette: () => void
}) {
  const sectionIds = sections.map((s) => s.id)
  const atLimit = sections.length >= MAX_SECTIONS

  return (
    <>
      <CanvasToolbar width={width} onWidthChange={onWidthChange} />

      {/* The shop's own colour, scoped to the preview so `text-brand` inside
          follows the store's theme rather than the app's. */}
      <div
        className="min-h-full"
        style={themeVars(tokens, theme.brandColour) as React.CSSProperties}
      >
        {/* The phone frame. A plain max-width with the page centred inside —
            see WIDTHS on why this is approximate and why that is said out
            loud rather than dressed up as a device mock. */}
        <div className={`mx-auto w-full transition-[max-width] ${WIDTHS[width]}`}>
          {/* The masthead. NOT a sortable section — it is navigation and appears
              on every page — but it has to be here, or the shop name, blurb and
              colour would be settings with nothing in the preview to show for
              them. Clicking it opens Appearance. */}
          {/* Not a kit Button: this is the shop's own masthead rendered at full
              width, which happens to be clickable. A Button variant for it would
              be used nowhere else and would fight the storefront's styling. */}
          <button
            data-kit-ok
            type="button"
            onClick={onSelectAppearance}
            className="group relative block w-full border-b border-border bg-surface px-5 py-4 text-left"
            aria-label="Edit your shop’s appearance"
          >
            {/* The logo replaces the name here exactly as it does in the shop
                — see StoreChrome. The back-office route, so it still shows
                while the shop is closed. */}
            {theme.logoImageId ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={`/api/storefront-images/${theme.logoImageId}`}
                alt={storeName}
                className="h-9 w-auto max-w-48 object-contain"
              />
            ) : (
              <>
                <span className="block truncate text-base font-semibold text-ink">{storeName}</span>
                {blurb && <span className="block truncate text-sm text-muted">{blurb}</span>}
              </>
            )}
            <span className="pointer-events-none absolute right-3 top-3 rounded-pill bg-ink/80 px-2 py-0.5 text-xs font-medium text-surface opacity-0 transition group-hover:opacity-100">
              Logo, name, colour and welcome
            </span>
          </button>

          <div className="px-5 py-5">
            {/* The first insert point, above everything. Without it there is
                no way to put a new section at the very top except by adding it
                at the bottom and dragging it the length of the page. */}
            <InsertPoint index={0} atLimit={atLimit} placing={placing} over={over} />

            <SortableContext items={sectionIds} strategy={verticalListSortingStrategy}>
              {/*
                Both providers the storefront layout mounts.

                ProductGrid's Add button calls useCart and its heart calls
                useWishlist, and BOTH throw without a provider — so a preview
                missing either fails to render the entire canvas, not just the
                tile. That is exactly what happened: the cart was mounted and
                the wishlist was not, and the builder 500'd for any owner whose
                page had a product row on it.

                Keyed to PREVIEW_TOKEN for the same reason as the cart: this is
                browser storage keyed by token, and sharing the shop's real one
                would let a stray click in the builder add to the owner's own
                wishlist on the live shop.
              */}
              <CartProvider token={PREVIEW_TOKEN}>
                <WishlistProvider token={PREVIEW_TOKEN}>
                <HomeSections
                  token={PREVIEW_TOKEN}
                  content={content}
                  theme={theme}
                  // The shop's OWN display settings, resolved server-side and
                  // passed straight through. Defaulting them here would show
                  // the owner a preview of a shop that is not theirs.
                  display={display}
                  // The BACK-OFFICE route, deliberately: the public one refuses
                  // to serve anything while the shop is closed, and building
                  // the page before opening is the point of the draft.
                  imageSrc={(imageId) => `/api/storefront-images/${imageId}`}
                  renderSection={(section, node) =>
                    /*
                     * A child of a column, or a section of the page?
                     *
                     * `indexOf` answers it: a child is not in the top-level
                     * list, so it comes back -1. That is the only signal this
                     * seam carries, and it is enough — the difference is exactly
                     * "does this have a place in the page order".
                     *
                     * A child gets the lighter wrapper: selectable and
                     * removable, but no drag handle and no duplicate. It is not
                     * sortable against the page, and a handle that does nothing
                     * is worse than no handle.
                     */
                    sectionIds.indexOf(section.id) === -1 ? (
                      <EditableChild
                        key={section.id}
                        section={section}
                        empty={node == null}
                        selected={selected === section.id}
                        onSelect={() => onSelect(section.id)}
                        onRemove={() => onRemove(section.id)}
                      >
                        {node}
                      </EditableChild>
                    ) : (
                    <EditableSection
                      key={section.id}
                      section={section}
                      index={sectionIds.indexOf(section.id)}
                      empty={node == null}
                      emptyReason={emptyReason(section, content, departments, theme)}
                      selected={selected === section.id}
                      atLimit={atLimit}
                      placing={placing}
                      over={over}
                      dropEdge={over === section.id ? dropEdge : null}
                      onSelect={() => onSelect(section.id)}
                      onToggle={(on) => onToggle(section.id, on)}
                      onDuplicate={() => onDuplicate(section.id)}
                      onRemove={() => onRemove(section.id)}
                    >
                      {node}
                    </EditableSection>
                    )
                  }
                />
                </WishlistProvider>
              </CartProvider>
            </SortableContext>

            {sections.length === 0 && (
              <div className="rounded-card border border-dashed border-border-strong px-6 py-12 text-center">
                <p className="text-sm font-medium text-ink">Your front page is empty</p>
                <p className="mx-auto mt-1 max-w-sm text-sm text-muted">
                  Shoppers land straight on your product list. Add a section to build one, or
                  start from a ready-made page.
                </p>
                {/* A button rather than a sentence pointing at the panel: the
                    panel's folds all start shut, so "drag one from over there"
                    would be directions to a heading somebody still has to open.
                    This opens it for them. */}
                <div className="mt-4 flex justify-center">
                  <Button variant="secondary" onClick={onShowPalette}>
                    <Icons.Plus size={15} />
                    Add a section
                  </Button>
                </div>
              </div>
            )}
          </div>

          {/* The footer, so the settings under Appearance have something to
              change. Not sortable — it is on every page, not a home-page block. */}
          {/* Same reasoning as the masthead — the shop's own footer, clickable. */}
          <button
            data-kit-ok
            type="button"
            onClick={onSelectAppearance}
            className="group relative block w-full border-t border-border bg-surface px-5 py-5 text-left"
            aria-label="Edit your footer"
          >
            <span className="block text-sm font-medium text-ink">{storeName}</span>
            <span className="mt-1 block text-sm text-muted">
              {theme.footerAbout || 'Opening hours, about your shop and social links.'}
            </span>
            <span className="pointer-events-none absolute right-3 top-3 rounded-pill bg-ink/80 px-2 py-0.5 text-xs font-medium text-surface opacity-0 transition group-hover:opacity-100">
              Hours, about and links
            </span>
          </button>
        </div>
      </div>
    </>
  )
}

/* ── One section, made editable ───────────────────────────────────────────── */

function EditableSection({
  section,
  index,
  empty,
  emptyReason,
  selected,
  atLimit,
  placing,
  over,
  dropEdge,
  onSelect,
  onToggle,
  onDuplicate,
  onRemove,
  children,
}: {
  section: HomeSection
  index: number
  empty: boolean
  emptyReason: string
  selected: boolean
  atLimit: boolean
  placing: boolean
  over: string | null
  /** Where the drop line goes while something is hovering here, if at all. */
  dropEdge: 'top' | 'bottom' | null
  onSelect: () => void
  onToggle: (on: boolean) => void
  onDuplicate: () => void
  onRemove: () => void
  children: ReactNode
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: section.id,
  })

  /*
   * Bring this section into view when it becomes the selected one.
   *
   * ── WHY THE CANVAS CHASES THE SELECTION ──────────────────────────────
   *
   * Selecting is no longer only something you do BY clicking the section — the
   * outline in the panel selects too, and after a drop the new section is
   * selected wherever it landed. In both cases the thing being edited can be
   * off-screen, and a panel full of settings for something you cannot see is
   * the problem this screen exists to solve.
   *
   * `block: 'nearest'` so a section already on screen is left exactly where it
   * is. Scrolling a visible thing to the middle of the pane yanks the page
   * under the cursor for no reason, which is worse than not scrolling at all.
   */
  const box = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    // Never mid-drag: the canvas is already being scrolled by dnd-kit's own
    // auto-scroll, and a second thing moving it fights the pointer.
    if (!selected || isDragging) return
    box.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [selected, isDragging])

  /*
   * Whether TODAY is inside this section's window, and what to say if not.
   *
   * The builder must show a scheduled section even when it is out of season —
   * a Christmas banner in June has to be visible and editable, or nobody can
   * set it up in advance, which is the entire point of scheduling. The shop
   * hides it; here it is merely marked.
   */
  const scheduledNow = isScheduledNow(section)
  const from = section.showFrom?.trim() ?? ''
  const until = section.showUntil?.trim() ?? ''
  const scheduleNote = !scheduledNow && from && shopToday() < from ? `From ${from}` : `Ended ${until}`

  return (
    <>
      <div
        // Both: dnd-kit measures this element, and the scroll-into-view above
        // needs to reach it. A ref callback rather than passing `box` to
        // useSortable, because dnd-kit owns the shape of its own ref.
        ref={(node) => {
          setNodeRef(node)
          box.current = node
        }}
        style={{ transform: CSS.Transform.toString(transform), transition }}
        className={`group relative mb-4 ${isDragging ? 'z-10 opacity-60' : ''}`}
      >
        {/* Where it would land. Drawn on the edge the section would arrive at,
            so the line is under the cursor's intent rather than merely near
            it. */}
        {dropEdge && (
          <span
            aria-hidden
            className={`pointer-events-none absolute inset-x-0 z-[3] h-0.5 rounded-pill bg-brand ${
              dropEdge === 'top' ? '-top-2' : '-bottom-2'
            }`}
          />
        )}

        {/* pointer-events-none on the CONTENT so a category tile cannot navigate
            the admin page away to the storefront, and `outline` rather than
            `border` so selecting a section does not shift the layout under the
            cursor. */}
        {/* Dimmed for either reason — off, or not in season — because both
            mean "a shopper is not seeing this right now", which is the thing
            the eye needs to pick up while scanning the page. The badge above
            says which. */}
        <div
          className={`pointer-events-none rounded-card ${
            section.enabled && scheduledNow ? '' : 'opacity-40'
          }`}
          style={
            selected ? { outline: '2px solid var(--color-brand)', outlineOffset: 4 } : undefined
          }
        >
          {empty ? <EmptySection section={section} reason={emptyReason} /> : children}
        </div>

        {/* The click target, under the toolbar. An invisible overlay covering
            the whole section — it has no appearance of its own to inherit from a
            Button, and giving it one would draw a control over the preview. */}
        <button
          data-kit-ok
          type="button"
          aria-label={`Edit ${sectionName(section)}`}
          onClick={onSelect}
          className="absolute inset-0 z-[1] cursor-pointer rounded-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
        />

        {/* The toolbar. Appears on hover or when selected, so a page being read
            is not covered in chrome. */}
        <div
          className={`absolute -top-3 right-2 z-[2] flex items-center gap-1 rounded-pill border border-border bg-surface px-1.5 py-1 shadow-pop transition ${
            selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-within:opacity-100'
          }`}
        >
          <span
            {...attributes}
            {...listeners}
            role="button"
            tabIndex={0}
            aria-label={`Drag ${sectionName(section)}`}
            title="Drag to reorder"
            className="flex size-7 cursor-grab items-center justify-center rounded-pill text-muted transition hover:bg-surface-2 hover:text-ink active:cursor-grabbing"
          >
            <Icons.ArrowLeftRight size={14} className="rotate-90" />
          </span>

          <span className="px-1 text-xs font-medium text-ink">{sectionName(section)}</span>

          <Switch
            checked={section.enabled}
            onChange={onToggle}
            ariaLabel={`Show ${sectionName(section)} in the shop`}
          />

          {/* Copy, then delete — the two things an owner reaches for once the
              page has a shape. Duplicating is the common one: a second product
              row for a different department is otherwise four fields retyped. */}
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            aria-label={`Duplicate ${sectionName(section)}`}
            title="Make a copy"
            disabled={atLimit}
            onClick={onDuplicate}
          >
            <Icons.Copy size={14} />
          </Button>

          {/* No confirmation, deliberately: undo covers it, and a dialog for
              every removed section makes rearranging a page feel like filling
              in a form. */}
          <Button
            variant="danger-ghost"
            size="sm"
            iconOnly
            aria-label={`Remove ${sectionName(section)}`}
            title="Remove"
            onClick={onRemove}
          >
            <Icons.Trash size={14} />
          </Button>
        </div>

        {/* Sits ABOVE the section, beside the toolbar, rather than over its
            first line — at top-2 it covered the section's own heading, which is
            the one thing you need to read to know what you are unhiding.

            "Hidden" wins over the schedule when both apply: switching a
            section off is a decision the owner just made, and telling them it
            is "out of season" instead would answer a question they did not
            ask. */}
        {!section.enabled ? (
          <span className="pointer-events-none absolute -top-3 left-2 z-[2] rounded-pill bg-ink/80 px-2 py-0.5 text-xs font-medium text-surface">
            Hidden
          </span>
        ) : (
          !scheduledNow && (
            <span className="pointer-events-none absolute -top-3 left-2 z-[2] rounded-pill bg-warning px-2 py-0.5 text-xs font-medium text-warning-ink">
              {scheduleNote}
            </span>
          )
        )}
      </div>

      {/* Where a dragged section lands if it is dropped directly BELOW this
          one. */}
      <InsertPoint index={index + 1} atLimit={atLimit} placing={placing} over={over} />
    </>
  )
}

/** The id a gap answers to while something is being dropped into it. */
export const GAP_PREFIX = 'gap:'

/** The index a gap drop lands at, or null if the id is not a gap. */
export function gapIndex(id: string | null): number | null {
  if (!id || !id.startsWith(GAP_PREFIX)) return null
  const index = Number(id.slice(GAP_PREFIX.length))
  return Number.isFinite(index) ? index : null
}

/**
 * The landing strip between two sections.
 *
 * ── WHY A GAP AND NOT A MENU ─────────────────────────────────────────────
 *
 * This used to be a hover-revealed "Add here" dropdown, and it worked — you
 * could already add a section anywhere on the page. Nobody found it. A control
 * that is invisible until the pointer crosses a 16px band is a control most
 * owners never learn exists, which is why "add a section" still felt like
 * something that only ever happened at the bottom.
 *
 * So the gap stopped being a thing you click and became a thing you drop onto.
 * The palette in the panel is now what says "you can add a section", and it is
 * visible without being opened; these are where it can go.
 *
 * ── WHY IT ONLY APPEARS WHILE SOMETHING IS IN FLIGHT ─────────────────────
 *
 * At rest it is invisible and nearly heightless, for the same reason it always
 * was: the canvas is a live preview, and a preview laddered with grey dashes is
 * showing the owner a page that is not their page. The moment a tile is picked
 * up, every gap lights up — an owner aiming a drop must be able to see what
 * they are aiming at.
 */
function InsertPoint({
  index,
  atLimit,
  placing,
  over,
}: {
  index: number
  atLimit: boolean
  /** True while a palette tile is in flight — see above. */
  placing: boolean
  over: string | null
}) {
  const id = `${GAP_PREFIX}${index}`
  const { setNodeRef } = useDroppable({ id, disabled: atLimit || !placing })

  if (atLimit) return null

  const active = over === id

  return (
    // Negative margins pull this INTO the gap the sections already leave, so
    // it costs almost no height at rest. An insert point that reserved its own
    // band would make the builder visibly looser than the shop — the one thing
    // a live preview must not be.
    //
    // While placing, it grows to a real target: a 4px strip is not something
    // anybody can hit reliably with a section held under the cursor.
    <div
      ref={setNodeRef}
      className={`relative flex items-center justify-center transition-all ${
        placing ? 'my-1 h-10' : '-my-2 h-4'
      }`}
    >
      {placing && (
        <span
          className={`pointer-events-none absolute inset-x-0 flex h-full items-center justify-center rounded-control border border-dashed transition ${
            active
              ? 'border-brand bg-brand-soft'
              : 'border-border-strong bg-surface-2/40'
          }`}
        >
          <span
            className={`text-xs font-medium transition ${active ? 'text-brand-ink' : 'text-muted'}`}
          >
            {active ? 'Drop it here' : 'Here'}
          </span>
        </span>
      )}
    </div>
  )
}

/**
 * What a section that would render nothing looks like in the builder.
 *
 * The shop draws nothing at all; here it has to be visible or an owner cannot
 * select it to fix it — and would publish a section that silently never
 * appears.
 */
function EmptySection({ section, reason }: { section: HomeSection; reason: string }) {
  return (
    <div className="rounded-card border border-dashed border-border-strong bg-surface-2/50 px-5 py-8 text-center">
      <p className="text-sm font-medium text-ink">{sectionName(section)}</p>
      <p className="mx-auto mt-1 max-w-sm text-sm text-muted">{reason}</p>
    </div>
  )
}

/**
 * The bar above the page: how wide to draw the preview.
 *
 * "Add a section" used to live here as a dropdown, and adding at the END was
 * all it could do — the button had no way to know where on the page you wanted
 * the thing. That is now the palette's job in the panel, where a tile can be
 * carried to a spot. See `SectionPalette`.
 */
function CanvasToolbar({
  width,
  onWidthChange,
}: {
  width: PreviewWidth
  onWidthChange: (width: PreviewWidth) => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-border bg-surface-2/60 px-5 py-3">
      <div className="ml-auto flex items-center gap-2">
        <span className="text-sm text-muted">Preview</span>
        <SegmentedControl<PreviewWidth>
          value={width}
          onChange={onWidthChange}
          aria-label="How wide to draw the preview"
          options={[
            { value: 'desktop', label: 'Computer' },
            { value: 'tablet', label: 'Tablet' },
            { value: 'phone', label: 'Phone' },
          ]}
        />
      </div>
    </div>
  )
}

/**
 * Why a section would render nothing today.
 *
 * Per RULE, not merely per kind: "you haven't picked anything" and "that
 * department publishes nothing" are different problems with different fixes,
 * and telling an owner the wrong one sends them to the wrong panel.
 */
function emptyReason(
  section: HomeSection,
  content: SectionContent[],
  departments: StorefrontDepartment[],
  theme: StorefrontTheme,
): string {
  switch (section.kind) {
    case 'hero':
      return theme.heroHeadline || theme.heroSubtext
        ? ''
        : 'Write a welcome headline under Appearance and it appears here.'

    case 'banner':
      // Two different problems again: never chose a picture, versus chose one
      // that has since been deleted from the library.
      return section.imageId
        ? 'That picture has been deleted. Choose another in the panel on the right.'
        : 'Choose a picture in the panel on the right.'

    case 'carousel': {
      const slides = section.slides ?? []
      if (slides.length === 0) return 'No pictures yet. Add one in the panel on the right.'
      // Three different problems, three different fixes — and the third is the
      // one nobody would work out alone: the slides are all there, they simply
      // point at pictures that have since been deleted from the library.
      return slides.some((s) => s.imageId)
        ? 'Those pictures have been deleted. Choose others in the panel on the right.'
        : 'None of these have a picture yet. Choose one for each in the panel on the right.'
    }

    case 'text':
      return 'Nothing written yet. Type something in the panel on the right.'

    case 'split':
      // Two halves, two different things missing, two different fixes.
      if (!section.imageId) return 'Choose a picture in the panel on the right.'
      if (!(section.bodyText?.trim() || section.title)) {
        return 'Add a heading or some words beside the picture.'
      }
      return 'That picture has been deleted. Choose another in the panel on the right.'

    case 'reviews':
      /*
       * Not a fault, and saying so matters.
       *
       * This row fills itself from the review queue, so an owner who "fixes"
       * it is fixing something that is working. The likely cause is simply
       * that nothing has been approved yet — which for a new shop is normal.
       */
      return 'No approved reviews match yet. This fills itself as reviews come in and you approve them.'

    case 'countdown':
      if (!(section.endsAt?.trim() ?? '') && !section.specialId) {
        return 'Choose a special, or type the date and time it ends.'
      }
      return 'The time is up. Write something for it to say afterwards, or remove it.'

    case 'richtext':
      return 'Nothing written yet. Add a line in the panel on the right.'

    case 'testimonial':
      return 'No quotes yet. Add one in the panel on the right.'

    case 'logos':
      // Same two problems a banner has: never chose any, or chose ones that
      // have since been deleted from the library.
      return (section.logoImageIds?.length ?? 0) > 0
        ? 'Those pictures have been deleted. Choose others in the panel on the right.'
        : 'No logos yet. Add one in the panel on the right.'

    case 'video':
      return 'Paste the video’s link in the panel on the right.'

    case 'map':
      return 'Type your address in the panel on the right.'

    case 'categories':
      return departments.length
        ? ''
        : 'No departments are published yet. Tick the ones you sell online under Departments.'

    case 'cards':
      return 'No cards yet. Add one in the panel on the right.'

    case 'products': {
      const found = content.find((c) => c.section.id === section.id)?.products ?? []
      if (found.length > 0) return ''
      if (section.source === 'department') {
        return section.departmentId
          ? 'That department has nothing published in it yet.'
          : 'Pick a department in the panel on the right.'
      }
      if (section.source === 'special') {
        // The row is not broken — it is correctly empty, and will fill itself
        // the moment a special starts. Saying so stops an owner "fixing" a
        // rule that is working.
        return 'Nothing is on special right now. This row fills itself when something is.'
      }
      if (section.source === 'popular') {
        return 'Nothing published has sold in the last 90 days yet.'
      }
      if (section.source === 'manual') {
        // Two different problems, two different fixes. "Nothing here" would
        // send someone to add more picks when the ones they have are the
        // problem — they stopped being published.
        return (section.productIds?.length ?? 0) > 0
          ? 'Nothing you picked is published any more. Check the list on the right.'
          : 'Use “Add products” in the panel on the right to fill this row.'
      }
      return 'No published products yet. Tick the departments you sell online.'
    }

    default:
      return ''
  }
}

export type { PreviewWidth }

/* ── Dropping into a column ───────────────────────────────────────────────── */

/**
 * The id a landing strip INSIDE a column answers to.
 *
 * ── WHY A THIRD PART, AND WHY ENCODED IN THE ID ──────────────────────────
 *
 * dnd-kit hands the drop handler one string and nothing else, so wherever a
 * drop can land has to be nameable as a string. A top-level gap needs one
 * number — `gap:3` is "position three on the page". A column needs three: which
 * section holds the columns, which column, and where in it.
 *
 * The section is named by ID rather than by index, deliberately. An index would
 * be read against an array that the drop itself is about to change, which is
 * exactly the off-by-one the top-level gap handler already documents having
 * been bitten by. An id survives the reorder.
 */
export const COLUMN_GAP_PREFIX = 'colgap:'

export type ColumnGapTarget = { sectionId: string; column: number; index: number }

/** Where a column drop lands, or null if the id names something else. */
export function columnGapTarget(id: string | null): ColumnGapTarget | null {
  if (!id || !id.startsWith(COLUMN_GAP_PREFIX)) return null
  const [sectionId, column, index] = id.slice(COLUMN_GAP_PREFIX.length).split('|')
  const c = Number(column)
  const i = Number(index)
  /*
   * A section id can contain almost anything, so the parts are split on a
   * character an id cannot hold rather than on the '-' that every generated id
   * is full of. Anything that does not parse is not a target — better a drop
   * that does nothing than one that lands in a column nobody pointed at.
   */
  if (!sectionId || !Number.isInteger(c) || !Number.isInteger(i)) return null
  return { sectionId, column: c, index: i }
}

export function columnGapId(sectionId: string, column: number, index: number): string {
  return `${COLUMN_GAP_PREFIX}${sectionId}|${column}|${index}`
}

/**
 * A block inside a column, on the canvas.
 *
 * ── LIGHTER THAN A SECTION, DELIBERATELY ─────────────────────────────────
 *
 * No drag handle and no duplicate. A child is not sortable against the page —
 * it belongs to a column — and a handle that lifts nothing is worse than an
 * absent one: it invites a gesture and then does not answer it. Reordering
 * within a column is the arrows in the inspector, which are also the only
 * keyboard path.
 *
 * Selecting and removing ARE here, because those are the two things somebody
 * wants while looking at the page rather than at a list of names.
 */
function EditableChild({
  section,
  empty,
  selected,
  onSelect,
  onRemove,
  children,
}: {
  section: HomeSection
  empty: boolean
  selected: boolean
  onSelect: () => void
  onRemove: () => void
  children: ReactNode
}) {
  return (
    <div
      /*
        pointer-events-auto, and above the parent's own click target.

        A child is drawn INSIDE the columns section, whose content that section
        makes pointer-events-none and then covers with a full-bleed overlay at
        z-[1]. Both have to be undone here, or clicking a block selects the whole
        side-by-side section instead — which is not a styling detail: it is the
        difference between a child being editable and not.
      */
      className={`group pointer-events-auto relative z-[2] rounded-card transition ${
        selected ? 'ring-2 ring-brand' : 'hover:ring-1 hover:ring-border-strong'
      }`}
    >
      {/*
        The click target is the whole block, and it sits UNDER the content
        rather than over it: a transparent sheet on top would swallow a click
        meant for the picture picker's own preview, and the canvas is already
        pointer-events-none for the shop's own controls.
      */}
      <button
        data-kit-ok
        type="button"
        onClick={onSelect}
        aria-label={`Edit ${sectionName(section)}`}
        className="absolute inset-0 z-[1] cursor-pointer rounded-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
      />

      <div className="pointer-events-none">
        {empty ? (
          <p className="rounded-card border border-dashed border-border-strong px-3 py-6 text-center text-xs text-muted">
            {sectionName(section)} — nothing to show yet
          </p>
        ) : (
          children
        )}
      </div>

      {/* Only on hover or while selected: a toolbar on every block at rest
          would bury the page it is previewing. */}
      <div
        className={`absolute right-1 top-1 z-[2] flex gap-1 transition ${
          selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-within:opacity-100'
        }`}
      >
        <Button
          variant="secondary"
          size="sm"
          iconOnly
          aria-label={`Remove ${sectionName(section)}`}
          onClick={onRemove}
        >
          <Icons.Trash size={13} />
        </Button>
      </div>
    </div>
  )
}
