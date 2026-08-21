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
import type { OwnerDb } from '../storeGroups'

/**
 * The mechanics every shared master file needs, written once.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────
 *
 * There are four of these now — customers, suppliers, loyalty, gift cards —
 * and each was a copy of the last. The copies were faithful, which is exactly
 * the problem: SAFE_DB_NAME was defined three times, and the day one of them
 * gains a case the others do not is the day two shared files disagree about
 * what a legal database name is.
 *
 * So the resolver stays per-file (they answer genuinely different questions)
 * and everything downstream of it is built here from that resolver.
 *
 * ── WHAT A CALLER STILL HAS TO GET RIGHT ─────────────────────────────────
 *
 * The distinction between a WRAPPER and a PREFIX, which no amount of factoring
 * removes because it is a property of the statement rather than the file:
 *
 *   · A statement touching ONE cluster's tables uses the wrappers. They move
 *     the whole query to whichever database owns that file.
 *
 *   · A statement that ALSO names a branch table — sales_documents,
 *     tender_types, shifts, terminals, products — is MIXED. It stays on the
 *     caller's connection and qualifies the far tables with the prefix.
 *     Reaching for a wrapper there moves the whole query to the owner and
 *     silently returns the wrong rows or none. That mistake produced most of
 *     the findings in the debtors work and several in loyalty.
 *
 * And the mirror prefix is per-file for a reason worth repeating: `branchDb`
 * keyed on the CUSTOMER owner returns empty on a site that shares only
 * loyalty, so a loyalty-owner query using it would silently read the owner's
 * copy of a branch table. Each file's mirror is keyed on its own resolver.
 */

/** A database name safe to concatenate into SQL: what provisioning generates. */
const SAFE_DB_NAME = /^[A-Za-z0-9_$]{1,64}$/

export type SharedFileDb = {
  query: <T extends RowDataPacket>(siteId: number, sql: string, params?: unknown[]) => Promise<T[]>
  queryOne: <T extends RowDataPacket>(
    siteId: number,
    sql: string,
    params?: unknown[],
  ) => Promise<T | null>
  execute: (
    siteId: number,
    sql: string,
    params?: unknown[],
  ) => ReturnType<typeof siteExecute>
  transaction: <T>(siteId: number, fn: (tx: PoolConnection) => Promise<T>) => Promise<T>
  /** Names the OWNER's database, for a mixed query on the caller's connection. */
  dbPrefix: (siteId: number) => Promise<string>
  /** Names the CALLER's own database, for a query that has moved to the owner. */
  branchDbPrefix: (siteId: number) => Promise<string>
}

/**
 * Builds the five helpers for one shared file from its owner resolver.
 *
 * @param label What this file is called in an error a person will read.
 * @param ownerOf The file's resolver — customerOwnerSite, loyaltyOwnerSite, …
 */
export function sharedFileDb(
  label: string,
  ownerOf: (siteId: number) => Promise<OwnerDb>,
): SharedFileDb {
  /** Which site's database this statement should run against. */
  const site = async (siteId: number): Promise<number> => (await ownerOf(siteId)).siteId

  /**
   * Throws on a name that is not a plain identifier.
   *
   * Deliberate rather than defensive: a report returning nothing is a bug
   * somebody hunts for hours, and a name odd enough to fail this test means the
   * control database is telling us something that should not be papered over.
   */
  const nameOf = async (siteId: number, purpose = MASTER): Promise<string> => {
    const db = await getSiteDatabase(siteId, purpose)
    if (!db) throw new Error(`Site ${siteId} has no active database, so ${label} cannot be read.`)
    if (!SAFE_DB_NAME.test(db.databaseName)) {
      throw new Error(`Refusing to build SQL with the database name "${db.databaseName}".`)
    }
    return `\`${db.databaseName}\`.`
  }

  return {
    async query(siteId, sql, params = []) {
      return siteQuery(await site(siteId), sql, params)
    },
    async queryOne(siteId, sql, params = []) {
      return siteQueryOne(await site(siteId), sql, params)
    },
    async execute(siteId, sql, params = []) {
      return siteExecute(await site(siteId), sql, params)
    },
    async transaction(siteId, fn) {
      // Still ONE connection, so this is a real transaction with real rollback.
      // Resolving the owner chooses which database it runs against; it does not
      // split it — nothing here can make a transaction span two.
      return siteTransaction(await site(siteId), fn)
    },
    async dbPrefix(siteId) {
      const owner = await ownerOf(siteId)
      // Empty when the caller owns its own file, which is every single-store
      // site — so the SQL is byte-for-byte what it always was and the query
      // plan does not change.
      if (owner.siteId === siteId) return ''
      return nameOf(owner.siteId, owner.purpose ?? MASTER)
    },
    async branchDbPrefix(siteId) {
      const owner = await ownerOf(siteId)
      if (owner.siteId === siteId) return ''
      return nameOf(siteId, MASTER)
    },
  }
}
