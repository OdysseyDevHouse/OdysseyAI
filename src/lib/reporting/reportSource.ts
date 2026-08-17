import 'server-only'
import { cache } from 'react'
import type { RowDataPacket } from 'mysql2'
import { siteQuery } from '@/lib/siteDb'
import { getReplica, replicaQuery, isStale, type ReportingReplica } from './replicaDb'

/**
 * Which copy of a site's data a report should read.
 *
 * ── THE PROBLEM THIS SOLVES ONCE ────────────────────────────────────────────
 *
 * A cloud site has one database and reports read it. A local-backend site keeps
 * its data on the shop's machine, which head office cannot reach — so reports
 * read the cloud replica instead.
 *
 * That decision could be made at each of the six places that run a report. It
 * is made here instead, once, because six copies would be six chances to
 * disagree and the failure would be silent: a report that quietly read the
 * wrong copy still returns rows.
 *
 * ── AND WHY IT IS NOT AUTOMATIC INSIDE siteQuery ────────────────────────────
 *
 * Because only READS may be redirected. siteQuery is also how the till posts a
 * sale, and a write that silently landed on a read-only replica would either
 * fail confusingly or, worse, appear to succeed. So the redirect lives in the
 * reporting layer, where everything is a SELECT by construction.
 */

export type ReportSource = {
  /** Hand to RunOptions.reader. */
  reader: (siteId: number, sql: string, params: unknown[]) => Promise<RowDataPacket[]>
  /** True when this read the cloud replica rather than the shop's own database. */
  fromReplica: boolean
  /**
   * Set when the figures are not current — a replica that has fallen behind or
   * stopped. The screen SAYS SO rather than refusing: "as at 09:14, catching
   * up" is useful, a silently stale number is not, and a refusal leaves a
   * head office with nothing at all when a shop's line is poor.
   */
  staleness: { secondsBehind: number | null; lastContactAt: Date | null } | null
}

/** The ordinary case: read the site's own database. */
function direct(): ReportSource {
  return {
    reader: (siteId, sql, params) => siteQuery<RowDataPacket>(siteId, sql, params),
    fromReplica: false,
    staleness: null,
  }
}

/**
 * Where reports for this site should read from.
 *
 * Memoised per request: a page that renders a report and its header both ask,
 * and a second lookup would be a second control-database round trip for an
 * answer that cannot change mid-render.
 *
 * Falls back to the site's own database whenever there is no usable replica.
 * That is right for both reasons it happens: a cloud site has no replica and
 * never will, and a local site whose replica is missing should try the shop's
 * own machine — which succeeds if the report is being run ON that machine, and
 * fails with a plain connection error if it is not.
 */
export const reportSourceFor = cache(async (siteId: number): Promise<ReportSource> => {
  let replica: ReportingReplica | null
  try {
    replica = await getReplica(siteId)
  } catch {
    return direct()
  }
  if (!replica) return direct()

  /* Credentials that will not decrypt mean the replica cannot be read at all.
     Falling back is better than throwing: on the shop's own machine the direct
     read works, and off it the error names the real problem. */
  if (!replica.credentialsUsable) return direct()

  return {
    reader: (id, sql, params) => replicaQuery<RowDataPacket>(id, sql, params),
    fromReplica: true,
    /* Only when it MATTERS. A replica two seconds behind is current for every
       purpose a report has, and labelling it would train people to ignore the
       label — which is exactly what must not happen the day it says four
       hours. */
    staleness: isStale(replica)
      ? { secondsBehind: replica.secondsBehind, lastContactAt: replica.lastContactAt }
      : null,
  }
})

/**
 * A sentence for the report header, or null when the figures are current.
 *
 * Written for the person reading the report rather than for an operator: they
 * need to know whether to trust the number in front of them, not the state of a
 * replication link.
 */
export function stalenessNote(source: ReportSource): string | null {
  if (!source.staleness) return null

  const { secondsBehind, lastContactAt } = source.staleness

  if (secondsBehind === null) {
    return lastContactAt
      ? `This shop's data has not reached us since ${lastContactAt.toISOString().slice(0, 16).replace('T', ' ')}. Figures may be incomplete.`
      : 'This shop has not sent its data yet. Figures may be incomplete.'
  }

  const minutes = Math.round(secondsBehind / 60)
  if (minutes < 60) return `Figures are about ${minutes} minute${minutes === 1 ? '' : 's'} behind the shop.`

  const hours = Math.round(minutes / 60)
  if (hours < 48) return `Figures are about ${hours} hour${hours === 1 ? '' : 's'} behind the shop.`

  return `Figures are about ${Math.round(hours / 24)} days behind the shop.`
}
