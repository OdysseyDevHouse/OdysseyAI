import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteExecute, siteQuery, siteQueryOne } from '../siteDb'
import {
  defaultSections,
  isScheduledNow,
  PAGE_KINDS,
  normaliseSections,
  safeDateTime,
  safeSlug,
  shopToday,
  wallClockNow,
  slugProblem,
  type HomeSection,
  type PageKind,
} from '../storefrontModel'

/**
 * The storefront's pages: reading, writing, publishing.
 *
 * The MODEL — section kinds, caps, normalisation, slug rules — lives in
 * lib/storefrontModel.ts, which carries no `server-only` marker so the builder
 * in the browser applies the identical rules. This file is the database half.
 *
 * ── THIS REPLACES THE TWO COLUMNS ON THE SETTINGS ROW ────────────────────
 *
 * storefrontLayout.ts read `home_layout` / `home_layout_draft` from
 * online_store_settings. Those columns still exist and are no longer read —
 * see 070 on why they were not dropped. Everything now goes through a row in
 * `storefront_pages`, and draft-and-publish is per PAGE: an owner rewriting
 * the About page must not be blocked from publishing a corrected price on the
 * front page.
 *
 * ── THE HOME PAGE IS SPECIAL, AND ONLY IN TWO WAYS ───────────────────────
 *
 * It cannot be deleted, and a NULL layout means the starter page rather than
 * nothing. Everything else about it is an ordinary row — which is what lets
 * the builder edit every page through one screen.
 */

type Row = RowDataPacket & Record<string, unknown>

export type StorefrontPage = {
  id: number
  kind: PageKind
  slug: string
  title: string
  departmentId: number | null
  isPublished: boolean
  showInNav: boolean
  navOrder: number
  seoTitle: string
  seoDescription: string
  seoImageId: number | null
  /**
   * When this page will publish itself, as local wall-clock text. Empty means
   * no publish is scheduled — see 075.
   */
  publishAt: string
  /** Whether this page has unpublished edits. The layouts are not carried. */
  hasDraft: boolean
}

export type SaveResult = { ok: true } | { ok: false; error: string }
export type CreateResult = { ok: true; id: number } | { ok: false; error: string }

/**
 * How many pages one shop may have.
 *
 * A cap rather than none, for the same reason MAX_SECTIONS exists: every page
 * is a row the nav reads and a route the shop resolves, and a shop with two
 * hundred of them has a navigation problem no builder can fix. Generous enough
 * that no real shop meets it.
 */
export const MAX_PAGES = 30

function mapPage(r: Row): StorefrontPage {
  const kind = String(r.kind)
  return {
    id: Number(r.id),
    // Coerced rather than trusted: one row written by a future version must
    // not take down the shop that reads it.
    //
    // Against PAGE_KINDS rather than a list repeated here — the repeated one
    // silently stopped recognising 'product' the moment the kind was added,
    // and a page whose kind is not understood becomes a 'standard' one at a
    // slug it does not have.
    kind: (PAGE_KINDS as readonly string[]).includes(kind) ? (kind as PageKind) : 'standard',
    slug: String(r.slug ?? ''),
    title: String(r.title ?? ''),
    departmentId: r.department_id === null ? null : Number(r.department_id),
    isPublished: !!r.is_published,
    showInNav: !!r.show_in_nav,
    navOrder: Number(r.nav_order ?? 0),
    seoTitle: String(r.seo_title ?? ''),
    seoDescription: String(r.seo_description ?? ''),
    seoImageId: r.seo_image_id === null ? null : Number(r.seo_image_id),
    publishAt: String(r.publish_at ?? ''),
    // Computed in SQL rather than by carrying the TEXT back: this is asked for
    // every page in the switcher, and a list of twenty pages would otherwise
    // drag twenty layouts across the wire to answer a yes/no question.
    hasDraft: !!r.has_draft,
  }
}

/**
 * The columns every reader wants, minus the layouts themselves.
 *
 * Listed rather than `SELECT *` precisely because of the two TEXT columns: a
 * page list is read on every request that draws the nav, and pulling two
 * layouts per row to display a title is the kind of thing that is invisible
 * until a shop has twenty pages.
 */
