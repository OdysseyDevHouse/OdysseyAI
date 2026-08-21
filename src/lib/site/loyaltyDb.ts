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
import { loyaltyOwnerSite } from '../storeGroups'

/**
 * Reading and writing the loyalty programme, wherever it lives.
 *
 * The third of these modules, after customerDb.ts for the debtors book and its
 * supplier twin. The shape is deliberately identical — a reader who knows one
 * knows all three — and so are the two traps, which are repeated here rather
 * than cross-referenced because forgetting them is silent.
 *
 * ── WHY LOYALTY NEEDED ITS OWN, RATHER THAN REUSING customerDb ───────────
 *
 * It used to use customerDb: every loyalty read and write went through
 * customerQuery / customerTransaction, and customerDb.ts named loyalty a member
 * of the "customer cluster". That made loyalty central only by RIDING ON the
 * customer file's owner, so the one shape available was "shared customers ⇒
 * shared loyalty".
 *
 * A franchise runs one card across stores that each invoice their own account
 * customers. That is the ordinary case and it could not be expressed. So
 * loyalty gets its own flag (tickets/017), its own resolver, and these
 * wrappers.
 *
 * ── WHEN NOT TO USE THESE ────────────────────────────────────────────────
 *
 * Only for statements touching the LOYALTY CLUSTER alone — loyalty_members,
 * loyalty_ledger, loyalty_wallet, loyalty_stamps, loyalty_vouchers,
 * loyalty_cards, loyalty_card_items, loyalty_tiers.
 *
 * A statement that ALSO names a branch table — sales_documents, tender_types,
 * shifts, terminals, products, customers — is a different problem. It needs the
 * owner's database NAME as a qualifier while staying on the caller's
 * connection. Reaching for a wrapper there moves the whole query to the owner
 * and silently returns the wrong rows or none, which is how the debtors work
 * produced most of its findings.
 *
 * ── AND WHY THE PREFIX IS A STRING TO INTERPOLATE ────────────────────────
 *
 * A database name cannot be a bound parameter — placeholders stand for values,
 * not identifiers — so the name is concatenated into the SQL, which is the
 * exact shape of an injection bug.
 *
 * Safe here for two reasons, and both must stay true: the name comes from
 * cp2_site_databases, written by provisioning and never by a user; and it is
 * validated below anyway, with a failure REFUSED rather than escaped. The
 * second is the one that cannot quietly stop being true.
 */

/** The site whose database holds this caller's loyalty programme. */
export async function loyaltySite(siteId: number): Promise<number> {
  return (await loyaltyOwnerSite(siteId)).siteId
}

export async function loyaltyQuery<T = RowDataPacket>(
  siteId: number,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  return siteQuery<T>(await loyaltySite(siteId), sql, params)
}

export async function loyaltyQueryOne<T = RowDataPacket>(
  siteId: number,
  sql: string,
  params: unknown[] = [],
): Promise<T | null> {
  return siteQueryOne<T>(await loyaltySite(siteId), sql, params)
}

export async function loyaltyExecute(siteId: number, sql: string, params: unknown[] = []) {
  return siteExecute(await loyaltySite(siteId), sql, params)
}

/**
 * A transaction against the loyalty programme.
 *
 * Still ONE connection, so this is a real transaction with real rollback.
 * Resolving the owner chooses which database it runs against; it does not split
 * it.
 *
 * ── THE SALE'S TRANSACTION IS NOT THIS ONE ───────────────────────────────
 *
 * This is the whole reason the loyalty rewrite happened, so it is worth stating
 * where somebody will read it. salesPosting used to do its loyalty spend inside
 * the SALE's transaction, on the branch's connection, and that only worked
 * while loyalty rows lived in the branch. Under a shared programme they do not,
 * and no transaction spans two databases.
 *
 * So a loyalty spend cannot roll a sale back by throwing inside it any more.
 * The affordability check happens BEFORE the sale opens and the spend is
 * written after it commits — see salesPosting. Anything in here that needs a
 * branch table (a tender type, a shift) must take the value it needs as a
 * parameter rather than joining to it.
 */
export async function loyaltyTransaction<T>(
  siteId: number,
  fn: (tx: PoolConnection) => Promise<T>,
): Promise<T> {
  return siteTransaction(await loyaltySite(siteId), fn)
}

/** A database name safe to concatenate into SQL: what provisioning generates. */
const SAFE_DB_NAME = /^[A-Za-z0-9_$]{1,64}$/

/**
 * The prefix to put in front of a loyalty table in a query that runs on the
 * CALLER's connection.
 *
 * Empty when the caller owns its own programme, which is every single-store
 * site — so the SQL is byte-for-byte what it always was and the plan does not
 * change.
 *
 * Throws on a name that is not a plain identifier. Deliberate: a report
 * returning nothing is a bug somebody hunts for hours, and a name odd enough to
 * fail this test means the control database is telling us something that should
 * not be papered over.
 */
export async function loyaltyDbPrefix(siteId: number): Promise<string> {
  const owner = await loyaltyOwnerSite(siteId)
  if (owner.siteId === siteId) return ''

  const db = await getSiteDatabase(owner.siteId, owner.purpose ?? MASTER)
  if (!db) {
    throw new Error(
      `The shared loyalty programme is on site ${owner.siteId}, which has no active database.`,
    )
  }
  if (!SAFE_DB_NAME.test(db.databaseName)) {
    throw new Error(`Refusing to build SQL with the database name "${db.databaseName}".`)
  }
  return `\`${db.databaseName}\`.`
}

/**
 * The mirror: names the CALLER's own database, for a statement that has moved
 * to the loyalty owner but must reach back to a branch table.
 *
 * Not interchangeable with the customer or supplier version, and the difference
 * is easy to miss — those are keyed on THEIR owners, so on a site sharing only
 * loyalty they return empty and a loyalty-owner query silently reads the
 * owner's copy of a branch table.
 *
 * Empty when the caller owns its own programme.
 */
export async function loyaltyBranchDbPrefix(siteId: number): Promise<string> {
  const owner = await loyaltyOwnerSite(siteId)
  if (owner.siteId === siteId) return ''

  const db = await getSiteDatabase(siteId, MASTER)
  if (!db) throw new Error(`Site ${siteId} has no active database.`)
  if (!SAFE_DB_NAME.test(db.databaseName)) {
    throw new Error(`Refusing to build SQL with the database name "${db.databaseName}".`)
  }
  return `\`${db.databaseName}\`.`
}
