import 'server-only'
import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute, siteTransaction } from '../siteDb'
import { customerOwnerSite, supplierOwnerSite } from '../storeGroups'

/**
 * Reading and writing the customer file, wherever it lives.
 *
 * A store group may share one customer file, in which case every branch reads
 * and writes the group primary's database rather than its own — see
 * customerOwnerSite() in lib/storeGroups.ts. With no sharing configured the
 * owner IS the caller, so every function here is an identity wrapper and the
 * modules using them behave exactly as they always have.
 *
 * ── WHY A MODULE RATHER THAN A HELPER PER FILE ────────────────────────────
 *
 * Roughly a dozen modules read the debtors book — statements, interest,
 * write-offs, credit control, the till lookup. Each could define its own three
 * wrappers, and the first two did before this existed. That is a dozen chances
 * to forget the resolution in one function of one file, and the failure is
 * silent: the query succeeds against the wrong database and returns an empty
 * list rather than an error.
 *
 * ── WHEN NOT TO USE THESE ─────────────────────────────────────────────────
 *
 * Only for statements that touch the CUSTOMER CLUSTER alone — customers,
 * customer_transactions, customer_allocations, customer_groups, statements,
 * credit control, loyalty. A statement that also joins a branch-owned table
 * (sales_documents, laybys, job_cards, bank_transactions) is a different
 * problem: it needs the owner's database NAME as a qualifier rather than a
 * different connection, which is stage 4. Reaching for these there would move
 * the whole query to the owner and silently lose the branch's rows.
 *
 * sales_reps is safe to join from either side because it is replicated into
 * every store rather than moved.
 */

/** The site whose database holds this caller's customers. */
export async function customerSite(siteId: number): Promise<number> {
  return (await customerOwnerSite(siteId)).siteId
}

/** The site whose database holds this caller's suppliers. */
export async function supplierSite(siteId: number): Promise<number> {
  return (await supplierOwnerSite(siteId)).siteId
}

export async function customerQuery<T = RowDataPacket>(
  siteId: number,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  return siteQuery<T>(await customerSite(siteId), sql, params)
}

export async function customerQueryOne<T = RowDataPacket>(
  siteId: number,
  sql: string,
  params: unknown[] = [],
): Promise<T | null> {
  return siteQueryOne<T>(await customerSite(siteId), sql, params)
}

export async function customerExecute(siteId: number, sql: string, params: unknown[] = []) {
  return siteExecute(await customerSite(siteId), sql, params)
}

/**
 * A transaction against the customer file.
 *
 * Still ONE connection, so this is a real transaction with real rollback.
 * Resolving the owner chooses which database it runs against; it does not
 * split it. Anything inside that has to write a BRANCH table — an audit line,
 * a stock movement — must be lifted out and done after the commit, because no
 * transaction can span two databases.
 */
export async function customerTransaction<T>(
  siteId: number,
  fn: (tx: PoolConnection) => Promise<T>,
): Promise<T> {
  return siteTransaction(await customerSite(siteId), fn)
}

export async function supplierQuery<T = RowDataPacket>(
  siteId: number,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  return siteQuery<T>(await supplierSite(siteId), sql, params)
}

export async function supplierQueryOne<T = RowDataPacket>(
  siteId: number,
  sql: string,
  params: unknown[] = [],
): Promise<T | null> {
  return siteQueryOne<T>(await supplierSite(siteId), sql, params)
}

export async function supplierTransaction<T>(
  siteId: number,
  fn: (tx: PoolConnection) => Promise<T>,
): Promise<T> {
  return siteTransaction(await supplierSite(siteId), fn)
}
