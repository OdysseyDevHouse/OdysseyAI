import 'server-only'
import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute, siteTransaction } from '../siteDb'
import {
  customerQuery,
  customerQueryOne,
  customerExecute,
  customerTransaction,
  supplierQuery,
  supplierQueryOne,
  supplierExecute,
  supplierTransaction,
} from './customerDb'
import type { CommentEntity } from './partyComments'

/**
 * Which table an entity's documents and comments live in, and which database.
 *
 * ── WHY ONE TABLE BECAME THREE ────────────────────────────────────────────
 *
 * party_documents and party_comments were keyed by a loose (entity, entity_id)
 * pair serving customers, suppliers, job cards and tickets — one table, four
 * owners. That survived while only customers were shared: both tables moved to
 * the customer owner and the supplier half went along wrongly but invisibly.
 *
 * Sharing suppliers breaks it. A supplier moves to the SUPPLIER owner and a
 * customer to the CUSTOMER owner, and the flags are deliberately separate (015)
 * so those may be different databases. One table cannot follow both. 207 splits
 * them; this module is the single place that decides which is which.
 *
 * ── THE ROUTING ──────────────────────────────────────────────────────────
 *
 *   customer  → customer_documents / customer_comments, on the customer owner
 *   supplier  → supplier_documents / supplier_comments, on the supplier owner
 *   job_card  → job_documents / job_comments, in the branch
 *   ticket    → the same job tables, also in the branch
 *
 * Jobs and tickets share a pair because both are branch-local work records and
 * neither will ever move; the entity column still tells them apart.
 *
 * ── THE FILES THEMSELVES NEED NO ROUTING ─────────────────────────────────
 *
 * UPLOADS_ROOT in lib/uploads.ts is resolved once per PROCESS and takes no
 * siteId — one directory serves every site the server hosts. Sharing already
 * requires every member to be on the same MariaDB instance as the primary
 * (015), so branch and owner are the same machine and therefore the same
 * uploads directory. Only the metadata moves. See 207 for the case where that
 * would stop being true.
 */

/** The tables an entity's rows live in. */
export function partyTables(entity: CommentEntity): { documents: string; comments: string } {
  switch (entity) {
    case 'customer':
      return { documents: 'customer_documents', comments: 'customer_comments' }
    case 'supplier':
      return { documents: 'supplier_documents', comments: 'supplier_comments' }
    default:
      // job_card and ticket. A `default` rather than two cases on purpose: a
      // future branch-local entity should land here without a code change,
      // because "stays in the branch" is the safe answer for anything new.
      return { documents: 'job_documents', comments: 'job_comments' }
  }
}

/**
 * The query helpers for an entity's database.
 *
 * Returned as a set rather than resolved per call so a function that reads and
 * then writes cannot accidentally use two different databases — the mistake
 * that produced most of the shared-customer findings.
 */
export function partyDb(entity: CommentEntity): {
  query: <T = RowDataPacket>(siteId: number, sql: string, params?: unknown[]) => Promise<T[]>
  queryOne: <T = RowDataPacket>(
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
} {
  switch (entity) {
    case 'customer':
      return {
        query: customerQuery,
        queryOne: customerQueryOne,
        execute: customerExecute,
        transaction: customerTransaction,
      }
    case 'supplier':
      return {
        query: supplierQuery,
        queryOne: supplierQueryOne,
        execute: supplierExecute,
        transaction: supplierTransaction,
      }
    default:
      // Branch-local: the plain site helpers, which is what every entity used
      // before this existed.
      return {
        query: siteQuery,
        queryOne: siteQueryOne,
        execute: siteExecute,
        transaction: siteTransaction,
      }
  }
}

/*
 * ── NO "SEARCH EVERY TABLE" HELPER, ON PURPOSE ───────────────────────────
 *
 * The obvious gap after a split like this is the download route, which has a
 * document id and might have had to look in all three tables. It does not: the
 * route already takes `party` and `partyId` from the query string, because the
 * lookup was (id, entity, entity_id) long before this — a document id is a
 * guessable integer and matching on it alone would let anyone walk the range
 * and read another account's paperwork.
 *
 * So every caller already knows its entity, and a helper that searched blindly
 * would only be useful to a caller that had lost that check.
 */
