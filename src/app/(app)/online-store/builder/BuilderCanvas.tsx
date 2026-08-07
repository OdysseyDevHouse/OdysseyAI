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
  type DragStartEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Icons, Menu, MenuItem, Switch } from '@/components/ui'
import {
  MAX_SECTIONS,
  SECTION_HINT,
  SECTION_KINDS,
  SECTION_LABEL,
  type HomeSection,
  type SectionKind,
  type StorefrontTheme,
} from '@/lib/storefrontModel'
import type { StorefrontDepartment, StorefrontProduct } from '@/lib/site/storefront'
import HomeSections, {
  type ProductDisplay,
  type SectionContent,
} from '@/app/store/[token]/HomeSections'
import { CartProvider } from '@/app/store/[token]/CartContext'

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

export function BuilderCanvas({
  sections,
  content,
  theme,
  display,
  storeName,
  blurb,
  departments,
  selected,
  onSelect,
  onReorder,
  onToggle,
  onAdd,
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
  onSelect: (id: string) => void
  onReorder: (from: string, to: string) => void
  onToggle: (id: string, enabled: boolean) => void
  onAdd: (kind: SectionKind) => void
  /** Clicking the masthead or footer opens the shop-wide settings. */
  onSelectAppearance: () => void
}) {
  /** Which section is under the cursor right now. Only set during a drag. */
  const [dragging, setDragging] = useState<string | null>(null)

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

  function handleDragEnd(event: DragEndEvent) {
    setDragging(null)
    const { active, over } = event
    if (!over || active.id === over.id) return
    onReorder(String(active.id), String(over.id))
  }

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
      onDragEnd={handleDragEnd}
      /* Escape mid-drag must clear it too, or the overlay chip stays parked
         over the canvas and swallows every click after it. */
      onDragCancel={() => setDragging(null)}
      accessibility={{
        announcements: {
          onDragStart: ({ active }) =>
            `Picked up ${nameOf(active.id)}. Use the arrow keys to move it, space to drop.`,
          onDragOver: ({ active, over }) =>
            over ? `${nameOf(active.id)} is over ${nameOf(over.id)}.` : '',
          onDragEnd: ({ active, over }) =>
            over
              ? `${nameOf(active.id)} moved to position ${
                  sectionIds.indexOf(String(over.id)) + 1
                } of ${sectionIds.length}.`
              : `${nameOf(active.id)} was dropped.`,
          onDragCancel: ({ active }) => `Moving ${nameOf(active.id)} was cancelled.`,
        },
      }}
    >
      {/* The shop's own colour, scoped to the preview so `text-brand` inside
          follows the store's theme rather than the app's. */}
      <div
        className="min-h-full bg-canvas"
        style={{ '--color-brand': theme.brandColour } as React.CSSProperties}
      >
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
          <span className="block truncate text-base font-semibold text-ink">{storeName}</span>
          {blurb && <span className="block truncate text-sm text-muted">{blurb}</span>}
          <span className="pointer-events-none absolute right-3 top-3 rounded-pill bg-ink/80 px-2 py-0.5 text-xs font-medium text-surface opacity-0 transition group-hover:opacity-100">
            Name, colour and welcome
          </span>
        </button>

        <InsertBar atLimit={atLimit} onAdd={onAdd} />

        <div className="px-5 py-5">
          <SortableContext items={sectionIds} strategy={verticalListSortingStrategy}>
            {/* The cart provider the storefront layout mounts: ProductGrid's
                Add button calls useCart, which THROWS without one — so the
                preview needs it or the whole canvas fails to render. */}
            <CartProvider token={PREVIEW_TOKEN}>
              <HomeSections
                token={PREVIEW_TOKEN}
                content={content}
                theme={theme}
                // The shop's OWN display settings, resolved server-side and
                // passed straight through. Defaulting them here would show
                // the owner a preview of a shop that is not theirs.
                display={display}
                renderSection={(section, node) => (
                  <EditableSection
                    key={section.id}
                    section={section}
                    empty={node == null}
                    emptyReason={emptyReason(section, content, departments, theme)}
                    selected={selected === section.id}
                    onSelect={() => onSelect(section.id)}
                    onToggle={(on) => onToggle(section.id, on)}
                  >
                    {node}
                  </EditableSection>
                )}
              />
            </CartProvider>
          </SortableContext>

          {sections.length === 0 && (
            <div className="rounded-card border border-dashed border-border-strong px-6 py-12 text-center">
              <p className="text-sm font-medium text-ink">Your front page is empty</p>
              <p className="mx-auto mt-1 max-w-sm text-sm text-muted">
                Shoppers land straight on your product list. Add a section above to build a
                proper front page.
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
  empty,
  emptyReason,
  selected,
  onSelect,
  onToggle,
  children,
}: {
  section: HomeSection
  empty: boolean
  emptyReason: string
  selected: boolean
  onSelect: () => void
  onToggle: (on: boolean) => void
  children: ReactNode
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: section.id,
  })

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`group relative mb-4 ${isDragging ? 'z-10 opacity-60' : ''}`}
    >
      {/* pointer-events-none on the CONTENT so a category tile cannot navigate
          the admin page away to the storefront, and `outline` rather than
          `border` so selecting a section does not shift the layout under the
          cursor. */}
      <div
        className={`pointer-events-none rounded-card ${section.enabled ? '' : 'opacity-40'}`}
        style={selected ? { outline: '2px solid var(--color-brand)', outlineOffset: 4 } : undefined}
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
      </div>

      {/* Sits ABOVE the section, beside the toolbar, rather than over its
          first line — at top-2 it covered the section's own heading, which is
          the one thing you need to read to know what you are unhiding. */}
      {!section.enabled && (
        <span className="pointer-events-none absolute -top-3 left-2 z-[2] rounded-pill bg-ink/80 px-2 py-0.5 text-xs font-medium text-surface">
          Hidden
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

/** "Add a section" — one bar, above the page. */
function InsertBar({ atLimit, onAdd }: { atLimit: boolean; onAdd: (kind: SectionKind) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-border bg-surface-2/60 px-5 py-3">
      {atLimit ? (
        <span className="text-sm text-muted">
          {MAX_SECTIONS} sections is the most one page can have. Remove one to add another.
        </span>
      ) : (
        <>
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
          <span className="text-sm text-muted">
            It appears at the bottom — drag it where you want it.
          </span>
        </>
      )}
    </div>
  )
}

function sectionName(section: HomeSection): string {
  return section.title.trim() || SECTION_LABEL[section.kind]
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
      if (section.source === 'manual') {
        // Two different problems, two different fixes. "Nothing here" would
        // send someone to add more picks when the ones they have are the
        // problem — they stopped being published.
        return (section.productIds?.length ?? 0) > 0
          ? 'Nothing you picked is published any more. Check the list on the right.'
          : 'Search for products in the panel on the right to fill this row.'
      }
      return 'No published products yet. Tick the departments you sell online.'
    }

    default:
      return ''
  }
}