const PAGE_COLUMNS = `
  id, kind, slug, title, department_id, is_published, show_in_nav, nav_order,
  seo_title, seo_description, seo_image_id, publish_at,
  (layout_draft IS NOT NULL) AS has_draft
`

/* ── Reading ──────────────────────────────────────────────────────────────── */

/** Every page, front page first, then nav order. The Pages screen's list. */
export async function listPages(siteId: number): Promise<StorefrontPage[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT ${PAGE_COLUMNS} FROM storefront_pages
      ORDER BY kind = 'home' DESC, nav_order, title, id`,
  )
  return rows.map(mapPage)
}

/**
 * The pages the shop's own navigation shows.
 *
 * Published AND ticked for the nav — two different questions, and a page can
 * legitimately be one without the other. A policy linked only from the footer
 * is the normal case, not an edge one.
 *
 * The home page is excluded: the masthead already links to it, and a nav whose
 * first entry duplicates the logo beside it reads as a mistake.
 */
export async function navPages(siteId: number): Promise<StorefrontPage[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT ${PAGE_COLUMNS} FROM storefront_pages
      WHERE is_published = 1 AND show_in_nav = 1 AND kind = 'standard'
      ORDER BY nav_order, title, id`,
  )
  return rows.map(mapPage)
}

export async function getPage(siteId: number, pageId: number): Promise<StorefrontPage | null> {
  if (!Number.isInteger(pageId) || pageId <= 0) return null
  const row = await siteQueryOne<Row>(
    siteId,
    `SELECT ${PAGE_COLUMNS} FROM storefront_pages WHERE id = ?`,
    [pageId],
  )
  return row ? mapPage(row) : null
}

/** The one and only front page. Guaranteed by uq_page_home in 070. */
export async function homePage(siteId: number): Promise<StorefrontPage | null> {
  const row = await siteQueryOne<Row>(
    siteId,
    `SELECT ${PAGE_COLUMNS} FROM storefront_pages WHERE kind = 'home'`,
  )
  return row ? mapPage(row) : null
}

/**
 * A standard page by its slug — what the public route resolves.
 *
 * Unpublished reads as ABSENT, deliberately: the route 404s identically to a
 * slug that never existed, so a draft page cannot be probed for from outside.
 * Same reasoning as a department nobody publishes.
 */
export async function publishedPageBySlug(
  siteId: number,
  slug: string,
): Promise<StorefrontPage | null> {
  const clean = safeSlug(slug)
  if (!clean) return null
  const row = await siteQueryOne<Row>(
    siteId,
    `SELECT ${PAGE_COLUMNS} FROM storefront_pages
      WHERE slug = ? AND kind = 'standard' AND is_published = 1`,
    [clean],
  )
  return row ? mapPage(row) : null
}

/**
 * The one layout every product page shares, if the shop has made one.
 *
 * No id and no slug — see 079 on why forty thousand products get one
 * arrangement rather than forty thousand rows. Null means product pages render
 * exactly as they always have, which is what every shop gets until it opts in.
 */
export async function productPage(siteId: number): Promise<StorefrontPage | null> {
  const row = await siteQueryOne<Row>(
    siteId,
    `SELECT ${PAGE_COLUMNS} FROM storefront_pages WHERE kind = 'product'`,
  )
  return row ? mapPage(row) : null
}

/** The optional layout attached to one department, if it has one. */
export async function departmentPage(
  siteId: number,
  departmentId: number,
): Promise<StorefrontPage | null> {
  if (!Number.isInteger(departmentId) || departmentId <= 0) return null
  const row = await siteQueryOne<Row>(
    siteId,
    `SELECT ${PAGE_COLUMNS} FROM storefront_pages
      WHERE kind = 'department' AND department_id = ?`,
    [departmentId],
  )
  return row ? mapPage(row) : null
}

/* ── Layouts ──────────────────────────────────────────────────────────────── */

function parseLayout(value: unknown): HomeSection[] | null {
  if (value === null || value === undefined || value === '') return null
  try {
    return normaliseSections(JSON.parse(String(value)))
  } catch {
    // Unparseable JSON means a corrupted row. Treated as "never published"
    // rather than throwing, so a bad value cannot take the shop down.
    return null
  }
}

export type PageLayout = {
  /** What shoppers see. The starter page for home; empty for the rest. */
  published: HomeSection[]
  /** What the owner is editing, or null when there is nothing unpublished. */
  draft: HomeSection[] | null
}

