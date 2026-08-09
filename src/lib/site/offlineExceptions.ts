import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne } from '../siteDb'
import { toNum } from '../decimals'

/**
 * What a manager has to look at after a shop traded offline.
 *
 * The sync engine never refuses a sale it can post — see offlineSync.ts. That is
 * the right policy (a refused sale is lost revenue, not an undone sale) but it only
 * works if the things it waves through are VISIBLE afterwards. This module is the
 * other half of that bargain: without a screen, an exception is a column nobody
 * reads and the policy quietly becomes "post anything".
 *
 * Three slices, because they need three different people:
 *
 *   · EXCEPTIONS — posted, on the books, but something disagreed. A price the
 *     cashier was not allowed to give, a total the till got wrong, an operator who
 *     no longer exists. A manager decides whether to credit or let it stand.
 *   · QUARANTINED — NOT posted, because posting would have written into a locked
 *     VAT period. Somebody has to reopen the period or re-date the sale. These are
 *     the urgent ones: the money is in the drawer and not in the books.
 *   · STUCK — claimed but never posted. Either a till is still retrying or
 *     something is genuinely wrong. Distinguished from the above because it is a
 *     PLUMBING problem, not a judgement call.
 */

export type OfflineException = {
  documentId: number
  documentNumber: string | null
  saleUid: string | null
  status: string
  documentDate: string
  takenAt: Date | null
  syncedAt: Date | null
  terminalCode: string | null
  userName: string
  customerName: string | null
  totalIncl: number
  exception: string
}

type Row = RowDataPacket & Record<string, unknown>

function mapException(r: Row): OfflineException {
  return {
    documentId: Number(r.id),
    documentNumber: (r.document_number as string | null) ?? null,
    saleUid: (r.offline_sale_uid as string | null) ?? null,
    status: String(r.status),
    documentDate: String(r.document_date).slice(0, 10),
    takenAt: (r.offline_taken_at as Date | null) ?? null,
    syncedAt: (r.offline_synced_at as Date | null) ?? null,
    terminalCode: (r.terminal_code as string | null) ?? null,
    userName: String(r.user_name ?? ''),
    customerName: (r.customer_name as string | null) ?? null,
    totalIncl: toNum(r.total_incl),
    exception: String(r.offline_exception ?? ''),
  }
}

/**
 * Sales that posted with something recorded against them.
 *
 * Finalised only. A quarantined sale also carries an exception but belongs in its
 * own list, because the action a manager takes is completely different: one is
 * "decide whether this was acceptable", the other is "this money is not on the
 * books yet".
 */
export async function listOfflineExceptions(
  siteId: number,
  options: { limit?: number; offset?: number } = {},
): Promise<{ items: OfflineException[]; total: number }> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200)
  const offset = Math.max(options.offset ?? 0, 0)

  const where = `offline_exception IS NOT NULL AND status = 'finalised'`

  const count = await siteQueryOne<RowDataPacket & { n: number }>(
    siteId,
    `SELECT COUNT(*) AS n FROM sales_documents WHERE ${where}`,
  )
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT id, document_number, offline_sale_uid, status, document_date,
            offline_taken_at, offline_synced_at, terminal_code, user_name,
            customer_name, total_incl, offline_exception
       FROM sales_documents
      WHERE ${where}
      ORDER BY offline_taken_at DESC, id DESC
      LIMIT ? OFFSET ?`,
    [limit, offset],
  )
  return { items: rows.map(mapException), total: Number(count?.n ?? 0) }
}

/**
 * Sales that could NOT be posted and are sitting as drafts.
 *
 * The urgent list. Every row here is cash in a drawer that no ledger knows about,
 * so it is deliberately unpaginated and unfiltered — if there are enough of these
 * to need paging, the shop has a much bigger problem than a screen layout.
 */
export async function listQuarantinedSales(siteId: number): Promise<OfflineException[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT id, document_number, offline_sale_uid, status, document_date,
            offline_taken_at, offline_synced_at, terminal_code, user_name,
            customer_name, total_incl, offline_exception
       FROM sales_documents
      WHERE offline_sale_uid IS NOT NULL
        AND offline_exception IS NOT NULL
        AND status IN ('draft','saved')
      ORDER BY offline_taken_at ASC, id ASC`,
  )
  return rows.map(mapException)
}

