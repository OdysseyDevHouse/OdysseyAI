'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmModal,
  EmptyState,
  Field,
  Icons,
  Input,
  Modal,
  Select,
  Switch,
  useToast,
} from '@/components/ui'
import { safeSlug, slugProblem } from '@/lib/storefrontModel'
import PicturePicker from '@/components/PicturePicker'
import type { StorefrontImage } from '@/lib/site/storefrontImages'
import type { StorefrontPage } from '@/lib/site/storefrontPages'
import {
  createPageAction,
  deletePageAction,
  reorderPagesAction,
  savePageSettingsAction,
} from './actions'

/**
 * The shop's pages: what exists, what the public can reach, and in what order.
 *
 * ── THIS SCREEN IS NOT THE BUILDER ───────────────────────────────────────
 *
 * Arranging a page's SECTIONS happens in the builder; this owns everything
 * else about a page — its name, its address, whether it is switched on, where
 * it sits in the nav. Keeping them apart is what lets the builder stay a
 * canvas rather than growing a settings sidebar it would have to hide on the
 * front page.
 *
 * ── SWITCHED ON IS THE ONE THAT MATTERS ──────────────────────────────────
 *
 * A page can be fully written and deliberately unreachable, and that is the
 * state owners find confusing — they publish in the builder and expect the
 * page to appear. So the switch is a column of its own, worded as the shopper
 * question ("On the shop") rather than the database one.
 */