/**
 * One page's layouts.
 *
 * ── WHY THE FALLBACK DIFFERS BY KIND ─────────────────────────────────────
 *
 * A home page that has never been published falls back to the starter page,
 * exactly as it did before this table existed — that is what a new shop sees,
 * and changing it would change every existing shop's front page.
 *
 * A standard or department page falls back to NOTHING. There is no sensible
 * starter for an About page, and inventing three sections an owner did not ask
 * for means their first act is deleting them.
 */
export async function getPageLayout(siteId: number, pageId: number): Promise<PageLayout> {
  const row = await siteQueryOne<Row>(
    siteId,
    `SELECT kind, layout, layout_draft FROM storefront_pages WHERE id = ?`,
    [pageId],
  )
  if (!row) return { published: [], draft: null }

  const published = parseLayout(row.layout)
  return {
    published: published ?? (String(row.kind) === 'home' ? defaultSections() : []),
    draft: parseLayout(row.layout_draft),
  }
}

/**
 * What the SHOP renders for a page: published sections only, never a draft,
 * and only those in season.
 *
 * The same two gates `getPublishedLayout` has always applied, and the same
 * reasoning: `enabled` is the owner saying "not this", the schedule is them
 * saying "not yet" or "not any more", and both are evaluated on every READ
 * rather than by a nightly job — a date passing is not an event anybody
 * triggers, so a stored answer would be wrong between the moment the date
 * turned and the moment the job ran.
 */
export async function getPublishedPageLayout(
  siteId: number,
  pageId: number,
): Promise<HomeSection[]> {
  const { published } = await getPageLayout(siteId, pageId)
  const today = shopToday()
  return published.filter((s) => s.enabled && isScheduledNow(s, today))
}

/**
 * What a public route should render for a page: the draft when a valid preview
 * pass names THIS page, otherwise what is published.
 *
 * ── ONE RULE, THREE ROUTES ───────────────────────────────────────────────
 *
 * The front page, a standard page and a department page all need to answer the
 * same question, and the answer has three ways to be got wrong: honouring a
 * pass for a different page, honouring one for a different SITE, or forgetting
 * the schedule filter that the published path applies.
 *
 * The site check is the load-bearing one. The pass carries a siteId and so does
 * the request; if they disagree the pass is ignored rather than trusted, so a
 * preview link for one shop can never render another shop's draft.
 *
 * A draft is shown UNFILTERED by the schedule, deliberately: previewing a
 * Christmas banner in June is the whole reason to preview, and hiding it would
 * make the feature useless for exactly the sections that need checking most.
 */
export async function getPageSectionsFor(
  siteId: number,
  pageId: number,
  preview: { siteId: number; pageId: number } | null,
): Promise<{ sections: HomeSection[]; isPreview: boolean }> {
  const valid = preview !== null && preview.siteId === siteId && preview.pageId === pageId
  if (!valid) return { sections: await getPublishedPageLayout(siteId, pageId), isPreview: false }

  const layout = await getPageLayout(siteId, pageId)
  // The draft when there IS one, else what is live — matching the builder,
  // which edits the draft only once something has been changed.
  return { sections: layout.draft ?? layout.published, isPreview: true }
}

export async function savePageDraft(
  siteId: number,
  pageId: number,
  sections: unknown,
): Promise<SaveResult> {
  const clean = normaliseSections(sections)
  await siteExecute(siteId, `UPDATE storefront_pages SET layout_draft = ? WHERE id = ?`, [
    JSON.stringify(clean),
    pageId,
  ])
  return { ok: true }
}

/**
 * Make one page's draft live, and clear it.
 *
 * ── WHAT WAS LIVE IS KEPT FIRST ──────────────────────────────────────────
 *
 * Recorded BEFORE the overwrite, so the history is a list of states shoppers
 * actually saw. Doing it after would record the new version as though it were
 * the old one, which is the sort of off-by-one nobody notices until they try
 * to restore something.
 *
 * The version write must never block the publish: an owner correcting a wrong
 * price cares far more that the correction goes live than that the previous
 * version was archived. Same argument the GL mirror makes about never failing
 * its caller.
 */