export type StuckClaim = {
  saleUid: string
  terminalId: number | null
  status: string
  documentNumber: string | null
  operatorName: string
  error: string | null
  attempts: number
  claimedAt: Date | null
  /**
   * Whether the sale this claim refers to still exists as a document.
   *
   * A `rejected` claim normally has a quarantined draft behind it, and the action
   * a manager takes is on that draft. If the draft has since been deleted there is
   * nothing left to act on, and presenting the row as an outstanding sale invites
   * somebody to hunt for a document that is not there. Shown as its own state
   * rather than hidden, because a claim outliving its document is worth seeing —
   * `fk_claim_doc` is ON DELETE SET NULL precisely so the record survives.
   */
  hasDocument: boolean
}

/**
 * Claims that never reached `posted`.
 *
 * A row a few seconds old is a till mid-flush and not interesting, so the caller
 * passes a minimum age. `rejected` rows are included regardless of age: those have
 * stopped retrying by definition and will sit there until somebody looks.
 */
export async function listStuckClaims(
  siteId: number,
  minAgeMinutes = 15,
): Promise<StuckClaim[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT c.sale_uid, c.terminal_id, c.status, c.document_number, c.operator_name,
            c.error, c.attempts, c.claimed_at,
            EXISTS (SELECT 1 FROM sales_documents d
                     WHERE d.offline_sale_uid = c.sale_uid) AS has_document
       FROM offline_sync_claims c
      WHERE c.status = 'rejected'
         OR (c.status = 'claimed' AND c.claimed_at < (NOW() - INTERVAL ? MINUTE))
      ORDER BY c.claimed_at ASC`,
    [minAgeMinutes],
  ).catch(() => [] as Row[])

  return rows.map((r) => ({
    saleUid: String(r.sale_uid),
    terminalId: r.terminal_id === null ? null : Number(r.terminal_id),
    status: String(r.status),
    documentNumber: (r.document_number as string | null) ?? null,
    operatorName: String(r.operator_name ?? ''),
    error: (r.error as string | null) ?? null,
    attempts: Number(r.attempts ?? 0),
    claimedAt: (r.claimed_at as Date | null) ?? null,
    hasDocument: Number(r.has_document ?? 0) === 1,
  }))
}

/** The three counts, for the nav badge and the page's stat strip. */
export async function offlineExceptionCounts(siteId: number): Promise<{
  exceptions: number
  quarantined: number
  stuck: number
  quarantinedValue: number
}> {
  const row = await siteQueryOne<RowDataPacket & Record<string, unknown>>(
    siteId,
    `SELECT
       SUM(offline_exception IS NOT NULL AND status = 'finalised')            AS exceptions,
       SUM(offline_sale_uid IS NOT NULL AND status IN ('draft','saved')
           AND offline_exception IS NOT NULL)                                 AS quarantined,
       SUM(CASE WHEN offline_sale_uid IS NOT NULL AND status IN ('draft','saved')
                     AND offline_exception IS NOT NULL
                THEN total_incl ELSE 0 END)                                   AS quarantined_value
       FROM sales_documents`,
  ).catch(() => null)

  const stuck = await siteQueryOne<RowDataPacket & { n: number }>(
    siteId,
    `SELECT COUNT(*) AS n FROM offline_sync_claims
      WHERE status = 'rejected'
         OR (status = 'claimed' AND claimed_at < (NOW() - INTERVAL 15 MINUTE))`,
  ).catch(() => null)

  return {
    exceptions: Number(row?.exceptions ?? 0),
    quarantined: Number(row?.quarantined ?? 0),
    stuck: Number(stuck?.n ?? 0),
    quarantinedValue: toNum(row?.quarantined_value),
  }
}