export default function PagesList({
  pages,
  departments,
  departmentPaths,
  storePath,
  storeOpen,
  images,
}: {
  pages: StorefrontPage[]
  /**
   * Departments with no page yet — the only ones worth offering. Sub-departments
   * included on the same terms as top-level ones, each carrying the full path
   * it is known by.
   */
  departments: { id: number; name: string; path: string; depth: number }[]
  /** Full path per department that already has a page, keyed by department id. */
  departmentPaths: Record<number, string>
  storePath: string
  storeOpen: boolean
  /** The shop's picture library, for the share-image picker. */
  images: StorefrontImage[]
}) {
  const router = useRouter()
  const toast = useToast()
  const [busy, startAction] = useTransition()

  const [addOpen, setAddOpen] = useState(false)
  const [editing, setEditing] = useState<StorefrontPage | null>(null)
  const [removing, setRemoving] = useState<StorefrontPage | null>(null)

  const standard = pages.filter((p) => p.kind === 'standard')
  const home = pages.find((p) => p.kind === 'home') ?? null
  // By path, so a parent sits above its own children rather than wherever the
  // insertion order happened to put it.
  const departmentPages = pages
    .filter((p) => p.kind === 'department')
    .sort((a, b) =>
      (departmentPaths[a.departmentId ?? 0] ?? a.title).localeCompare(
        departmentPaths[b.departmentId ?? 0] ?? b.title,
      ),
    )
  const productPageRow = pages.find((p) => p.kind === 'product') ?? null

  function toggle(page: StorefrontPage, field: 'isPublished' | 'showInNav', value: boolean) {
    startAction(async () => {
      const result = await savePageSettingsAction(page.id, { [field]: value })
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      router.refresh()
    })
  }

  /** Move a page one place in the nav. */
  function move(index: number, by: number) {
    const to = index + by
    if (to < 0 || to >= standard.length) return
    const next = [...standard]
    const [moved] = next.splice(index, 1)
    next.splice(to, 0, moved)
    startAction(async () => {
      await reorderPagesAction(next.map((p) => p.id))
      router.refresh()
    })
  }

  return (
    <div className="flex flex-col gap-5">
      <Card>
        <CardHeader
          title="Your pages"
          description="Every page on your shop. The front page is always there; the rest are yours."
          action={
            <Button variant="primary" onClick={() => setAddOpen(true)}>
              <Icons.Plus size={15} />
              Add a page
            </Button>
          }
        />
        <CardBody className="flex flex-col gap-2">
          {home && (
            <PageRow
              page={home}
              busy={busy}
              storePath={storePath}
              storeOpen={storeOpen}
              onEdit={() => setEditing(home)}
            />
          )}

          {standard.length === 0 ? (
            <EmptyState
              icon={<Icons.FileText size={22} />}
              title="No other pages yet"
              hint="An About, Delivery or Returns page tells shoppers what they need to know before they buy."
              action={
                <Button variant="secondary" onClick={() => setAddOpen(true)}>
                  <Icons.Plus size={15} />
                  Add a page
                </Button>
              }
            />
          ) : (
            standard.map((page, index) => (
              <PageRow
                key={page.id}
                page={page}
                busy={busy}
                storePath={storePath}
                storeOpen={storeOpen}
                index={index}
                count={standard.length}
                onMove={move}
                onToggle={toggle}
                onEdit={() => setEditing(page)}
                onRemove={() => setRemoving(page)}
              />
            ))
          )}
        </CardBody>
      </Card>

      {/*
        Its own card, because it is one arrangement covering every product
        rather than a page at an address — listing it beside About and Delivery
        would suggest it has a link of its own, which it has not.
      */}
      {productPageRow && (
        <Card>
          <CardHeader
            title="Under every product"
            description="Shown below the product itself, on all of them. Rows like “often bought with this” work out their own contents per product."
          />
          <CardBody>
            <PageRow
              page={productPageRow}
              busy={busy}
              storePath={storePath}
              storeOpen={storeOpen}
              onToggle={toggle}
              onEdit={() => setEditing(productPageRow)}
              onRemove={() => setRemoving(productPageRow)}
            />
          </CardBody>
        </Card>
      )}

      {departmentPages.length > 0 && (
        <Card>
          <CardHeader
            title="Department pages"
            description="Sections shown above the products in one department. Sub-departments can have their own, arranged differently from the department above them."
          />
          <CardBody className="flex flex-col gap-2">
            {departmentPages.map((page) => (
              <PageRow
                key={page.id}
                page={page}
                busy={busy}
                storePath={storePath}
                storeOpen={storeOpen}
                departmentPath={page.departmentId ? departmentPaths[page.departmentId] : undefined}
                onToggle={toggle}
                onEdit={() => setEditing(page)}
                onRemove={() => setRemoving(page)}
              />
            ))}
          </CardBody>
        </Card>
      )}

      {addOpen && (
        <AddPageDialog
          departments={departments}
          hasProductPage={productPageRow !== null}
          takenSlugs={pages.map((p) => p.slug).filter(Boolean)}
          onClose={() => setAddOpen(false)}
          onCreated={(id) => {
            setAddOpen(false)
            // Straight into the builder: the next thing anybody does after
            // making a page is put something on it, and a new page is empty.
            router.push(`/online-store/builder?page=${id}`)
          }}
        />
      )}

      {editing && (
        <EditPageDialog
          page={editing}
          takenSlugs={pages.filter((p) => p.id !== editing.id).map((p) => p.slug).filter(Boolean)}
          images={images}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            router.refresh()
          }}
        />
      )}

      <ConfirmModal
        open={removing !== null}
        onClose={() => setRemoving(null)}
        title={`Delete “${removing?.title ?? ''}”?`}
        // Said plainly: unlike removing a section in the builder, this one has
        // no undo behind it.
        message="The page and everything on it will be gone. This cannot be undone."
        confirmLabel="Delete page"
        tone="danger"
        onConfirm={() => {
          const page = removing
          if (!page) return
          setRemoving(null)
          startAction(async () => {
            const result = await deletePageAction(page.id)
            if (!result.ok) {
              toast.error(result.error)
              return
            }
            toast.success(`“${page.title}” deleted.`)
            router.refresh()
          })
        }}
      />
    </div>
  )
}

/* ── One page in the list ─────────────────────────────────────────────────── */