export async function publishPageDraft(
  siteId: number,
  pageId: number,
  publishedBy = '',
): Promise<SaveResult> {
  const row = await siteQueryOne<Row>(
    siteId,
    `SELECT layout, layout_draft FROM storefront_pages WHERE id = ?`,
    [pageId],
  )
  if (!row) return { ok: false, error: 'That page no longer exists.' }
  if (row.layout_draft === null) return { ok: false, error: 'There are no changes to publish.' }

  // Only when there WAS something live. The first publish of a new page has no
  // previous state, and a row of NULL would be a "version" that restores to a
  // blank page nobody ever saw.
  if (row.layout !== null) {
    await recordVersion(siteId, pageId, String(row.layout), publishedBy)
  }

  await siteExecute(
    siteId,
    `UPDATE storefront_pages SET layout = layout_draft, layout_draft = NULL WHERE id = ?`,
    [pageId],
  )
  return { ok: true }
}

/* ── Publishing later ─────────────────────────────────────────────────────── */

/**
 * Arrange for a page to go live at a given moment, or cancel that.
 *
 * An empty string clears it. Anything that is not a real 'YYYY-MM-DDTHH:mm'
 * also clears it rather than being stored — a half-parsed moment would be a
 * page that publishes itself at a time nobody chose, which is worse than one
 * that does not publish at all.
 */
export async function schedulePublish(
  siteId: number,
  pageId: number,
  at: unknown,
): Promise<SaveResult> {
  const when = safeDateTime(at)
  if (when && when <= wallClockNow()) {
    return { ok: false, error: 'Choose a time in the future.' }
  }
  await siteExecute(siteId, `UPDATE storefront_pages SET publish_at = ? WHERE id = ?`, [
    when,
    pageId,
  ])
  return { ok: true }
}

/**
 * Publish every page whose moment has come.
 *
 * ── LATE IS FINE; EARLY IS NOT ───────────────────────────────────────────
 *
 * The comparison is `publish_at <= now`, so a tick that is delayed — a missed
 * cron run, a restart — still publishes everything that fell due while it was
 * away, in one go. A tick that runs early publishes nothing. That asymmetry is
 * deliberate: a Black Friday page going live four minutes late is a
 * non-event, and going live four minutes early is the shop's whole pricing
 * strategy leaking.
 *
 * ── THE TIME IS CLEARED WHETHER OR NOT THE PUBLISH WORKED ────────────────
 *
 * A page with an empty draft cannot be published — `publishPageDraft` refuses
 * it — and leaving the time set would make this retry that same page on every
 * tick, forever. Clearing it means a scheduled publish fires exactly once,
 * which is what "publish at 6am" means.
 */
export async function publishDuePages(
  siteId: number,
): Promise<{ published: number; skipped: number }> {
  const now = wallClockNow()
  const due = await siteQuery<Row>(
    siteId,
    `SELECT id FROM storefront_pages WHERE publish_at <> '' AND publish_at <= ?`,
    [now],
  )

  let published = 0
  let skipped = 0
  for (const row of due) {
    const id = Number(row.id)
    // Cleared FIRST, so a failure below cannot leave the page due forever.
    await siteExecute(siteId, `UPDATE storefront_pages SET publish_at = '' WHERE id = ?`, [id])
    const result = await publishPageDraft(siteId, id, 'Scheduled')
    if (result.ok) published++
    else skipped++
  }
  return { published, skipped }
}

/* ── What a page used to be ───────────────────────────────────────────────── */

/**
 * How many past versions of a page are kept.
 *
 * Ten covers "put back what was there this morning" and "put back last week's
 * page", which is the whole of what anybody asks for. Beyond that an owner is
 * not restoring, they are archaeology — and every extra row is a full copy of
 * a document. See 074 on why the cap is applied on write.
 */
export const MAX_VERSIONS = 10

export type PageVersion = {
  id: number
  replacedAt: Date
  replacedBy: string
  /** How many sections it held — enough to tell two versions apart in a list. */
  sectionCount: number
}

/**
 * Keep what was live, and trim the oldest away.
 *
 * ── IT SWALLOWS ITS OWN FAILURES ─────────────────────────────────────────
 *
 * Wrapped, because this is called on the publish path and publishing must
 * succeed even if the history table is missing, full or locked. A shop that
 * cannot archive the old version still needs the new one to go live; the cost
 * of failing quietly here is one absent history row, and the cost of throwing
 * is a correction that never reached customers.
 */
