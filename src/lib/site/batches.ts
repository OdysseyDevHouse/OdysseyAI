import 'server-only'
import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import { siteQuery } from '../siteDb'
import { supplierDbPrefix } from './customerDb'
import { round, toNum } from '../decimals'
import type { Actor } from './activityLog'

/**
 * Batch / lot / expiry tracking — the per-lot analogue of serials.
 *
 * ── THE HOOK IS TOTAL, AND THAT IS THE DESIGN ────────────────────────────
 *
 * Serials hook per caller because unit identity needs a human at every site
 * — someone picks a box, someone scans an IMEI. Which LOT moved is machine-
 * decidable (earliest expiry first) everywhere except goods receipt, so
 * batches hook once, inside recordMovement, the single gate every stock
 * change passes through. Every caller present and future — sales, GRVs,
 * takes, adjustments, transfers, manufacturing, refers, offline sync — is
 * covered by construction, which is what keeps the invariants checkable:
 *
 *   (T1) Σ qty_remaining over a product's lots  = products.stock_on_hand
 *   (T2) Σ qty_remaining per location           = product_location_stock
 *   (T3) qty_remaining per lot                  = Σ its batch_movements
 *
 * ── THE UNTRACKED BUCKET ─────────────────────────────────────────────────
 *
 * Stock arrives without lot data — opening balances, write-ons, a type
 * flipped mid-life, an oversell at the till. Refusing would block trade;
 * skipping would break T1 silently. Instead each product/location holds at
 * most one bucket row (batch_no = ''), which absorbs unattributed quantity
 * and MAY GO NEGATIVE on an oversell, exactly as stock_on_hand itself may:
 * hiding an over-commitment is worse than showing it. The Batches screen
 * flags it; the repair is a count or a corrected receipt, never a clamp.
 *
 * ⚠ NOTHING HERE WRITES products OR product_location_stock. recordMovement
 * owns those figures; this module only ever mirrors slices of movements
 * that have already happened. "Fixing" that would double-count every sale.
 *
 * Concurrency: recordMovement has already locked the product row (the
 * `stock_on_hand + ?` UPDATE) before the hook runs, so two tills on one
 * product are serialised; FOR UPDATE on the lot rows is belt and braces.
 */

type Row = RowDataPacket & Record<string, unknown>

export type Batch = {
  id: number
  productId: number
  productCode: string
  productDescription: string
  locationId: number
  locationCode: string | null
  /** '' is the untracked bucket — render it as such. */
  batchNo: string
  expiryDate: string | null
  qtyReceived: number
  qtyRemaining: number
  costExcl: number
  receivedDocId: number | null
  receivedDocNumber: string | null
  supplierName: string | null
  receivedAt: Date | null
  note: string | null
}

/** Per-movement overrides a caller can set on MovementInput.batch. */
export type BatchDirective = {
  /** GRV receipt: the lot identity coming in. */
  batchNo?: string | null
  expiryDate?: string | null
  /** An exact lot, in or out — the recall write-off. */
  batchId?: number | null
  /** A return: mirror the slices the original sale line took. */
  returnOfLineId?: number | null
  /** GRV void: back out the lots this document created. */
  reverseReceiptOfDocId?: number | null
  /**
   * A lot named at the TILL, as observed — scanned off the pack or typed by
   * the clerk (234).
   *
   * Distinct from `batchNo` above, which names a lot being CREATED by a
   * receipt. This one names a lot the goods are believed to have come FROM, so
   * it is matched against existing lots rather than minting one, and a miss is
   * a reportable event rather than a new row.
   */
  soldFromBatchNo?: string | null
  /**
   * Refuse the movement when `soldFromBatchNo` matches no lot, instead of
   * falling back to FEFO. The shop's `lot_capture_strict` setting.
   */
  strict?: boolean
}

function mapBatch(r: Row): Batch {
  return {
    id: Number(r.id),
    productId: Number(r.product_id),
    productCode: String(r.product_code ?? ''),
    productDescription: String(r.product_description ?? ''),
    locationId: Number(r.location_id),
    locationCode: (r.location_code as string | null) ?? null,
    batchNo: String(r.batch_no ?? ''),
    expiryDate: r.expiry_date === null ? null : String(r.expiry_date).slice(0, 10),
    qtyReceived: toNum(r.qty_received),
    qtyRemaining: toNum(r.qty_remaining),
    costExcl: toNum(r.cost_excl),
    receivedDocId: r.received_doc_id === null ? null : Number(r.received_doc_id),
    receivedDocNumber: (r.received_doc_number as string | null) ?? null,
    supplierName: (r.supplier_name as string | null) ?? null,
    receivedAt: (r.received_at as Date | null) ?? null,
    note: (r.note as string | null) ?? null,
  }
}

