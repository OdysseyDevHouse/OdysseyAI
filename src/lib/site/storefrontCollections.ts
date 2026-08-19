import 'server-only'
import { siteExecute, siteQuery, siteQueryOne, siteTransaction } from '../siteDb'
import {
  MAX_COLLECTIONS,
  MAX_COLLECTION_PICKS,
  safeCollectionRule,
  safeCollectionSlug,
  type Collection,
} from '../storefront/collections'
import {
  popularProducts,
  productsOnSpecial,
  publishedProducts,
  type CatalogueOptions,
  type StorefrontContext,
  type StorefrontProduct,
} from './storefront'

/**
 * Reading and writing collections, and turning a rule into products.
 *
 * ── ONE RESOLVER, SO A PREVIEW CANNOT LIE ────────────────────────────────
 *
 * The admin screen shows a merchant what a collection holds and the shop
 * renders it. Both call `collectionProducts`, because a second implementation
 * of "what does this rule mean" would disagree eventually — and the
 * disagreement would be a merchant arranging a collection they never saw.
 */

type Row = Record<string, unknown>

const COLUMNS = `
  id, slug, title, description, image_id, is_published, sort_order,
  rule_kind, rule_value, seo_title, seo_description`

function mapCollection(row: Row): Collection {
  const image = Number(row.image_id)
  return {
    id: Number(row.id),
    slug: String(row.slug ?? ''),
    title: String(row.title ?? ''),
    description: String(row.description ?? ''),
    imageId: Number.isInteger(image) && image > 0 ? image : null,
    isPublished: !!row.is_published,
    sortOrder: Number(row.sort_order ?? 0),
    rule: safeCollectionRule(row.rule_kind),
    ruleValue: String(row.rule_value ?? ''),
    seoTitle: String(row.seo_title ?? ''),
    seoDescription: String(row.seo_description ?? ''),
  }
}

/** Every collection, published or not — the admin list. */
export async function listCollections(siteId: number): Promise<Collection[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT ${COLUMNS} FROM storefront_collections ORDER BY sort_order, title, id`,
  )
  return rows.map(mapCollection)
}

/** The ones a shopper can reach. */
export async function publishedCollections(siteId: number): Promise<Collection[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT ${COLUMNS} FROM storefront_collections
      WHERE is_published = 1 ORDER BY sort_order, title, id`,
  )
  return rows.map(mapCollection)
}

export async function getCollection(siteId: number, id: number): Promise<Collection | null> {
  if (!Number.isInteger(id) || id <= 0) return null
  const row = await siteQueryOne<Row>(
    siteId,
    `SELECT ${COLUMNS} FROM storefront_collections WHERE id = ?`,
    [id],
  )
  return row ? mapCollection(row) : null
}

/**
 * By slug, for the public route.
 *
 * Unpublished resolves to null rather than to the collection: an address that
 * works before a merchant is ready is a page shared by accident.
 */
export async function collectionBySlug(siteId: number, slug: string): Promise<Collection | null> {
  const row = await siteQueryOne<Row>(
    siteId,
    `SELECT ${COLUMNS} FROM storefront_collections WHERE slug = ? AND is_published = 1`,
    [String(slug ?? '').slice(0, 60)],
  )
  return row ? mapCollection(row) : null
}