async function recordVersion(
  siteId: number,
  pageId: number,
  layout: string,
  replacedBy: string,
): Promise<void> {
  try {
    await siteExecute(
      siteId,
      `INSERT INTO storefront_page_versions (page_id, layout, replaced_by) VALUES (?, ?, ?)`,
      [pageId, layout, replacedBy.slice(0, 120)],
    )
    /*
     * Trim by ID, not by date. Two publishes in the same second share a
     * `replaced_at` to the second, and an OFFSET over a non-unique ordering can
     * skip a row and keep one it meant to delete. The id is monotonic.
     */
    const keep = await siteQuery<Row>(
      siteId,
      `SELECT id FROM storefront_page_versions WHERE page_id = ?
        ORDER BY id DESC LIMIT ${MAX_VERSIONS}`,
      [pageId],
    )
    const ids = keep.map((r) => Number(r.id))
    if (ids.length === MAX_VERSIONS) {
      await siteExecute(
        siteId,
        `DELETE FROM storefront_page_versions WHERE page_id = ? AND id < ?`,
        [pageId, Math.min(...ids)],
      )
    }
  } catch {
    // Deliberate. See the header.
  }
}

/** This page's past versions, newest first. */
export async function listVersions(siteId: number, pageId: number): Promise<PageVersion[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT id, replaced_at, replaced_by, layout FROM storefront_page_versions
      WHERE page_id = ? ORDER BY id DESC`,
    [pageId],
  )
  return rows.map((r) => ({
    id: Number(r.id),
    replacedAt: r.replaced_at instanceof Date ? r.replaced_at : new Date(0),
    replacedBy: String(r.replaced_by ?? ''),
    sectionCount: (parseLayout(r.layout) ?? []).length,
  }))
}

/**
 * Put an old version back — as a DRAFT, not live.
 *
 * ── RESTORING IS NOT PUBLISHING ──────────────────────────────────────────
 *
 * It loads the old page into the builder so the owner can look at it, adjust
 * it and publish it deliberately. Restoring straight to live would make this
 * the one control on the screen that changes the public shop without the
 * confirmation and the change summary every other path goes through — and it
 * would do so from a list of timestamps, which is the least informative place
 * to be making that decision.
 */
export async function restoreVersion(
  siteId: number,
  pageId: number,
  versionId: number,
): Promise<SaveResult> {
  const row = await siteQueryOne<Row>(
    siteId,
    // page_id in the WHERE, not just the id: a version belongs to one page, and
    // restoring another page's layout onto this one would be a silent mix-up.
    `SELECT layout FROM storefront_page_versions WHERE id = ? AND page_id = ?`,
    [versionId, pageId],
  )
  if (!row) return { ok: false, error: 'That version is no longer there.' }

  await siteExecute(siteId, `UPDATE storefront_pages SET layout_draft = ? WHERE id = ?`, [
    String(row.layout ?? '[]'),
    pageId,
  ])
  return { ok: true }
}

/* ── Sections worth reusing ───────────────────────────────────────────────── */

export type SavedSection = {
  id: number
  name: string
  kind: string
  section: HomeSection
}

/** How many saved sections a shop may keep. A list, not a library. */
export const MAX_SAVED_SECTIONS = 40

export async function listSavedSections(siteId: number): Promise<SavedSection[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT * FROM storefront_saved_sections ORDER BY name`,
  )
  return rows.flatMap((r) => {
    // Through normalisation on the way OUT as well as in: a row written by an
    // older build may hold a field this one no longer understands, and a saved
    // section that cannot be coerced is dropped rather than crashing the list.
    const parsed = parseLayout(`[${String(r.section)}]`)
    const section = parsed?.[0]
    if (!section) return []
    return [{ id: Number(r.id), name: String(r.name), kind: String(r.kind ?? ''), section }]
  })
}

