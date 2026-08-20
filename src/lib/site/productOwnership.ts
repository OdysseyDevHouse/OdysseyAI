import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQueryOne } from '../siteDb'
import { groupForSite } from '../storeGroups'

/**
 * Who owns a product, and who may therefore change it.
 *
 * ── THE RULE ─────────────────────────────────────────────────────────────
 *
 * A product belongs to the store whose catalogue it was created in. That store
 * manages it; every other store that carries it may stock it, price it (where
 * pricing is not shared) and sell it, but may not change what it IS.
 *
 * One rule covers the two shapes a linked group takes:
 *
 *   HEAD OFFICE CREATES IT   origin = head office. Branches see it, stock it,
 *                            and cannot edit it. This is the franchise with a
 *                            central range.
 *   A BRANCH CREATES IT      origin = that branch. It manages its own local
 *                            line, and the product never fans out to head
 *                            office at all.
 *
 * A franchise gets both at once — a central range plus each branch's own
 * specials — without anybody choosing a mode.
 *
 * ── WHY THE ANSWER IS NOT SIMPLY "origin_site_id = me" ───────────────────
 *
 * NULL means "this store's own", because every product predating the column is
 * exactly that and a single store has no origin worth recording. So a NULL
 * origin is editable, and only a product that ARRIVED from elsewhere is not.
 *
 * ── THIS IS THE BOUNDARY ─────────────────────────────────────────────────
 *
 * The product screen asks this to render read-only, and the save action asks it
 * again to refuse. Both, deliberately: a greyed field is a courtesy, and the
 * action is the thing that actually stops a write.
 */

export type ProductOwnership = {
  /** The store whose catalogue this product belongs to. Null = this store's. */
  originSiteId: number | null
  /** Whether the calling store may change what the product is. */
  canEdit: boolean
  /** The owning store's name, for a message. Null when this store owns it. */
  ownerName: string | null
}

/** A product this store created, and may do anything with. */
const OWN: ProductOwnership = { originSiteId: null, canEdit: true, ownerName: null }

/**
 * Whether `siteId` may edit the product with this code.
 *
 * Never throws. A control-database problem or a site with no
 * `origin_site_id` column yet answers "yours", which is what every store
 * answered before this existed — narrowing edit rights on an infrastructure
 * blip would stop a shop maintaining its own catalogue.
 */
export async function ownershipOf(siteId: number, code: string): Promise<ProductOwnership> {
  try {
    const row = await siteQueryOne<RowDataPacket & { origin_site_id: number | null }>(
      siteId,
      'SELECT origin_site_id FROM products WHERE code = ? LIMIT 1',
      [code],
    )
    if (!row || row.origin_site_id === null) return OWN

    const origin = Number(row.origin_site_id)
    if (origin === siteId) return OWN

    // Named rather than left as an id: "managed by head office" is a sentence
    // somebody can act on, "origin_site_id 1" is not.
    let ownerName: string | null = null
    try {
      const group = await groupForSite(siteId)
      if (group) {
        const { membersOfGroup } = await import('../storeGroups')
        ownerName = (await membersOfGroup(group.id)).find((m) => m.siteId === origin)?.displayName ?? null
      }
    } catch {
      // A name is a nicety; the refusal stands without it.
    }

    return { originSiteId: origin, canEdit: false, ownerName }
  } catch {
    return OWN
  }
}

/**
 * Why this store may not edit the product, or null when it may.
 *
 * Phrased for the person at the screen: it says who to ask, not what the
 * schema thinks.
 */
export async function editRefusal(siteId: number, code: string): Promise<string | null> {
  const ownership = await ownershipOf(siteId, code)
  if (ownership.canEdit) return null

  const owner = ownership.ownerName ?? 'another store'
  return (
    `${code} is managed by ${owner}. You can stock it and sell it, and set your ` +
    'own prices where prices are not shared, but its details are changed there.'
  )
}

/**
 * The origin to stamp on a product this store is creating.
 *
 * NULL for a store that is not in a group, and null for head office itself —
 * a product is only marked when it will travel, and marking head office's own
 * products would make them unreadable to head office if the group were later
 * dissolved.
 *
 * A BRANCH creating its own product also gets null: it owns it, and the
 * fan-out does not carry it upward. The column only ever names a store that is
 * NOT the one holding the row.
 */
export function originForNewProduct(): number | null {
  return null
}