function PageRow({
  page,
  busy,
  storePath,
  storeOpen,
  departmentPath,
  index,
  count,
  onMove,
  onToggle,
  onEdit,
  onRemove,
}: {
  page: StorefrontPage
  busy: boolean
  storePath: string
  storeOpen: boolean
  /** The full path of the department this page is attached to, if any. */
  departmentPath?: string
  index?: number
  count?: number
  onMove?: (index: number, by: number) => void
  onToggle?: (page: StorefrontPage, field: 'isPublished' | 'showInNav', value: boolean) => void
  onEdit: () => void
  onRemove?: () => void
}) {
  const isHome = page.kind === 'home'
  /*
   * A department page IS reachable — /c/<id> — and hiding the link meant the
   * one page kind an owner most wants to check was the one they had to find by
   * browsing the shop. A product page still has no single URL to point at.
   */
  const href =
    page.kind === 'standard'
      ? `${storePath}/page/${page.slug}`
      : page.kind === 'department' && page.departmentId
        ? `${storePath}/c/${page.departmentId}`
        : storePath

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-control bg-surface-2 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-medium text-ink">{page.title || 'Untitled'}</p>
          {isHome && <Badge tone="brand">Front page</Badge>}
          {/* The reason to come to this screen is often "which one did I leave
              half-done" — so the answer is on the row, not behind a click. */}
          {page.hasDraft && <Badge tone="warning">Unpublished changes</Badge>}
        </div>
        <p className="mt-0.5 truncate text-sm text-muted">
          {page.kind === 'standard'
            ? `/page/${page.slug}`
            : isHome
              ? 'The page shoppers land on'
              : page.kind === 'product'
                ? 'Shown below every product'
                : /* The full path, so two pages both called "Red" are told
                     apart, and the extra clause when it lends itself down. */
                  `Above ${departmentPath || 'this department'}’s products${
                    page.appliesToChildren ? ', and its sub-departments’' : ''
                  }`}
        </p>
      </div>

      {/* The front page is always on, so a switch for it would be a control
          that cannot be used — and one that implies the shop can be left with
          no landing page at all. */}
      {!isHome && onToggle && (
        <label className="flex items-center gap-2 text-sm text-ink">
          <Switch
            checked={page.isPublished}
            disabled={busy}
            onChange={(on) => onToggle(page, 'isPublished', on)}
            ariaLabel={`Show “${page.title}” on the shop`}
          />
          On the shop
        </label>
      )}

      {page.kind === 'standard' && onToggle && (
        <label className="flex items-center gap-2 text-sm text-ink">
          <Switch
            checked={page.showInNav}
            disabled={busy || !page.isPublished}
            onChange={(on) => onToggle(page, 'showInNav', on)}
            ariaLabel={`Show “${page.title}” in the menu`}
          />
          In the menu
        </label>
      )}

      {onMove && index !== undefined && count !== undefined && (
        <div className="flex items-center">
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            aria-label={`Move “${page.title}” up`}
            title="Move up"
            disabled={busy || index === 0}
            onClick={() => onMove(index, -1)}
          >
            <Icons.ChevronUp size={14} />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            aria-label={`Move “${page.title}” down`}
            title="Move down"
            disabled={busy || index === count - 1}
            onClick={() => onMove(index, 1)}
          >
            <Icons.ChevronDown size={14} />
          </Button>
        </div>
      )}

      <div className="flex items-center gap-1">
        <Button variant="secondary" size="sm" onClick={onEdit} disabled={busy}>
          Settings
        </Button>
        {/* The builder is where the actual work happens, so it is the one
            control on the row with a label rather than an icon. */}
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            window.location.href = `/online-store/builder?page=${page.id}`
          }}
          disabled={busy}
        >
          <Icons.Palette size={14} />
          Edit page
        </Button>

        {/* Only when a shopper could actually open it — a link to a page the
            shop would 404 on is worse than no link. */}
        {storeOpen && (isHome || page.isPublished) && page.kind !== 'product' && (
          <a href={href} target="_blank" rel="noreferrer">
            <Button variant="ghost" size="sm" iconOnly aria-label={`View “${page.title}”`} title="View">
              <Icons.ExternalLink size={14} />
            </Button>
          </a>
        )}

        {onRemove && (
          <Button
            variant="danger-ghost"
            size="sm"
            iconOnly
            aria-label={`Delete “${page.title}”`}
            title="Delete"
            disabled={busy}
            onClick={onRemove}
          >
            <Icons.Trash size={14} />
          </Button>
        )}
      </div>
    </div>
  )
}