export async function saveSection(
  siteId: number,
  name: string,
  section: unknown,
): Promise<SaveResult> {
  const clean = String(name).trim().slice(0, 80)
  if (!clean) return { ok: false, error: 'Give it a name.' }

  // Normalised as a one-item layout, so a saved section is subject to exactly
  // the caps and coercion a page's section is. Nothing gets to be stored in a
  // shape the builder could not have produced.
  const [normalised] = normaliseSections([section])
  if (!normalised) return { ok: false, error: 'That is not a section we can save.' }

  const count = await siteQueryOne<Row>(
    siteId,
    `SELECT COUNT(*) AS n FROM storefront_saved_sections`,
  )
  if (Number(count?.n ?? 0) >= MAX_SAVED_SECTIONS) {
    return { ok: false, error: `You can keep ${MAX_SAVED_SECTIONS} saved sections.` }
  }

  const existing = await siteQueryOne<Row>(
    siteId,
    `SELECT id FROM storefront_saved_sections WHERE name = ?`,
    [clean],
  )
  if (existing) return { ok: false, error: 'You already have one with that name.' }

  await siteExecute(
    siteId,
    `INSERT INTO storefront_saved_sections (name, kind, section) VALUES (?, ?, ?)`,
    [clean, normalised.kind, JSON.stringify(normalised)],
  )
  return { ok: true }
}

export async function deleteSavedSection(siteId: number, id: number): Promise<SaveResult> {
  await siteExecute(siteId, `DELETE FROM storefront_saved_sections WHERE id = ?`, [id])
  return { ok: true }
}

/** Throw one page's draft away and go back to what is live. */
export async function discardPageDraft(siteId: number, pageId: number): Promise<SaveResult> {
  await siteExecute(siteId, `UPDATE storefront_pages SET layout_draft = NULL WHERE id = ?`, [
    pageId,
  ])
  return { ok: true }
}

/* ── Creating, changing and removing pages ────────────────────────────────── */

export type NewPageInput = {
  kind: Exclude<PageKind, 'home'>
  title: string
  slug?: string
  departmentId?: number | null
}

/**
 * Add a page.
 *
 * Home is not creatable — there is exactly one and 070 enforces it — so the
 * input type excludes it rather than validating it away at runtime.
 *
 * A new page starts UNPUBLISHED. Creating a page and having it instantly
 * appear, empty, on the live shop is the opposite of what the draft mechanism
 * exists for.
 */
export async function createPage(siteId: number, input: NewPageInput): Promise<CreateResult> {
  const title = String(input.title ?? '').trim().slice(0, 120)
  if (!title) return { ok: false, error: 'Give the page a name.' }

  const count = await siteQueryOne<Row>(
    siteId,
    `SELECT COUNT(*) AS n FROM storefront_pages`,
  )
  if (Number(count?.n ?? 0) >= MAX_PAGES) {
    return { ok: false, error: `A shop can have ${MAX_PAGES} pages.` }
  }

  /*
   * The product page. One per shop, no slug, no department.
   *
   * uq_page_department is on (kind, department_id), so with department_id NULL
   * the database already permits exactly one of these — the same mechanism
   * that guarantees one home page. Checked here anyway so the error is a
   * sentence rather than a duplicate-key message naming an index.
   */
  if (input.kind === 'product') {
    if (await productPage(siteId)) {
      return { ok: false, error: 'Your product pages already have a layout.' }
    }
    const result = await siteExecute(
      siteId,
      `INSERT INTO storefront_pages (kind, slug, title, is_published) VALUES ('product', '', ?, 0)`,
      [title],
    )
    return { ok: true, id: Number(result.insertId) }
  }

  if (input.kind === 'department') {
    const departmentId = Number(input.departmentId)
    if (!Number.isInteger(departmentId) || departmentId <= 0) {
      return { ok: false, error: 'Choose a department.' }
    }
    // uq_page_department would catch this, but the error it throws says
    // "duplicate entry" and names an index — which is not something to put in
    // front of a shop owner.
    const existing = await departmentPage(siteId, departmentId)
    if (existing) return { ok: false, error: 'That department already has a page.' }

    const result = await siteExecute(
      siteId,
      `INSERT INTO storefront_pages (kind, slug, title, department_id, is_published)
       VALUES ('department', '', ?, ?, 0)`,
      [title, departmentId],
    )
    return { ok: true, id: Number(result.insertId) }
  }

  // A slug the owner typed, or one made from the title — which is what almost
  // everybody wants and nobody should have to type twice.
  const slug = safeSlug(input.slug || title)
  const taken = (await listPages(siteId)).map((p) => p.slug).filter(Boolean)
  const problem = slugProblem(slug, taken)
  if (problem) return { ok: false, error: problem }

  const result = await siteExecute(
    siteId,
    `INSERT INTO storefront_pages (kind, slug, title, is_published, show_in_nav, nav_order)
     VALUES ('standard', ?, ?, 0, 0, ?)`,
    [slug, title, Number(count?.n ?? 0)],
  )
  return { ok: true, id: Number(result.insertId) }
}

