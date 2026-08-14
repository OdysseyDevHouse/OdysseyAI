import 'server-only'
import { siteQuery } from '../siteDb'
import { getJobCard } from '../site/jobCards'
import { jobItems } from '../site/jobHeadlines'
import { getServiceAddress } from '../site/serviceAddresses'
import { jobAppointments } from '../site/jobAppointments'
import { getSetting } from '../site/settings'
import { jobSignoff } from '../site/jobSignoff'
import { round } from '../decimals'
import {
  APPOINTMENT_STATUS_LABEL,
  LINE_KIND_UNIT,
  type WorkPhase,
} from '../jobStatusModel'

/**
 * The job card as a document the customer can be handed.
 *
 * ── WHY A render/pdf SPLIT ─────────────────────────────────────────────────
 *
 * Copied from statements/render.ts + statements/pdf.ts. This module assembles
 * the data and decides what may appear; the pdf module only draws it. So a
 * screen preview and the printed sheet cannot disagree about a figure, and the
 * question "may a customer see this" is answered in exactly one place.
 *
 * ── WHAT IS DELIBERATELY WITHHELD ──────────────────────────────────────────
 *
 * The same list portalData.ts already enforces, and for the same reasons — a
 * second answer to "what may a customer see" is how the two drift:
 *
 *   cost, margin, unit_cost      what the business paid is not the customer's
 *   internal / written_off lines work absorbed is not work billed
 *   pending lines                nobody has decided who pays yet
 *   internal_note                staff writing about the customer
 *   staff names                  except whoever signed, which is the point
 *   other jobs                   this document is about one job
 *
 * A line's `costExcl` is on JobCardLine and is simply never read here. That is
 * the whole mechanism, and it is why the mapping below is explicit rather than
 * a spread: `{...line}` would publish the cost the day somebody adds a field.
 */

export type ReportLine = {
  description: string
  /**
   * The quantity WITH its unit — "29 km", "2 hours", "1".
   *
   * A bare 29 against "Callout to Parow" reads as twenty-nine callouts. The unit
   * comes from LINE_KIND_UNIT, which already knows travel is kilometres and
   * labour is hours, so this document cannot disagree with the job screen.
   */
  qty: string
  /** What the customer is charged, incl VAT. Never the cost. */
  priceIncl: number
  /** Blank for a charge with no product behind it. */
  productCode: string | null
}

export type ReportCheck = {
  name: string
  hint: string | null
  phase: WorkPhase
  /** 'Yes', '12.4 bar', 'Pass' — already formatted for a reader. */
  answer: string
  isFailed: boolean
  note: string | null
  completedByName: string | null
  /**
   * The stored file, for the pdf module to embed. Only ever a photo or a
   * signature; the render module resolves nothing from disk itself.
   */
  attachment: { storedName: string; mime: string | null } | null
}

export type ReportVisit = {
  startsAt: string | null
  durationMinutes: number
  status: string
}

export type JobReportData = {
  site: { name: string; vatNumber: string | null }
  job: {
    id: number
    documentNumber: string | null
    title: string
    /** The customer's own words. The only first-hand account of the fault. */
    description: string | null
    statusName: string
    isClosed: boolean
    reportedAt: string | null
    closedAt: string | null
    reference: string | null
  }
  customer: { name: string | null; code: string | null; phone: string | null }
  /** Where the work happened, if a site was named. */
  address: { name: string; lines: string[] } | null
  visits: ReportVisit[]
  checks: ReportCheck[]
  /** Billable only. See the header. */
  lines: ReportLine[]
  total: number
  /** What a signature above it means. Printed, or the mark proves nothing. */
  signatureStatement: string
  signOff: {
    customerName: string | null
    customerAt: string | null
    /** The drawn mark, for the pdf module to embed. Null if never signed. */
    customerSignature: { storedName: string; mime: string | null } | null
    technicianName: string | null
    technicianAt: string | null
    technicianSignature: { storedName: string; mime: string | null } | null
  }
}

/** A sign-off mark as the pdf module wants it, or null if there is no file. */
function signatureFile(
  mark: { storedName: string | null; mimeType: string | null } | null,
): { storedName: string; mime: string | null } | null {
  if (!mark || mark.storedName === null) return null
  return { storedName: mark.storedName, mime: mark.mimeType }
}

/** Which billing states a customer may be shown. */
const BILLABLE = new Set(['quoted', 'variation', 'additional'])

/**
 * A stored DATETIME as a person reads it — "12 Aug 2026, 18:00".
 *
 * The stored form is `2026-08-12 18:00:17` or an ISO string, and printing either
 * verbatim on a customer document is the sort of thing that makes software look
 * unfinished. Built by hand rather than with toLocaleString because the server's
 * locale is not the customer's and a report must not change wording by host.
 */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function humanStamp(value: string | null, withTime = true): string | null {
  if (!value) return null
  // Both stored shapes start `YYYY-MM-DD` and separate the time with ' ' or 'T'.
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ]?(\d{2})?:?(\d{2})?/.exec(value.trim())
  if (!match) return value
  const [, year, month, day, hour, minute] = match
  const monthName = MONTHS[Number(month) - 1] ?? month
  const date = `${Number(day)} ${monthName} ${year}`
  return withTime && hour && minute ? `${date}, ${hour}:${minute}` : date
}

/** How a stored checklist response reads to a person. */
function formatAnswer(
  responseType: string,
  response: string | null,
  unit: string | null,
): string {
  if (response === null || response.trim() === '') return 'Not recorded'
  const v = response.trim()
  switch (responseType) {
    case 'yesno':
      return v === 'yes' ? 'Yes' : v === 'no' ? 'No' : v
    case 'passfail':
      return v === 'pass' ? 'Pass' : v === 'fail' ? 'Fail' : v
    case 'measure':
      return unit ? `${v} ${unit}` : v
    case 'photo':
      return 'Photograph attached'
    case 'signature':
      return 'Signed'
    case 'none':
      return 'Done'
    default:
      return v
  }
}