/* ── Adding ───────────────────────────────────────────────────────────────── */

function AddPageDialog({
  departments,
  hasProductPage,
  takenSlugs,
  onClose,
  onCreated,
}: {
  departments: { id: number; name: string; path: string; depth: number }[]
  hasProductPage: boolean
  takenSlugs: string[]
  onClose: () => void
  onCreated: (id: number) => void
}) {
  const toast = useToast()
  const [busy, startAction] = useTransition()
  const [kind, setKind] = useState<'standard' | 'department' | 'product'>('standard')
  const [title, setTitle] = useState('')
  /**
   * Whether the owner has typed their own address.
   *
   * Until they do, the slug follows the title — which is what almost everybody
   * wants and nobody should have to type twice. The moment they edit it, it
   * stops moving under them.
   */
  const [slugTouched, setSlugTouched] = useState(false)
  const [slug, setSlug] = useState('')
  const [departmentId, setDepartmentId] = useState('')

  const effectiveSlug = slugTouched ? safeSlug(slug) : safeSlug(title)
  const problem = kind === 'standard' && title ? slugProblem(effectiveSlug, takenSlugs) : ''

  function submit() {
    startAction(async () => {
      const result = await createPageAction({
        kind,
        title,
        slug: effectiveSlug,
        departmentId: kind === 'department' ? Number(departmentId) || null : null,
      })
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success('Page added. Put something on it.')
      onCreated(result.id)
    })
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Add a page"
      description="A page of your own — About, Delivery, Returns, anything."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={submit}
            disabled={
              busy ||
              !title.trim() ||
              Boolean(problem) ||
              (kind === 'department' && !departmentId)
            }
          >
            {busy ? 'Adding…' : 'Add page'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field
          label="What kind"
          hint={
            kind === 'standard'
              ? 'A page of its own, with its own web address.'
              : 'Sections shown above one department’s products.'
          }
        >
          <Select
            value={kind}
            onChange={(e) => setKind(e.target.value as 'standard' | 'department' | 'product')}
          >
            <option value="standard">A page of its own</option>
            <option value="department" disabled={departments.length === 0}>
              {departments.length === 0
                ? 'A department page (every department has one)'
                : 'A department page'}
            </option>
            {/* One arrangement for every product — see 079. Disabled once made,
                because a second would have nowhere to appear. */}
            <option value="product" disabled={hasProductPage}>
              {hasProductPage
                ? 'Your product pages (already arranged)'
                : 'Everything under a product'}
            </option>
          </Select>
        </Field>

        {kind === 'department' && (
          <Field
            label="Which department"
            hint="Sub-departments get their own page too — arrange each one differently if you want."
          >
            <Select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
              <option value="">Choose a department</option>
              {departments.map((d) => (
                /*
                 * Indented by depth and labelled with the full path, because
                 * "Red" alone is ambiguous the moment a shop sells both wine
                 * and paint. Non-breaking spaces: a <option> collapses ordinary
                 * runs of whitespace, so leading spaces would simply vanish.
                 */
                <option key={d.id} value={d.id}>
                  {'  '.repeat(d.depth)}
                  {d.path}
                </option>
              ))}
            </Select>
          </Field>
        )}

        <Field label="Name" hint="What it is called, in the menu and at the top of the page.">
          <Input
            value={title}
            maxLength={120}
            autoFocus
            placeholder="e.g. Delivery & Returns"
            onChange={(e) => setTitle(e.target.value)}
          />
        </Field>

        {kind === 'standard' && (
          <Field
            label="Web address"
            hint={effectiveSlug ? `Shoppers will find it at /page/${effectiveSlug}` : undefined}
            error={problem || undefined}
          >
            <Input
              value={slugTouched ? slug : effectiveSlug}
              maxLength={60}
              placeholder="delivery-returns"
              onChange={(e) => {
                setSlugTouched(true)
                setSlug(e.target.value)
              }}
            />
          </Field>
        )}

        {/*
          Said before they commit, not after: a new page is deliberately off,
          and an owner who adds one and cannot find it on their shop has been
          surprised by something we chose.
        */}
        <p className="text-sm text-muted">
          New pages start switched off, so you can build them before anybody sees them.
        </p>
      </div>
    </Modal>
  )
}

/* ── Settings ─────────────────────────────────────────────────────────────── */

function EditPageDialog({
  page,
  takenSlugs,
  images,
  onClose,
  onSaved,
}: {
  page: StorefrontPage
  takenSlugs: string[]
  images: StorefrontImage[]
  onClose: () => void
  onSaved: () => void
}) {
  const toast = useToast()
  const [busy, startAction] = useTransition()
  const [title, setTitle] = useState(page.title)
  const [slug, setSlug] = useState(page.slug)
  const [seoTitle, setSeoTitle] = useState(page.seoTitle)
  const [seoDescription, setSeoDescription] = useState(page.seoDescription)
  const [seoImageId, setSeoImageId] = useState<number | null>(page.seoImageId)
  const [appliesToChildren, setAppliesToChildren] = useState(page.appliesToChildren)

  const effectiveSlug = safeSlug(slug)
  const problem = page.kind === 'standard' ? slugProblem(effectiveSlug, takenSlugs) : ''

  function submit() {
    startAction(async () => {
      const result = await savePageSettingsAction(page.id, {
        title,
        // Only a standard page has one to change — see savePageSettings on why
        // the front page's address is not editable.
        ...(page.kind === 'standard' ? { slug: effectiveSlug } : {}),
        ...(page.kind === 'department' ? { appliesToChildren } : {}),
        seoTitle,
        seoDescription,
        seoImageId,
      })
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success('Saved.')
      onSaved()
    })
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`“${page.title}” settings`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={submit}
            disabled={busy || !title.trim() || Boolean(problem)}
          >
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Name">
          <Input value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} />
        </Field>

        {/*
          Off by default, and per page. A shop that wants each sub-department
          arranged its own way simply builds them; a shop with forty of them and
          one banner to say turns this on once. Either way a sub-department with
          a page of its own always wins over an inherited one, which is the part
          worth stating here rather than leaving to be discovered.
        */}
        {page.kind === 'department' && (
          <Field
            label="Sub-departments"
            hint="A sub-department with its own page always uses that instead."
          >
            <label className="flex items-center gap-2 text-sm text-ink">
              <Switch
                checked={appliesToChildren}
                onChange={setAppliesToChildren}
                ariaLabel="Also show this page on sub-departments"
              />
              Also show these sections on sub-departments
            </label>
          </Field>
        )}

        {page.kind === 'standard' && (
          <Field
            label="Web address"
            hint={
              effectiveSlug !== page.slug && page.slug
                ? `Changing this breaks any link already shared to /page/${page.slug}.`
                : effectiveSlug
                  ? `/page/${effectiveSlug}`
                  : undefined
            }
            error={problem || undefined}
          >
            <Input value={slug} maxLength={60} onChange={(e) => setSlug(e.target.value)} />
          </Field>
        )}

        {/*
          What a shared link looks like.

          Empty falls back to the shop's own name and blurb, which is what
          happens today for every page — so these are genuinely optional and
          the hints say so rather than implying a blank field is a problem.
        */}
        <Field
          label="Title when shared"
          hint="Shown on WhatsApp and Facebook. Blank uses your shop’s name."
        >
          <Input
            value={seoTitle}
            maxLength={120}
            placeholder={page.title}
            onChange={(e) => setSeoTitle(e.target.value)}
          />
        </Field>

        <Field
          label="Description when shared"
          hint="A line about this page. Blank uses your shop’s description."
        >
          <Input
            value={seoDescription}
            maxLength={300}
            onChange={(e) => setSeoDescription(e.target.value)}
          />
        </Field>

        <Field
          label="Picture when shared"
          hint="Blank uses your shop’s own, set under Appearance in the builder."
        >
          <PicturePicker
            value={seoImageId}
            current={images.find((i) => i.id === seoImageId) ?? null}
            onChange={(image) => setSeoImageId(image?.id ?? null)}
          />
        </Field>
      </div>
    </Modal>
  )
}