export type PageSettingsInput = {
  title?: string
  slug?: string
  isPublished?: boolean
  showInNav?: boolean
  seoTitle?: string
  seoDescription?: string
  seoImageId?: number | null
}

/**
 * Change a page's settings — everything except its sections.
 *
 * ── THE HOME PAGE'S SLUG IS NOT EDITABLE ─────────────────────────────────
 *
 * It is not a URL anybody types; the front page is the shop's root. Letting it
 * be changed would produce a reserved slug nothing routes to, and a front page
 * that 404s is not a state worth making reachable.
 */
export async function savePageSettings(
  siteId: number,
  pageId: number,
  input: PageSettingsInput,
): Promise<SaveResult> {
  const page = await getPage(siteId, pageId)
  if (!page) return { ok: false, error: 'That page no longer exists.' }

  const title = input.title === undefined ? page.title : String(input.title).trim().slice(0, 120)
  if (!title) return { ok: false, error: 'Give the page a name.' }

  let slug = page.slug
  if (input.slug !== undefined && page.kind === 'standard') {
    slug = safeSlug(input.slug)
    const taken = (await listPages(siteId))
      .filter((p) => p.id !== pageId)
      .map((p) => p.slug)
      .filter(Boolean)
    const problem = slugProblem(slug, taken)
    if (problem) return { ok: false, error: problem }
  }

  await siteExecute(
    siteId,
    `UPDATE storefront_pages
        SET title = ?, slug = ?, is_published = ?, show_in_nav = ?,
            seo_title = ?, seo_description = ?, seo_image_id = ?
      WHERE id = ?`,
    [
      title,
      slug,
      input.isPublished === undefined ? (page.isPublished ? 1 : 0) : input.isPublished ? 1 : 0,
      input.showInNav === undefined ? (page.showInNav ? 1 : 0) : input.showInNav ? 1 : 0,
      (input.seoTitle ?? page.seoTitle).slice(0, 120),
      (input.seoDescription ?? page.seoDescription).slice(0, 300),
      // An id or nothing. Anything unusable becomes NULL rather than 0, which
      // would be a reference to a picture that cannot exist — the same rule
      // `saveTheme` applies to the logo.
      normaliseImageId(input.seoImageId === undefined ? page.seoImageId : input.seoImageId),
      pageId,
    ],
  )
  return { ok: true }
}

function normaliseImageId(value: unknown): number | null {
  const id = Number(value)
  return Number.isInteger(id) && id > 0 ? id : null
}

/**
 * Put the nav in a given order.
 *
 * Takes the ids in their new order rather than an id and a position, for the
 * same reason `reorderSpecials` does: a drag produces a whole new order, and
 * applying it one move at a time leaves the list briefly wrong in a way a
 * concurrent reader can see.
 */
export async function reorderPages(siteId: number, ids: number[]): Promise<SaveResult> {
  const clean = ids.filter((id) => Number.isInteger(id) && id > 0)
  for (let i = 0; i < clean.length; i++) {
    await siteExecute(siteId, `UPDATE storefront_pages SET nav_order = ? WHERE id = ?`, [
      i,
      clean[i],
    ])
  }
  return { ok: true }
}

/**
 * Remove a page.
 *
 * The front page is refused rather than silently ignored: a shop cannot not
 * have one, and a delete button that does nothing is worse than one that
 * explains itself.
 */
export async function deletePage(siteId: number, pageId: number): Promise<SaveResult> {
  const page = await getPage(siteId, pageId)
  if (!page) return { ok: true }
  if (page.kind === 'home') {
    return { ok: false, error: 'Your front page cannot be deleted.' }
  }
  await siteExecute(siteId, `DELETE FROM storefront_pages WHERE id = ?`, [pageId])
  return { ok: true }
}