/**
 * Everything the report shows, or null when the job does not exist.
 *
 * `siteName` and `siteVatNumber` are parameters rather than a lookup, matching
 * buildStatement: the caller already holds them from requireSiteUser, and a
 * pure-ish assembler is easier to test.
 */
export async function buildJobReport(
  siteId: number,
  siteName: string,
  siteVatNumber: string | null,
  jobId: number,
): Promise<JobReportData | null> {
  const job = await getJobCard(siteId, jobId)
  if (!job) return null

  const [items, address, visits, statement, signoff] = await Promise.all([
    jobItems(siteId, jobId).catch(() => []),
    job.serviceAddressId === null
      ? Promise.resolve(null)
      : getServiceAddress(siteId, job.serviceAddressId).catch(() => null),
    jobAppointments(siteId, jobId).catch(() => []),
    getSetting(siteId, 'job_signature_statement').catch(
      () => 'I confirm the work described on this job card has been completed to my satisfaction.',
    ),
    // 159. Tolerant of a site without it — two nulls, and the block simply
    // prints as unsigned rather than the report failing to render.
    jobSignoff(siteId, jobId).catch(() => ({ customer: null, technician: null })),
  ])

  /*
   * Billable lines only, and mapped field by field.
   *
   * A spread would carry unitCostExcl and costExcl onto a customer document the
   * moment somebody widened JobCardLine. Naming each field means widening the
   * type cannot leak anything.
   */
  const lines: ReportLine[] = job.lines
    .filter((l) => BILLABLE.has(l.billingState))
    .map((l) => {
      const unit = LINE_KIND_UNIT[l.lineKind]
      return {
        description: l.description,
        qty: unit ? `${l.qty} ${unit}` : String(l.qty),
        priceIncl: l.priceIncl,
        productCode: l.productCode,
      }
    })

  const total = round(
    lines.reduce((sum, l) => sum + l.priceIncl, 0),
    2,
  )

  /*
   * The STORED name for each attachment, which jobItems does not expose.
   *
   * `JobItem.attachmentName` is `party_documents.filename` — the display name,
   * for a screen. Passing it to readStoredFile silently finds nothing, which is
   * a bug this probe caught: every image fell back to "no longer on file" while
   * the PDF still rendered and looked fine.
   *
   * Fetched here rather than by widening JobItem: a stored name is a path
   * component, and the fewer places it travels the better.
   */
  const attachmentIds = items
    .map((i) => i.attachmentId)
    .filter((v): v is number => typeof v === 'number')

  const storedNames = new Map<number, { storedName: string; mime: string | null }>()
  if (attachmentIds.length > 0) {
    const rows = await siteQuery<{ id: number; stored_name: string; mime_type: string | null }>(
      siteId,
      `SELECT id, stored_name, mime_type FROM party_documents
        WHERE entity = 'job_card' AND entity_id = ?
          AND id IN (${attachmentIds.map(() => '?').join(',')})`,
      [jobId, ...attachmentIds],
    ).catch(() => [])
    for (const row of rows) {
      storedNames.set(Number(row.id), {
        storedName: String(row.stored_name),
        mime: row.mime_type === null ? null : String(row.mime_type),
      })
    }
  }

  const checks: ReportCheck[] = items
    // An unanswered check is not evidence of anything, so it is left off a
    // document that says what was done. The job screen still shows it.
    .filter((i) => i.completedAt !== null)
    .map((i) => ({
      name: i.name,
      hint: i.hint,
      phase: i.workPhase,
      answer: formatAnswer(i.responseType, i.response, i.unit),
      isFailed: i.isFailed,
      note: i.note,
      completedByName: i.completedByName,
      attachment: i.attachmentId === null ? null : storedNames.get(i.attachmentId) ?? null,
    }))

  return {
    site: { name: siteName, vatNumber: siteVatNumber },
    job: {
      id: job.id,
      documentNumber: job.documentNumber,
      title: job.title,
      description: job.description,
      statusName: job.statusName,
      isClosed: job.isClosed,
      reportedAt: humanStamp(job.reportedAt),
      closedAt: humanStamp(job.closedAt),
      reference: job.reference,
    },
    customer: {
      name: job.customerName,
      code: job.customerCode,
      phone: job.customerPhone,
    },
    address:
      address === null
        ? null
        : {
            name: address.name,
            lines: [
              address.addressLine1,
              address.addressLine2,
              address.city,
              address.postalCode,
            ]
              .map((v) => (v ?? '').trim())
              .filter(Boolean),
          },
    visits: visits.map((v) => ({
      startsAt: humanStamp(v.startsAt),
      durationMinutes: v.durationMinutes,
      status: APPOINTMENT_STATUS_LABEL[v.status] ?? v.status,
    })),
    checks,
    lines,
    total,
    signatureStatement: statement,
    /*
     * The two named marks (159).
     *
     * A staff name on a customer document is withheld everywhere else on this
     * report — see the header — and the technician signature is the deliberate
     * exception, because a signature nobody can be identified from is not worth
     * printing. That is the whole point of a countersignature.
     */
    signOff: {
      customerName: signoff.customer?.name ?? null,
      customerAt: humanStamp(signoff.customer?.at ?? null),
      customerSignature: signatureFile(signoff.customer),
      technicianName: signoff.technician?.name ?? null,
      technicianAt: humanStamp(signoff.technician?.at ?? null),
      technicianSignature: signatureFile(signoff.technician),
    },
  }
}
