import 'server-only'
import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import {
  siteQuery,
  siteQueryOne,
  siteExecute,
  siteTransaction,
  getSiteDatabase,
  MASTER,
} from '../siteDb'
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

/* ── Joining the customer file from a branch query ────────────────────────
 *
 * The wrappers above move a whole statement to the owner's database. That is
 * right when every table in it belongs to the customer cluster, and WRONG the
 * moment one does not: a query joining laybys to customers, run against the
 * owner, would read the owner's laybys and silently return another store's
 * rows — or none.
 *
 * Those queries stay on the CALLER's connection and name the owner's database
 * in the join instead:
 *
 *     FROM laybys l JOIN `ody10000_master`.customers c ON c.id = l.customer_id
 *
 * MariaDB resolves that in one pass, on one instance, including WHERE and
 * ORDER BY against the remote table — measured in
 * scripts/probe-shared-customer-file.ts before any of this was built. So no
 * query has to be split into two and stitched together in code, which is what
 * this stage was originally scoped to do.
 *
 * ── WHY THIS RETURNS A STRING TO INTERPOLATE ─────────────────────────────
 *
 * A database name cannot be a bound parameter — placeholders stand for values,
 * not identifiers, so `FROM ?.customers` is a syntax error rather than a
 * substitution. The name therefore has to be concatenated into the SQL, which
 * is exactly the shape of an injection bug.
 *
 * It is safe here for two reasons, and both must stay true:
 *
 *   1. The name comes from cp2_site_databases in the control database, written
 *      by provisioning. It is never user input.
 *   2. It is validated below anyway, and a name that fails is REFUSED rather
 *      than escaped. Defence in depth: (1) is a fact about today's code and
 *      could quietly stop being true, whereas (2) cannot.
 */

/** A database name safe to concatenate into SQL: what provisioning generates. */
const SAFE_DB_NAME = /^[A-Za-z0-9_$]{1,64}$/

/**
 * The prefix to put in front of a customer-cluster table in a query that runs
 * on the CALLER's connection.
 *
 * Empty string when the caller owns its own customers, which is every
 * single-store site — so the SQL is byte-for-byte what it always was and the
 * query plan does not change.
 *
 * Throws on a database name that is not a plain identifier. That is deliberate:
 * a report returning nothing is a bug someone hunts for hours, and a name odd
 * enough to fail this test means the control database is telling us something
 * we should not paper over.
 */
export async function customerDbPrefix(siteId: number): Promise<string> {
  const owner = await customerOwnerSite(siteId)
  if (owner.siteId === siteId) return ''

  const db = await getSiteDatabase(owner.siteId, owner.purpose ?? MASTER)
  if (!db) {
    throw new Error(
      `The shared customer file is on site ${owner.siteId}, which has no active database.`,
    )
  }
  if (!SAFE_DB_NAME.test(db.databaseName)) {
    throw new Error(`Refusing to build SQL with the database name "${db.databaseName}".`)
  }
  return `\`${db.databaseName}\`.`
}

/** The same, for the creditors book. */
export async function supplierDbPrefix(siteId: number): Promise<string> {
  const owner = await supplierOwnerSite(siteId)
  if (owner.siteId === siteId) return ''

  const db = await getSiteDatabase(owner.siteId, owner.purpose ?? MASTER)
  if (!db) {
    throw new Error(
      `The shared supplier file is on site ${owner.siteId}, which has no active database.`,
    )
  }
  if (!SAFE_DB_NAME.test(db.databaseName)) {
    throw new Error(`Refusing to build SQL with the database name "${db.databaseName}".`)
  }
  return `\`${db.databaseName}\`.`
}
