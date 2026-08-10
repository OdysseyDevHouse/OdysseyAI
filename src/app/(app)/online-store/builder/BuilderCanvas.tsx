'use client'

import { useState, type ReactNode } from 'react'
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCorners,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Button, Icons, Menu, MenuItem, SegmentedControl, Switch } from '@/components/ui'
import {
  MAX_SECTIONS,
  SECTION_KINDS,
  SECTION_LABEL,
  isScheduledNow,
  // One definition, shared with the publish summary — two copies of "what do
  // we call this section" would drift the moment either changed.
  sectionName,
  shopToday,
  type HomeSection,
  type SectionKind,
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
const WIDTHS = { phone: 'max-w-[390px]', desktop: 'max-w-none' } as const
type PreviewWidth = keyof typeof WIDTHS

export function BuilderCanvas({
  sections,
  content,
  theme,
  display,
  storeName,
  blurb,
  departments,
  selected,
  width,
  onWidthChange,
  onSelect,
  onReorder,
  onToggle,
  onAdd,
  onInsert,
  onDuplicate,
  onRemove,
  onSelectAppearance,
}: {
  sections: HomeSection[]
  content: SectionContent[]
  theme: StorefrontTheme
  /** The shop's display choices, so the preview matches the shop. */
  display: ProductDisplay
  storeName: string
  blurb: string
  departments: StorefrontDepartment[]
  selected: string | null
  width: PreviewWidth
  onWidthChange: (width: PreviewWidth) => void
  onSelect: (id: string) => void
  onReorder: (from: string, to: string) => void
  onToggle: (id: string, enabled: boolean) => void
  onAdd: (kind: SectionKind) => void
  /** Add a section AT an index — the between-sections insert points. */
  onInsert: (kind: SectionKind, index: number) => void
  onDuplicate: (id: string) => void
  onRemove: (id: string) => void
  /** Clicking the masthead or footer opens the shop-wide settings. */
  onSelectAppearance: () => void
}) {
  /** Which section is being dragged right now. Only set during a drag. */
  const [dragging, setDragging] = useState<string | null>(null)
  /**
   * Which section it is currently hovering over, so a line can be drawn where
   * it would land. Tracked separately from `dragging` because dnd-kit reports
   * the two in different events.
   */
  const [over, setOver] = useState<string | null>(null)

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    // Long-press before a drag starts, so the canvas can still be scrolled
    // with a finger on a tablet.
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const sectionIds = sections.map((s) => s.id)
  const atLimit = sections.length >= MAX_SECTIONS

  const nameOf = (id: unknown) => {
    const found = sections.find((s) => s.id === String(id))
    return found ? sectionName(found) : 'Section'
  }

  function handleDragStart(event: DragStartEvent) {
    const id = String(event.active.id)
    setDragging(id)
    // Selecting on lift means the inspector already shows the right panel by
    // the time the section lands.
    onSelect(id)
  }

  function handleDragOver(event: DragOverEvent) {
    setOver(event.over ? String(event.over.id) : null)
  }

  function handleDragEnd(event: DragEndEvent) {
    setDragging(null)
    setOver(null)
    const { active, over: target } = event
    if (!target || active.id === target.id) return
    onReorder(String(active.id), String(target.id))
  }

  /*
   * Where the drop line is drawn.
   *
   * A splice, not a swap (see `reorder` in Builder.tsx), so the line goes
   * ABOVE the hovered section when travelling up the page and BELOW it when
   * travelling down — which is exactly where the dragged section will come to
   * rest. Getting this backwards is what makes a drag feel like it did
   * something other than what was shown.
   */
  const fromIndex = dragging ? sectionIds.indexOf(dragging) : -1
  const overIndex = over ? sectionIds.indexOf(over) : -1
  const dropEdge: 'top' | 'bottom' | null =
    fromIndex === -1 || overIndex === -1 || fromIndex === overIndex
      ? null
      : overIndex < fromIndex
        ? 'top'
        : 'bottom'

  return (
    <DndContext
      /*
       * A FIXED id, because dnd-kit otherwise derives its aria-describedby
       * ids from a module-level counter. The server starts that counter at 0
       * on every render while the browser continues from wherever it already
       * was, so the two disagree and React reports a hydration mismatch on
       * every load. Naming the context makes both sides derive the same ids.
       */
      id="storefront-builder"
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      /* Escape mid-drag must clear it too, or the overlay chip stays parked
         over the canvas and swallows every click after it. */
      onDragCancel={() => {
        setDragging(null)
        setOver(null)
      }}
      accessibility={{
        announcements: {
          onDragStart: ({ active }) =>
            `Picked up ${nameOf(active.id)}. Use the arrow keys to move it, space to drop.`,
          onDragOver: ({ active, over: target }) =>
            target ? `${nameOf(active.id)} is over ${nameOf(target.id)}.` : '',
          onDragEnd: ({ active, over: target }) =>
            target
              ? `${nameOf(active.id)} moved to position ${
                  sectionIds.indexOf(String(target.id)) + 1
                } of ${sectionIds.length}.`
              : `${nameOf(active.id)} was dropped.`,
          onDragCancel: ({ active }) => `Moving ${nameOf(active.id)} was cancelled.`,
        },
      }}
    >
      <CanvasToolbar atLimit={atLimit} width={width} onWidthChange={onWidthChange} onAdd={onAdd} />

      {/* The shop's own colour, scoped to the preview so `text-brand` inside
          follows the store's theme rather than the app's. */}
      <div
        className="min-h-full bg-canvas"
        style={{ '--color-brand': theme.brandColour } as React.CSSProperties}
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
            <InsertPoint index={0} atLimit={atLimit} onInsert={onInsert} />

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
                  renderSection={(section, node) => (
                    <EditableSection
                      key={section.id}
                      section={section}
                      index={sectionIds.indexOf(section.id)}
                      empty={node == null}
                      emptyReason={emptyReason(section, content, departments, theme)}
                      selected={selected === section.id}
                      atLimit={atLimit}
                      dropEdge={over === section.id ? dropEdge : null}
                      onSelect={() => onSelect(section.id)}
                      onToggle={(on) => onToggle(section.id, on)}
                      onDuplicate={() => onDuplicate(section.id)}
                      onRemove={() => onRemove(section.id)}
                      onInsert={onInsert}
                    >
                      {node}
                    </EditableSection>
                  )}
                />
                </WishlistProvider>
              </CartProvider>
            </SortableContext>

            {sections.length === 0 && (
              <div className="rounded-card border border-dashed border-border-strong px-6 py-12 text-center">
                <p className="text-sm font-medium text-ink">Your front page is empty</p>
                <p className="mx-auto mt-1 max-w-sm text-sm text-muted">
                  Shoppers land straight on your product list. Add a section above, or start from
                  a ready-made page in the panel on the right.
                </p>
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

      {/* A label chip, never the real section: cloning a twelve-product grid
          every frame drops the drag to a crawl.

          Keyed off `dragging`, NOT `selected` — DragOverlay portals a floating
          element at the cursor, so leaving it mounted for a merely SELECTED
          section parks an invisible chip over the canvas that eats every
          subsequent click. */}
      <DragOverlay>
        {dragging ? (
          <div className="rounded-card bg-brand px-3 py-2 text-sm font-medium text-white shadow-pop">
            {nameOf(dragging)}
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
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
  dropEdge,
  onSelect,
  onToggle,
  onDuplicate,
  onRemove,
  onInsert,
  children,
}: {
  section: HomeSection
  index: number
  empty: boolean
  emptyReason: string
  selected: boolean
  atLimit: boolean
  /** Where the drop line goes while something is hovering here, if at all. */
  dropEdge: 'top' | 'bottom' | null
  onSelect: () => void
  onToggle: (on: boolean) => void
  onDuplicate: () => void
  onRemove: () => void
  onInsert: (kind: SectionKind, index: number) => void
  children: ReactNode
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: section.id,
  })

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
        ref={setNodeRef}
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

      {/* Add a section directly BELOW this one. */}
      <InsertPoint index={index + 1} atLimit={atLimit} onInsert={onInsert} />
    </>
  )
}

/**
 * The thin "add one here" line between two sections.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────
 *
 * Every new section used to land at the bottom, and the toolbar had to
 * apologise for it — "it appears at the bottom, drag it where you want it".
 * On a page of eight sections that is a long drag to do something the owner
 * had already decided before clicking Add.
 *
 * Invisible until hovered, so a page being READ is not a ladder of grey
 * dashes. It keeps a small always-there hit area rather than collapsing to
 * nothing, because a control you have to find by sweeping the mouse is not
 * really there.
 */
function InsertPoint({
  index,
  atLimit,
  onInsert,
}: {
  index: number
  atLimit: boolean
  onInsert: (kind: SectionKind, index: number) => void
}) {
  if (atLimit) return null

  return (
    // Negative margins pull this INTO the gap the sections already leave, so
    // it costs almost no height at rest. An insert point that reserved its own
    // band would make the builder visibly looser than the shop — the one thing
    // a live preview must not be.
    <div className="group/insert relative -my-2 flex h-4 items-center justify-center">
      <span className="pointer-events-none absolute inset-x-0 h-px bg-brand opacity-0 transition group-hover/insert:opacity-40" />
      <div className="relative opacity-0 transition group-hover/insert:opacity-100 focus-within:opacity-100">
        <Menu
          variant="secondary"
          label={
            <>
              <Icons.Plus size={13} />
              Add here
            </>
          }
        >
          {SECTION_KINDS.map((kind) => (
            <MenuItem key={kind} onClick={() => onInsert(kind, index)}>
              {SECTION_LABEL[kind]}
            </MenuItem>
          ))}
        </Menu>
      </div>
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

/** The bar above the page: add a section, and how wide to draw the preview. */
function CanvasToolbar({
  atLimit,
  width,
  onWidthChange,
  onAdd,
}: {
  atLimit: boolean
  width: PreviewWidth
  onWidthChange: (width: PreviewWidth) => void
  onAdd: (kind: SectionKind) => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-border bg-surface-2/60 px-5 py-3">
      {atLimit ? (
        <span className="text-sm text-muted">
          {MAX_SECTIONS} sections is the most one page can have. Remove one to add another.
        </span>
      ) : (
        <Menu
          variant="secondary"
          label={
            <>
              <Icons.Plus size={15} />
              Add a section
            </>
          }
        >
          {SECTION_KINDS.map((kind) => (
            <MenuItem key={kind} onClick={() => onAdd(kind)}>
              {SECTION_LABEL[kind]}
            </MenuItem>
          ))}
        </Menu>
      )}

      <div className="ml-auto flex items-center gap-2">
        <span className="text-sm text-muted">Preview</span>
        <SegmentedControl<PreviewWidth>
          value={width}
          onChange={onWidthChange}
          aria-label="How wide to draw the preview"
          options={[
            { value: 'desktop', label: 'Computer' },
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