/** The product ids a MANUAL collection holds, in the order somebody chose. */
export async function collectionPicks(siteId: number, collectionId: number): Promise<number[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT product_id FROM storefront_collection_products
      WHERE collection_id = ? ORDER BY sort_order, product_id`,
    [collectionId],
  )
  return rows.map((r) => Number(r.product_id))
}

/**
 * What a collection actually holds.
 *
 * ── EVERY RULE GOES THROUGH THE PUBLISH GATES ────────────────────────────
 *
 * Including 'manual'. A merchant who picks a product and later unpublishes it
 * should see it LEAVE the collection, not have the pick override the rules —
 * `publishedProducts` makes exactly this argument for the page builder's
 * hand-picked rows, and a collection is no different.
 */
export async function collectionProducts(
  context: StorefrontContext,
  collection: Collection,
  options: Pick<CatalogueOptions, 'limit' | 'offset' | 'sort'> = {},
): Promise<StorefrontProduct[]> {
  const limit = options.limit ?? 60

  switch (collection.rule) {
    case 'manual': {
      const ids = await collectionPicks(context.catalogueSiteId, collection.id)
      if (ids.length === 0) return []
      /*
       * `ids` keeps the merchant's order — publishedProducts orders by
       * FIELD(id, …) when given picks, which is the whole reason the picks are
       * passed rather than resolved separately.
       */
      return publishedProducts(context, { ids, limit: Math.min(limit, MAX_COLLECTION_PICKS) })
    }
    case 'special':
      return productsOnSpecial(context, limit)
    case 'popular':
      return popularProducts(context, limit)
    case 'newest':
      return publishedProducts(context, { ...options, limit, sort: 'newest' })
    case 'brand':
      return publishedProducts(context, { ...options, limit, brand: collection.ruleValue })
    case 'department': {
      const departmentId = Number(collection.ruleValue)
      if (!Number.isInteger(departmentId) || departmentId <= 0) return []
      return publishedProducts(context, { ...options, limit, departmentId })
    }
  }
}

export type CollectionInput = {
  slug: string
  title: string
  description: string
  imageId: number | null
  isPublished: boolean
  sortOrder: number
  rule: string
  ruleValue: string
  seoTitle: string
  seoDescription: string
}

export type SaveResult = { ok: true; id: number } | { ok: false; error: string }

/**
 * Create or update one collection.
 *
 * The slug is derived from the title when a merchant has not typed one, and
 * refused when it reduces to nothing — a collection with no address cannot be
 * reached, and quietly generating one would give two of them the same address
 * the moment two titles reduced to the same thing.
 */
export async function saveCollection(
  siteId: number,
  id: number | null,
  input: CollectionInput,
  actor: string,
): Promise<SaveResult> {
  const title = String(input.title ?? '').trim().slice(0, 120)
  if (!title) return { ok: false, error: 'A collection needs a name.' }

  const slug = safeCollectionSlug(input.slug || title)
  if (!slug) {
    return {
      ok: false,
      error: 'That name cannot be turned into a web address. Use some letters or numbers.',
    }
  }

  // Two collections sharing an address is two pages at one URL, and whichever
  // the query happened to return would be the one a shopper got.
  const clash = await siteQueryOne<Row>(
    siteId,
    `SELECT id FROM storefront_collections WHERE slug = ? AND id <> ?`,
    [slug, id ?? 0],
  )
  if (clash) return { ok: false, error: `Another collection already uses “${slug}”.` }

  if (id === null) {
    const [{ n }] = await siteQuery<{ n: number }>(
      siteId,
      `SELECT COUNT(*) AS n FROM storefront_collections`,
    )
    if (Number(n) >= MAX_COLLECTIONS) {
      return { ok: false, error: `A shop can have ${MAX_COLLECTIONS} collections.` }
    }
  }

  const values = [
    slug,
    title,
    String(input.description ?? '').slice(0, 300),
    Number.isInteger(input.imageId) && (input.imageId ?? 0) > 0 ? input.imageId : null,
    input.isPublished ? 1 : 0,
    Number.isFinite(Number(input.sortOrder)) ? Math.trunc(Number(input.sortOrder)) : 0,
    safeCollectionRule(input.rule),
    String(input.ruleValue ?? '').slice(0, 120),
    String(input.seoTitle ?? '').slice(0, 120),
    String(input.seoDescription ?? '').slice(0, 300),
    actor.slice(0, 120),
  ]

  if (id === null) {
    const result = await siteExecute(
      siteId,
      `INSERT INTO storefront_collections
         (slug, title, description, image_id, is_published, sort_order,
          rule_kind, rule_value, seo_title, seo_description, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?)`,
      values,
    )
    return { ok: true, id: Number((result as { insertId?: number }).insertId ?? 0) }
  }

  await siteExecute(
    siteId,
    `UPDATE storefront_collections
        SET slug = ?, title = ?, description = ?, image_id = ?, is_published = ?,
            sort_order = ?, rule_kind = ?, rule_value = ?, seo_title = ?,
            seo_description = ?, updated_at = NOW(), updated_by = ?
      WHERE id = ?`,
    [...values, id],
  )
  return { ok: true, id }
}

/**
 * Replace what a manual collection holds.
 *
 * Delete and rewrite, in a transaction, for the same reason a menu is: the
 * order is the content, and a half-written collection is a grid missing the
 * things a merchant just arranged.
 */
export async function saveCollectionPicks(
  siteId: number,
  collectionId: number,
  productIds: number[],
): Promise<{ ok: true } | { ok: false; error: string }> {
  const ids = [
    ...new Set(
      (Array.isArray(productIds) ? productIds : [])
        .map((v) => (typeof v === 'number' ? v : Number(v)))
        // Junk is DISCARDED, never clamped: clamping would turn 'abc' into
        // product 1 — a reference to a real product nobody picked.
        .filter((v) => Number.isInteger(v) && v > 0),
    ),
  ].slice(0, MAX_COLLECTION_PICKS)

  /*
   * Only ids that are actually products.
   *
   * The foreign key would otherwise refuse the whole transaction over one
   * stale id — and a merchant who arranged twenty products, one of which was
   * deleted by somebody else while they worked, would lose all twenty to an
   * error naming a constraint. Filtering here turns that into nineteen saved
   * and one quietly gone, which is what they would have done by hand.
   */
  const real =
    ids.length === 0
      ? []
      : (
          await siteQuery<{ id: number }>(
            siteId,
            `SELECT id FROM products WHERE id IN (${ids.map(() => '?').join(',')})`,
            ids,
          )
        ).map((r) => Number(r.id))
  const keep = new Set(real)
  // The merchant's ORDER, filtered — not the order the database returned them.
  const ordered = ids.filter((id) => keep.has(id))

  await siteTransaction(siteId, async (tx) => {
    await tx.execute(`DELETE FROM storefront_collection_products WHERE collection_id = ?`, [
      collectionId,
    ])
    let order = 0
    for (const productId of ordered) {
      await tx.execute(
        `INSERT INTO storefront_collection_products (collection_id, product_id, sort_order)
         VALUES (?, ?, ?)`,
        [collectionId, productId, order++],
      )
    }
  })
  return { ok: true }
}

/** Remove one. Its picks and its built page go with it — both cascade. */
export async function deleteCollection(siteId: number, id: number): Promise<void> {
  await siteExecute(siteId, `DELETE FROM storefront_collections WHERE id = ?`, [id])
}