const localToday = (): string => {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

/* ── The tx primitives ────────────────────────────────────────────────────── */

async function writeSlice(
  tx: PoolConnection,
  actor: Actor,
  batchId: number,
  qty: number,
  meta: {
    action: string
    movementId: number | null
    documentId: number | null
    documentLineId: number | null
    source: string
    note?: string | null
  },
): Promise<void> {
  await tx.execute(
    `UPDATE product_batches SET qty_remaining = qty_remaining + ? WHERE id = ?`,
    [round(qty, 3).toFixed(3), batchId] as never,
  )
  await tx.execute(
    `INSERT INTO batch_movements
       (batch_id, movement_id, action, qty_change, document_id, document_line_id, source, user_id, user_name, note)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [
      batchId,
      meta.movementId,
      meta.action.slice(0, 24),
      round(qty, 3).toFixed(3),
      meta.documentId,
      meta.documentLineId,
      meta.source.slice(0, 30),
      actor.userId,
      actor.userName.slice(0, 120),
      meta.note?.slice(0, 190) ?? null,
    ] as never,
  )
}

/** Find-or-create the untracked bucket at a location. */
async function bucketIdTx(
  tx: PoolConnection,
  productId: number,
  locationId: number,
): Promise<number> {
  const [[existing]] = await tx.query<Row[]>(
    `SELECT id FROM product_batches WHERE product_id = ? AND location_id = ? AND batch_no = '' FOR UPDATE`,
    [productId, locationId] as never,
  )
  if (existing) return Number(existing.id)
  const [res] = await tx.execute(
    `INSERT INTO product_batches (product_id, location_id, batch_no) VALUES (?,?,'')`,
    [productId, locationId] as never,
  )
  return (res as { insertId: number }).insertId
}

/**
 * Find-or-create a lot and add quantity — the receipt path.
 *
 * Identity is (product, location, batch_no): re-receiving the same lot adds
 * to it (cost stays first-received — costs live on movements, not here), and
 * the same lot number wearing a DIFFERENT expiry is refused by name, because
 * one of the two deliveries is mislabelled and only a person can say which.
 */
export async function receiveBatchTx(
  tx: PoolConnection,
  actor: Actor,
  input: {
    productId: number
    locationId: number
    batchNo: string
    expiryDate: string | null
    qty: number
    costExcl: number
    documentId: number | null
    movementId: number | null
    lineLabel: string
    source?: string
  },
): Promise<number> {
  const batchNo = input.batchNo.trim().toUpperCase().slice(0, 64)
  if (!batchNo) throw new Error(`${input.lineLabel}: a lot needs its batch number.`)

  const [[existing]] = await tx.query<Row[]>(
    `SELECT id, expiry_date FROM product_batches
      WHERE product_id = ? AND location_id = ? AND batch_no = ? FOR UPDATE`,
    [input.productId, input.locationId, batchNo] as never,
  )

  let batchId: number
  if (existing) {
    const held = existing.expiry_date === null ? null : String(existing.expiry_date).slice(0, 10)
    if (input.expiryDate && held && input.expiryDate !== held) {
      throw new Error(
        `${input.lineLabel}: lot ${batchNo} is on file expiring ${held}, but this delivery says ${input.expiryDate}. One of the two is mislabelled — check the stock before receiving.`,
      )
    }
    batchId = Number(existing.id)
    await tx.execute(
      `UPDATE product_batches
          SET qty_received = qty_received + ?,
              expiry_date = COALESCE(expiry_date, ?)
        WHERE id = ?`,
      [round(input.qty, 3).toFixed(3), input.expiryDate, batchId] as never,
    )
  } else {
    const [res] = await tx.execute(
      `INSERT INTO product_batches
         (product_id, location_id, batch_no, expiry_date, qty_received, qty_remaining,
          cost_excl, received_doc_id, received_at)
       VALUES (?,?,?,?,?,0,?,?,NOW())`,
      [
        input.productId,
        input.locationId,
        batchNo,
        input.expiryDate,
        round(input.qty, 3).toFixed(3),
        round(input.costExcl, 4).toFixed(4),
        input.documentId,
      ] as never,
    )
    batchId = (res as { insertId: number }).insertId
  }

  await writeSlice(tx, actor, batchId, input.qty, {
    action: 'receipt',
    movementId: input.movementId,
    documentId: input.documentId,
    documentLineId: null,
    source: input.source ?? 'grv',
  })
  return batchId
}

/**
 * FEFO allocation for an outbound movement.
 *
 * mode 'sale': non-expired lots earliest-expiry first (dateless lots last —
 * no urgency), THEN expired lots — the sale still posts, because the shelf
 * is authoritative over data typed at a receiving door, and a till that
 * stops on a stale expiry stops trade on a typo. The draw from expired
 * stock is logged so somebody hears about it. mode 'out' (write-offs,
 * transfers out) is a single pass earliest-first, which naturally consumes
 * expired stock first — exactly what a shrinkage write-off should do.
 */
export async function allocateFefoTx(
  tx: PoolConnection,
  actor: Actor,
  input: {
    productId: number
    locationId: number
    /** Positive magnitude to take. */
    qty: number
    mode: 'sale' | 'out'
    movementId: number
    action: string
    source: string
    documentId: number | null
    documentLineId: number | null
  },
): Promise<{ slices: { batchId: number; qty: number }[]; usedExpired: boolean; shortfall: number }> {
  const today = localToday()
  const slices: { batchId: number; qty: number }[] = []
  let remaining = round(input.qty, 3)
  let usedExpired = false

  const passes: string[] =
    input.mode === 'sale'
      ? [
          `AND (expiry_date IS NULL OR expiry_date >= '${today}')`,
          `AND expiry_date IS NOT NULL AND expiry_date < '${today}'`,
        ]
      : ['']

  for (const clause of passes) {
    if (remaining <= 0) break
    const [rows] = await tx.query<Row[]>(
      `SELECT id, qty_remaining, expiry_date FROM product_batches
        WHERE product_id = ? AND location_id = ? AND qty_remaining > 0 AND batch_no <> ''
        ${clause}
        ORDER BY (expiry_date IS NULL), expiry_date, received_at, id
        FOR UPDATE`,
      [input.productId, input.locationId] as never,
    )
    for (const row of rows) {
      if (remaining <= 0) break
      const take = Math.min(remaining, toNum(row.qty_remaining))
      if (take <= 0) continue
      if (clause.includes('<')) usedExpired = true
      await writeSlice(tx, actor, Number(row.id), -take, {
        action: input.action,
        movementId: input.movementId,
        documentId: input.documentId,
        documentLineId: input.documentLineId,
        source: input.source,
      })
      slices.push({ batchId: Number(row.id), qty: take })
      remaining = round(remaining - take, 3)
    }
  }

  if (remaining > 0) {
    // The oversell / no-lot-data remainder: the bucket takes it and may go
    // negative — visible on the screen, never hidden.
    const bucket = await bucketIdTx(tx, input.productId, input.locationId)
    await writeSlice(tx, actor, bucket, -remaining, {
      action: input.action,
      movementId: input.movementId,
      documentId: input.documentId,
      documentLineId: input.documentLineId,
      source: input.source,
      note: 'No tracked lot could cover this — see the untracked bucket',
    })
    slices.push({ batchId: bucket, qty: remaining })
  }

  return { slices, usedExpired, shortfall: remaining }
}

/**
 * An inbound return: the quantity goes back to the lots it LEFT.
 *
 * Found via the original line's negative slices; anything unmatchable at
 * this location falls back to the newest open lot (most returns are recent
 * purchases), else the bucket.
 */
export async function returnToBatchTx(
  tx: PoolConnection,
  actor: Actor,
  input: {
    productId: number
    locationId: number
    /** Positive magnitude coming back. */
    qty: number
    returnOfLineId: number | null
    movementId: number
    action: string
    source: string
    documentId: number | null
  },
): Promise<void> {
  let remaining = round(input.qty, 3)

  if (input.returnOfLineId) {
    const [slices] = await tx.query<Row[]>(
      `SELECT bm.batch_id, SUM(-bm.qty_change) AS taken
         FROM batch_movements bm
         JOIN product_batches b ON b.id = bm.batch_id
        WHERE bm.document_line_id = ? AND bm.qty_change < 0
          AND b.product_id = ? AND b.location_id = ?
        GROUP BY bm.batch_id
        ORDER BY MIN(bm.id)`,
      [input.returnOfLineId, input.productId, input.locationId] as never,
    )
    for (const slice of slices) {
      if (remaining <= 0) break
      const give = Math.min(remaining, toNum(slice.taken))
      if (give <= 0) continue
      await writeSlice(tx, actor, Number(slice.batch_id), give, {
        action: input.action,
        movementId: input.movementId,
        documentId: input.documentId,
        documentLineId: input.returnOfLineId,
        source: input.source,
      })
      remaining = round(remaining - give, 3)
    }
  }

  if (remaining > 0) {
    const [[newest]] = await tx.query<Row[]>(
      `SELECT id FROM product_batches
        WHERE product_id = ? AND location_id = ? AND batch_no <> ''
        ORDER BY received_at DESC, id DESC LIMIT 1 FOR UPDATE`,
      [input.productId, input.locationId] as never,
    )
    const target = newest ? Number(newest.id) : await bucketIdTx(tx, input.productId, input.locationId)
    await writeSlice(tx, actor, target, remaining, {
      action: input.action,
      movementId: input.movementId,
      documentId: input.documentId,
      documentLineId: input.returnOfLineId,
      source: input.source,
      note: input.returnOfLineId ? 'Beyond what the original line took' : null,
    })
  }
}

/**
 * THE hook. Called by recordMovement inside its open transaction, after the
 * stock_movements row exists, and only for product_type = 'batch'. Maps the
 * movement to lot slices; throws (rolling the caller back) only on the
 * genuinely refusable cases — a lot receipt without data, a mislabelled
 * expiry, a GRV void of a consumed lot, a directive naming a foreign lot.
 */
export async function applyBatchMovementTx(
  tx: PoolConnection,
  actor: Actor,
  input: {
    productId: number
    locationId: number
    movementType: string
    qtyChange: number
    unitCostExcl: number
    movementId: number
    source: string
    sourceDocId: number | null
    sourceLineId: number | null
    batch?: BatchDirective
    lineLabel?: string
  },
): Promise<void> {
  const qty = round(input.qtyChange, 3)
  if (qty === 0) return
  const label = input.lineLabel ?? `Product #${input.productId}`
  const directive = input.batch ?? {}

  // ── GRV void: back out exactly what this document created ──────────────
  if (directive.reverseReceiptOfDocId) {
    const [lots] = await tx.query<Row[]>(
      `SELECT id, batch_no, qty_received, qty_remaining FROM product_batches
        WHERE product_id = ? AND location_id = ? AND received_doc_id = ?
        FOR UPDATE`,
      [input.productId, input.locationId, directive.reverseReceiptOfDocId] as never,
    )
    let toRemove = Math.abs(qty)
    for (const lot of lots) {
      if (toRemove <= 0) break
      const take = Math.min(toRemove, toNum(lot.qty_received))
      if (toNum(lot.qty_remaining) < take - 0.0005) {
        throw new Error(
          `Some of lot ${lot.batch_no} has already been sold — raise a supplier return instead of voiding the receipt.`,
        )
      }
      await writeSlice(tx, actor, Number(lot.id), -take, {
        action: input.movementType,
        movementId: input.movementId,
        documentId: input.sourceDocId,
        documentLineId: input.sourceLineId,
        source: input.source,
        note: 'Receipt voided',
      })
      await tx.execute(`UPDATE product_batches SET qty_received = qty_received - ? WHERE id = ?`, [
        take.toFixed(3),
        Number(lot.id),
      ] as never)
      // A lot born solely of the voided document and now empty vanishes —
      // its slices go with it by cascade, matching the serial rationale.
      await tx.execute(
        `DELETE FROM product_batches
          WHERE id = ? AND qty_received <= 0.0005 AND ABS(qty_remaining) <= 0.0005`,
        [Number(lot.id)] as never,
      )
      toRemove = round(toRemove - take, 3)
    }
    if (toRemove > 0) {
      // Whatever the void could not attribute comes off the bucket.
      const bucket = await bucketIdTx(tx, input.productId, input.locationId)
      await writeSlice(tx, actor, bucket, -toRemove, {
        action: input.movementType,
        movementId: input.movementId,
        documentId: input.sourceDocId,
        documentLineId: input.sourceLineId,
        source: input.source,
        note: 'Receipt voided — unattributed remainder',
      })
    }
    return
  }

  // ── An exact lot, named by the caller (the recall write-off) ───────────
  if (directive.batchId) {
    const [[lot]] = await tx.query<Row[]>(
      `SELECT id FROM product_batches WHERE id = ? AND product_id = ? AND location_id = ? FOR UPDATE`,
      [directive.batchId, input.productId, input.locationId] as never,
    )
    if (!lot) {
      throw new Error(`${label}: that lot does not belong to this product at this location.`)
    }
    await writeSlice(tx, actor, Number(lot.id), qty, {
      action: input.movementType,
      movementId: input.movementId,
      documentId: input.sourceDocId,
      documentLineId: input.sourceLineId,
      source: input.source,
    })
    return
  }

  if (qty > 0) {
    // ── Inbound ──────────────────────────────────────────────────────────
    if (directive.batchNo || directive.expiryDate) {
      const batchNo =
        directive.batchNo?.trim() || (directive.expiryDate ? `EXP-${directive.expiryDate}` : '')
      await receiveBatchTx(tx, actor, {
        productId: input.productId,
        locationId: input.locationId,
        batchNo,
        expiryDate: directive.expiryDate ?? null,
        qty,
        costExcl: input.unitCostExcl,
        documentId: input.sourceDocId,
        movementId: input.movementId,
        lineLabel: label,
        source: input.source,
      })
      return
    }

    if (input.movementType === 'sale_return' || directive.returnOfLineId) {
      await returnToBatchTx(tx, actor, {
        productId: input.productId,
        locationId: input.locationId,
        qty,
        returnOfLineId: directive.returnOfLineId ?? input.sourceLineId,
        movementId: input.movementId,
        action: input.movementType,
        source: input.source,
        documentId: input.sourceDocId,
      })
      return
    }

    if (input.movementType === 'transfer_in') {
      // Mirror the paired transfer_out written moments earlier in this same
      // document: the lot identity travels with the goods.
      const [outSlices] = await tx.query<Row[]>(
        `SELECT b.batch_no, b.expiry_date, SUM(-bm.qty_change) AS moved
           FROM batch_movements bm
           JOIN product_batches b ON b.id = bm.batch_id
          WHERE bm.document_id <=> ? AND bm.action = 'transfer_out' AND bm.qty_change < 0
            AND b.product_id = ?
          GROUP BY b.batch_no, b.expiry_date
          ORDER BY MIN(bm.id)`,
        [input.sourceDocId, input.productId] as never,
      )
      let remaining = qty
      for (const slice of outSlices) {
        if (remaining <= 0) break
        const give = Math.min(remaining, toNum(slice.moved))
        if (give <= 0) continue
        const batchNo = String(slice.batch_no ?? '')
        if (!batchNo) continue
        await receiveBatchTx(tx, actor, {
          productId: input.productId,
          locationId: input.locationId,
          batchNo,
          expiryDate: slice.expiry_date === null ? null : String(slice.expiry_date).slice(0, 10),
          qty: give,
          costExcl: input.unitCostExcl,
          documentId: input.sourceDocId,
          movementId: input.movementId,
          lineLabel: label,
          source: input.source,
        })
        remaining = round(remaining - give, 3)
      }
      if (remaining > 0) {
        const bucket = await bucketIdTx(tx, input.productId, input.locationId)
        await writeSlice(tx, actor, bucket, remaining, {
          action: input.movementType,
          movementId: input.movementId,
          documentId: input.sourceDocId,
          documentLineId: input.sourceLineId,
          source: input.source,
          note: 'Transfer arrived without lot pairing',
        })
      }
      return
    }

    // Write-on with no lot data: the newest lot at the location — most stock
    // found on a count arrived recently — else the bucket.
    const [[newest]] = await tx.query<Row[]>(
      `SELECT id FROM product_batches
        WHERE product_id = ? AND location_id = ? AND batch_no <> ''
        ORDER BY received_at DESC, id DESC LIMIT 1 FOR UPDATE`,
      [input.productId, input.locationId] as never,
    )
    const target = newest ? Number(newest.id) : await bucketIdTx(tx, input.productId, input.locationId)
    await writeSlice(tx, actor, target, qty, {
      action: input.movementType,
      movementId: input.movementId,
      documentId: input.sourceDocId,
      documentLineId: input.sourceLineId,
      source: input.source,
    })
    return
  }

  // ── Outbound, from a lot the till NAMED (234) ──────────────────────────
  //
  // Takes precedence over FEFO because it is an observation rather than an
  // inference: somebody read this number off the pack in their hand, and FEFO
  // is only ever a guess about which pack that was.
  const named = directive.soldFromBatchNo?.trim()
  if (named) {
    const [[lot]] = await tx.query<Row[]>(
      `SELECT id, qty_remaining FROM product_batches
        WHERE product_id = ? AND location_id = ? AND batch_no = ?
        FOR UPDATE`,
      [input.productId, input.locationId, named.slice(0, 64)] as never,
    )

    if (lot) {
      /*
       * Booked against the named lot even when that lot is EMPTY, which drives
       * it negative — the untracked bucket's rule, for the untracked bucket's
       * reason. The alternative is silently re-routing the sale to a lot
       * nobody named, which would overwrite the one fact the shop went out of
       * its way to capture and hide the discrepancy that caused it. A negative
       * lot is a visible, fixable count problem; a rewritten one is neither.
       */
      await writeSlice(tx, actor, Number(lot.id), qty, {
        action: input.movementType,
        movementId: input.movementId,
        documentId: input.sourceDocId,
        documentLineId: input.sourceLineId,
        source: input.source,
      })
      return
    }

    // Named a lot that does not exist here.
    if (directive.strict) {
      throw new Error(
        `${label}: lot ${named} is not on file at this location. Receive it first, or check the number.`,
      )
    }

    /*
     * Lenient: the sale still posts, by FEFO, and the observation is recorded
     * as an event. Same reasoning as selling expired stock — a till that stops
     * trading because a supplier printed a barcode wrong is worse than one
     * that books its best guess and tells somebody. What must NOT happen is
     * losing the number quietly, because "we were told L2408A and could not
     * place it" is a different and more useful fact than "we do not know".
     */
    await tx
      .execute(
        `INSERT INTO activity_log (entity, entity_id, action, detail, user_id, user_name)
         VALUES ('product', ?, 'lot_not_found', ?, ?, ?)`,
        [
          input.productId,
          `${label}: sold as lot ${named.slice(0, 60)}, which is not on file here — booked by earliest expiry instead`,
          actor.userId,
          actor.userName.slice(0, 120),
        ] as never,
      )
      .catch(() => undefined)
  }

  // ── Outbound ───────────────────────────────────────────────────────────
  const { usedExpired } = await allocateFefoTx(tx, actor, {
    productId: input.productId,
    locationId: input.locationId,
    qty: Math.abs(qty),
    mode: input.movementType === 'sale' ? 'sale' : 'out',
    movementId: input.movementId,
    action: input.movementType,
    source: input.source,
    documentId: input.sourceDocId,
    documentLineId: input.sourceLineId,
  })

  if (usedExpired && input.movementType === 'sale') {
    // In-tx so the warning cannot outlive a rolled-back sale. activity_log is
    // written directly rather than through logActivity, which opens its own
    // connection.
    await tx
      .execute(
        `INSERT INTO activity_log (entity, entity_id, action, detail, user_id, user_name)
         VALUES ('product', ?, 'expired_stock_sold', ?, ?, ?)`,
        [
          input.productId,
          `${label}: a sale drew on expired stock — check the shelf against the lot dates`,
          actor.userId,
          actor.userName.slice(0, 120),
        ] as never,
      )
      .catch(() => undefined)
  }
}

/* ── Reads ────────────────────────────────────────────────────────────────── */

export type BatchDrift = {
  productId: number
  code: string
  description: string
  locationId: number | null
  locationCode: string | null
  batchId: number | null
  batchNo: string | null
  stockOnHand: number
  batchQty: number
  drift: number
}

/**
 * Proves T2 and T3. Report-only, never repairs — the reconcileSerials rule.
 */
export async function reconcileBatches(siteId: number): Promise<BatchDrift[]> {
  const out: BatchDrift[] = []

  // T2: per-location lot sums vs the pile.
  const t2 = await siteQuery<Row>(
    siteId,
    `SELECT p.id AS product_id, p.code, p.description,
            pls.location_id, sl.code AS location_code,
            pls.stock_on_hand,
            COALESCE(b.total, 0) AS batch_qty
       FROM products p
       JOIN product_location_stock pls ON pls.product_id = p.id
       LEFT JOIN stock_locations sl ON sl.id = pls.location_id
       LEFT JOIN (SELECT product_id, location_id, SUM(qty_remaining) AS total
                    FROM product_batches GROUP BY product_id, location_id) b
         ON b.product_id = p.id AND b.location_id = pls.location_id
      WHERE p.product_type = 'batch'
        AND ABS(COALESCE(b.total, 0) - pls.stock_on_hand) > 0.0005`,
  )
  for (const r of t2) {
    out.push({
      productId: Number(r.product_id),
      code: String(r.code ?? ''),
      description: String(r.description ?? ''),
      locationId: Number(r.location_id),
      locationCode: (r.location_code as string | null) ?? null,
      batchId: null,
      batchNo: null,
      stockOnHand: toNum(r.stock_on_hand),
      batchQty: toNum(r.batch_qty),
      drift: round(toNum(r.batch_qty) - toNum(r.stock_on_hand), 3),
    })
  }

  // T3: each lot vs its own slices.
  const t3 = await siteQuery<Row>(
    siteId,
    `SELECT b.id AS batch_id, b.batch_no, b.qty_remaining, b.location_id,
            p.id AS product_id, p.code, p.description, sl.code AS location_code,
            COALESCE(m.total, 0) AS slice_total
       FROM product_batches b
       JOIN products p ON p.id = b.product_id
       LEFT JOIN stock_locations sl ON sl.id = b.location_id
       LEFT JOIN (SELECT batch_id, SUM(qty_change) AS total
                    FROM batch_movements GROUP BY batch_id) m ON m.batch_id = b.id
      WHERE ABS(b.qty_remaining - COALESCE(m.total, 0)) > 0.0005`,
  )
  for (const r of t3) {
    out.push({
      productId: Number(r.product_id),
      code: String(r.code ?? ''),
      description: String(r.description ?? ''),
      locationId: Number(r.location_id),
      locationCode: (r.location_code as string | null) ?? null,
      batchId: Number(r.batch_id),
      batchNo: String(r.batch_no ?? ''),
      stockOnHand: toNum(r.qty_remaining),
      batchQty: toNum(r.slice_total),
      drift: round(toNum(r.slice_total) - toNum(r.qty_remaining), 3),
    })
  }

  return out
}

/** A batch is this shop's stock; the supplier that sent it may be the group's. */
const selectBatch = (sdb: string) => `
  SELECT b.*, p.code AS product_code, p.description AS product_description,
         sl.code AS location_code,
         pd.document_number AS received_doc_number, s.name AS supplier_name
    FROM product_batches b
    JOIN products p ON p.id = b.product_id
    LEFT JOIN stock_locations sl ON sl.id = b.location_id
    LEFT JOIN purchase_documents pd ON pd.id = b.received_doc_id
    LEFT JOIN ${sdb}suppliers s ON s.id = pd.supplier_id
`

export type BatchListOptions = {
  productId?: number
  locationId?: number
  q?: string
  filter?: 'all' | 'open' | 'expiring' | 'expired' | 'untracked'
  expiringDays?: number
  limit?: number
  offset?: number
}

export async function listBatches(
  siteId: number,
  options: BatchListOptions = {},
): Promise<{ items: Batch[]; total: number }> {
  const where: string[] = []
  const params: unknown[] = []

  if (options.productId) {
    where.push('b.product_id = ?')
    params.push(options.productId)
  }
  if (options.locationId) {
    where.push('b.location_id = ?')
    params.push(options.locationId)
  }
  if (options.q?.trim()) {
    const term = `%${options.q.trim()}%`
    where.push('(b.batch_no LIKE ? OR p.code LIKE ? OR p.description LIKE ?)')
    params.push(term, term, term)
  }
  const days = Math.max(1, Math.floor(options.expiringDays ?? 30))
  switch (options.filter) {
    case 'open':
      where.push('b.qty_remaining > 0')
      break
    case 'expiring':
      where.push(
        `b.qty_remaining > 0 AND b.expiry_date IS NOT NULL AND b.expiry_date <= DATE_ADD(CURDATE(), INTERVAL ${days} DAY)`,
      )
      break
    case 'expired':
      where.push('b.qty_remaining > 0 AND b.expiry_date IS NOT NULL AND b.expiry_date < CURDATE()')
      break
    case 'untracked':
      where.push(`b.batch_no = '' AND ABS(b.qty_remaining) > 0.0005`)
      break
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const limit = Math.min(Math.max(options.limit ?? 200, 1), 1000)
  const offset = Math.max(options.offset ?? 0, 0)
  const sdb = await supplierDbPrefix(siteId)

  const [rows, count] = await Promise.all([
    siteQuery<Row>(
      siteId,
      `${selectBatch(sdb)} ${whereSql}
        ORDER BY (b.expiry_date IS NULL), b.expiry_date, p.description, b.id
        LIMIT ${limit} OFFSET ${offset}`,
      params,
    ),
    siteQuery<Row>(
      siteId,
      `SELECT COUNT(*) AS total FROM product_batches b JOIN products p ON p.id = b.product_id ${whereSql}`,
      params,
    ),
  ])
  return { items: rows.map(mapBatch), total: Number(count[0]?.total ?? 0) }
}

/** The expiring-soon read: what is on the shelf and running out of time. */
export async function expiringSoon(
  siteId: number,
  days = 30,
  locationId?: number,
): Promise<Batch[]> {
  const { items } = await listBatches(siteId, {
    filter: 'expiring',
    expiringDays: days,
    locationId,
    limit: 500,
  })
  return items
}

/** One row of the till's lot picker. */
export type TillLot = {
  batchNo: string
  expiryDate: string | null
  qtyRemaining: number
  /** Already past its date. Shown, not hidden — the shelf is authoritative. */
  expired: boolean
}

/**
 * The lots a clerk may pick from for one product, at one till (234).
 *
 * FEFO order — earliest expiry first, dateless last — so the top row is the
 * one the server WOULD have chosen, and the common case is confirming it with
 * one tap rather than reading a list.
 *
 * Deliberately NOT filtered to unexpired: a shop that still has expired stock
 * on the shelf must be able to say so at the till, exactly as `allocateFefoTx`
 * will still sell it. Hiding the lot would force the clerk to pick a wrong one.
 *
 * The untracked bucket (batch_no = '') is excluded — it is an accounting
 * residue, not something anybody can read off a pack.
 */
export async function lotsForTill(
  siteId: number,
  productId: number,
  locationId: number,
): Promise<TillLot[]> {
  const today = localToday()
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT batch_no, expiry_date, qty_remaining
       FROM product_batches
      WHERE product_id = ? AND location_id = ? AND batch_no <> '' AND qty_remaining > 0
      ORDER BY (expiry_date IS NULL), expiry_date, received_at, id
      LIMIT 50`,
    [productId, locationId],
  )
  return rows.map((r) => {
    const expiry = r.expiry_date === null ? null : String(r.expiry_date).slice(0, 10)
    return {
      batchNo: String(r.batch_no ?? ''),
      expiryDate: expiry,
      qtyRemaining: toNum(r.qty_remaining),
      expired: expiry !== null && expiry < today,
    }
  })
}

/**
 * Recall traceability, both directions: backward to the GRV and supplier
 * that brought the lot in, forward to every document that took it out.
 * Joined tolerantly — the serialHistory pattern — so a slice whose document
 * has been purged still shows what it was.
 */
export async function batchTrace(
  siteId: number,
  batchId: number,
): Promise<{
  batch: Batch
  events: {
    action: string
    qty: number
    source: string
    documentId: number | null
    documentNumber: string | null
    userName: string
    note: string | null
    at: Date
    /**
     * Whether somebody actually READ this lot number off the pack (234).
     *
     * The distinction a recall turns on. `false` means the server inferred the
     * lot by earliest expiry — a good guess about which pack left the shelf and
     * not a record of it, because a customer reaching past the front carton
     * leaves no trace at the till.
     *
     * Only ever true on an outbound SALE line that carried a lot. A receipt is
     * always observed (somebody typed it at the receiving door) and an
     * adjustment names its lot explicitly, so both are reported as observed.
     */
    observed: boolean
  }[]
} | null> {
  const rows = await siteQuery<Row>(
    siteId,
    `${selectBatch(await supplierDbPrefix(siteId))} WHERE b.id = ? LIMIT 1`,
    [batchId],
  )
  if (rows.length === 0) return null

  const events = await siteQuery<Row>(
    siteId,
    `SELECT bm.action, bm.qty_change, bm.source, bm.document_id, bm.user_name, bm.note, bm.created_at,
            CASE
              WHEN bm.source IN ('grv','purchase') THEN pd.document_number
              ELSE sd.document_number
            END AS document_number,
            sl.batch_no AS line_batch_no
       FROM batch_movements bm
       LEFT JOIN sales_documents sd ON sd.id = bm.document_id AND bm.source NOT IN ('grv','purchase','stock_take','adjustment','transfer')
       LEFT JOIN purchase_documents pd ON pd.id = bm.document_id AND bm.source IN ('grv','purchase')
       /* The sale LINE, for whether its lot was observed or inferred (234).
          Joined on the line rather than the document because a basket can hold
          a scanned lot and an unscanned one at once, and the answer differs
          per line. */
       LEFT JOIN sales_document_lines sl ON sl.id = bm.document_line_id
      WHERE bm.batch_id = ?
      ORDER BY bm.id`,
    [batchId],
  )

  return {
    batch: mapBatch(rows[0]),
    events: events.map((e) => ({
      action: String(e.action),
      qty: toNum(e.qty_change),
      source: String(e.source ?? ''),
      documentId: e.document_id === null ? null : Number(e.document_id),
      documentNumber: (e.document_number as string | null) ?? null,
      userName: String(e.user_name ?? ''),
      note: (e.note as string | null) ?? null,
      at: e.created_at as Date,
      /*
       * A sale is observed only when its line recorded a lot. Everything else
       * — receipts, adjustments, transfers, voids — reached its lot by being
       * told which one, so it is observed by construction.
       */
      observed:
        String(e.action) === 'sale' || String(e.action) === 'sale_return'
          ? String(e.line_batch_no ?? '').trim() !== ''
          : true,
    })),
  }
}

/**
 * Seeds the untracked bucket from the piles when a product BECOMES batch-
 * tracked with stock already on hand — T1 holds from the moment of
 * conversion instead of drifting until the first count.
 */
export async function seedUntrackedBatchesTx(
  tx: PoolConnection,
  actor: Actor,
  productId: number,
): Promise<void> {
  const [piles] = await tx.query<Row[]>(
    `SELECT location_id, stock_on_hand FROM product_location_stock
      WHERE product_id = ? AND ABS(stock_on_hand) > 0.0005`,
    [productId] as never,
  )
  for (const pile of piles) {
    const locationId = Number(pile.location_id)
    const held = toNum(pile.stock_on_hand)
    const [[sum]] = await tx.query<Row[]>(
      `SELECT COALESCE(SUM(qty_remaining), 0) AS total FROM product_batches
        WHERE product_id = ? AND location_id = ?`,
      [productId, locationId] as never,
    )
    const gap = round(held - toNum(sum?.total), 3)
    if (Math.abs(gap) < 0.0005) continue
    const bucket = await bucketIdTx(tx, productId, locationId)
    await writeSlice(tx, actor, bucket, gap, {
      action: 'opening',
      movementId: null,
      documentId: null,
      documentLineId: null,
      source: 'conversion',
      note: 'Stock on hand when the product became batch-tracked',
    })
  }
}
