import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteTransaction } from '../siteDb'
import { round, toNum } from '../decimals'
import { getSetting } from './settings'
import { logActivityTx, type Actor } from './activityLog'
import {
  breachesTolerance,
  chargeableKm,
  estimatedTripKm,
  type ExpectedSource,
  type RecordedSource,
} from '../jobStatusModel'

/**
 * Travel on a job: how far somebody went, and how much of it the customer pays.
 *
 * ── THE FOUR FIGURES ARE FOUR DIFFERENT FACTS ──────────────────────────────
 *
 * expected / recorded / verified / chargeable, and none derives another. The
 * migration header sets out why at length; the one worth repeating here is
 * `verified_km IS NULL`, which means NOBODY HAS LOOKED. Defaulting it to the
 * claim would make the approval worklist unbuildable — there would be nothing to
 * select the undecided trips on.
 *
 * ── EXPECTED IS AN ESTIMATE, AND SAYS SO ───────────────────────────────────
 *
 * Nothing here talks to a routing service. `expected_km` is haversine between two
 * stored coordinate pairs times a road factor, and `expected_source` records that
 * it was estimated. Good enough to catch a 60km claim on a 12km trip — which is
 * what it is for — and not good enough to argue over 2km, which is why the label
 * matters as much as the number.
 *
 * When a provider is wired in, it writes `expected_source = 'provider'` and
 * everything downstream is unchanged.
 *
 * ── AND IT NEVER BLOCKS ────────────────────────────────────────────────────
 *
 * A breached tolerance flags the trip for a signature. It does not refuse the
 * claim, because the commonest cause is a genuine detour and a technician who
 * cannot record what they drove stops recording anything.
 */

export type JobTravel = {
  id: number
  jobCardId: number
  appointmentId: number | null
  userId: number
  userName: string
  travelledOn: string
  fromLabel: string | null
  toLabel: string | null
  serviceAddressId: number | null
  expectedKm: number | null
  expectedSource: ExpectedSource | null
  recordedKm: number
  recordedSource: RecordedSource
  /** Whether the claim covered getting back. What the expectation was doubled by. */
  isReturn: boolean
  verifiedKm: number | null
  verifiedByName: string | null
  verifiedAt: string | null
  verifyNote: string | null
  chargeableKm: number
  ratePerKm: number
  costPerKm: number
  travelMinutes: number
  toleranceBreached: boolean
  note: string | null
  lineId: number | null
  /** chargeable × rate. What the customer is asked for. */
  chargeIncl: number
  /** chargeable × cost. What it cost the business. */
  costExcl: number
  /** Waiting for a signature: breached, and nobody has looked. */
  needsVerifying: boolean
}

export type TravelInput = {
  id: number | null
  jobCardId: number
  appointmentId: number | null
  userId: number
  userName: string
  travelledOn: string
  fromLabel: string | null
  toLabel: string | null
  serviceAddressId: number | null
  recordedKm: number
  recordedSource: RecordedSource
  /**
   * Whether the claim covers getting back as well.
   *
   * Doubles the EXPECTATION, not the claim. The first version assumed every trip
   * was a return and doubled it silently, which failed in the direction that
   * matters: somebody claiming a single leg got twice the tolerance headroom and
   * the check stopped catching anything. The person recording it knows which it
   * was, so they say.
   */
  isReturn: boolean
  travelMinutes: number
  note: string | null
  /** Only ever from the two button presses. See the migration header. */
  departedLat?: number | null
  departedLng?: number | null
  arrivedLat?: number | null
  arrivedLng?: number | null
  arrivedAccuracyM?: number | null
}

export type TravelSaveResult =
  | { ok: true; id: number; expectedKm: number | null; chargeableKm: number; breached: boolean }
  | { ok: false; error: string }

export type TravelActionResult = { ok: true } | { ok: false; error: string }

type Row = RowDataPacket & Record<string, unknown>

/** A DATETIME as a stable wall clock. See the header in jobAppointments.ts. */
function wallClock(value: unknown): string | null {
  if (!value) return null
  if (typeof value === 'string') return value.replace(' ', 'T').slice(0, 19)
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return null
  const p = (n: number) => String(n).padStart(2, '0')
  return (
    `${value.getUTCFullYear()}-${p(value.getUTCMonth() + 1)}-${p(value.getUTCDate())}` +
    `T${p(value.getUTCHours())}:${p(value.getUTCMinutes())}:${p(value.getUTCSeconds())}`
  )
}

/** A DATE column, which needs no time and must not gain one. */
function dateOnly(value: unknown): string {
  if (!value) return ''
  if (typeof value === 'string') return value.slice(0, 10)
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10)
  }
  return ''
}

function text(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const s = String(value).trim()
  return s === '' ? null : s
}

function optionalNum(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function mapTravel(row: Row): JobTravel {
  const chargeable = toNum(row.chargeable_km)
  const rate = toNum(row.rate_per_km)
  const cost = toNum(row.cost_per_km)
  const breached = Number(row.tolerance_breached) === 1
  const verifiedAt = wallClock(row.verified_at)

  return {
    id: Number(row.id),
    jobCardId: Number(row.job_card_id),
    appointmentId: row.appointment_id === null ? null : Number(row.appointment_id),
    userId: Number(row.user_id),
    userName: String(row.user_name ?? ''),
    travelledOn: dateOnly(row.travelled_on),
    fromLabel: text(row.from_label),
    toLabel: text(row.to_label),
    serviceAddressId: row.service_address_id === null ? null : Number(row.service_address_id),
    expectedKm: optionalNum(row.expected_km),
    expectedSource: row.expected_source === null ? null : (String(row.expected_source) as ExpectedSource),
    recordedKm: toNum(row.recorded_km),
    recordedSource: String(row.recorded_source) as RecordedSource,
    isReturn: Number(row.is_return) === 1,
    verifiedKm: optionalNum(row.verified_km),
    verifiedByName: text(row.verified_by_name),
    verifiedAt,
    verifyNote: text(row.verify_note),
    chargeableKm: chargeable,
    ratePerKm: rate,
    costPerKm: cost,
    travelMinutes: Number(row.travel_minutes ?? 0),
    toleranceBreached: breached,
    note: text(row.note),
    lineId: row.line_id === null ? null : Number(row.line_id),
    chargeIncl: round(chargeable * rate, 2),
    costExcl: round(chargeable * cost, 2),
    // Breached AND unlooked-at. A verified breach has been dealt with.
    needsVerifying: breached && verifiedAt === null,
  }
}

const SELECT_TRAVEL = `
  SELECT t.id, t.job_card_id, t.appointment_id, t.user_id, t.user_name, t.travelled_on,
         t.from_label, t.to_label, t.service_address_id,
         t.expected_km, t.expected_source, t.recorded_km, t.recorded_source, t.is_return,
         t.verified_km, t.verified_by_name, t.verified_at, t.verify_note,
         t.chargeable_km, t.rate_per_km, t.cost_per_km, t.travel_minutes,
         t.tolerance_breached, t.note, t.line_id
    FROM job_card_travel t`

export async function jobTravel(siteId: number, jobId: number): Promise<JobTravel[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `${SELECT_TRAVEL} WHERE t.job_card_id = ? ORDER BY t.travelled_on DESC, t.id DESC`,
    [jobId],
  )
  return rows.map(mapTravel)
}

export async function getTravel(siteId: number, id: number): Promise<JobTravel | null> {
  const row = await siteQueryOne<Row>(siteId, `${SELECT_TRAVEL} WHERE t.id = ?`, [id])
  return row ? mapTravel(row) : null
}

/**
 * Trips waiting for a signature.
 *
 * The one indexed read `ix_jtravel_verify` was built for. Not a state machine: a
 * trip either breached and nobody has looked, or it has not.
 */
export async function travelNeedingVerification(siteId: number, limit = 100): Promise<JobTravel[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `${SELECT_TRAVEL}
      WHERE t.tolerance_breached = 1 AND t.verified_at IS NULL
      ORDER BY t.travelled_on DESC, t.id DESC
      LIMIT ${Math.min(Math.max(limit, 1), 500)}`,
  )
  return rows.map(mapTravel)
}

/** The settings that decide what a trip is worth, read once. */
async function travelRules(siteId: number) {
  const [rate, cost, roundTo, minimum, tolerance, roadFactor] = await Promise.all([
    getSetting(siteId, 'job_travel_rate_per_km'),
    getSetting(siteId, 'job_travel_cost_per_km'),
    getSetting(siteId, 'job_travel_round_to'),
    getSetting(siteId, 'job_travel_minimum_km'),
    getSetting(siteId, 'job_travel_tolerance_pct'),
    getSetting(siteId, 'job_travel_road_factor'),
  ])
  return {
    ratePerKm: toNum(rate),
    costPerKm: toNum(cost),
    // 'none' or blank means charge exactly what was verified.
    roundTo: roundTo === 'none' ? 0 : toNum(roundTo),
    minimumKm: minimum === '' ? null : toNum(minimum),
    tolerancePct: toNum(tolerance),
    roadFactor: toNum(roadFactor, 1.3) || 1.3,
  }
}

/**
 * What this trip should have been, from the coordinates on file.
 *
 * The job's stock location is the from-end: a branch is where the van leaves in
 * the morning, and 107 added the coordinates to hold that. Null when either end
 * has no pin — no expectation is an honest answer, and inventing one would give
 * the tolerance check something false to measure against.
 */
async function expectedFor(
  siteId: number,
  jobId: number,
  serviceAddressId: number | null,
  roadFactor: number,
  isReturn: boolean,
): Promise<{ km: number | null; source: ExpectedSource | null }> {
  if (serviceAddressId === null) return { km: null, source: null }

  const ends = await siteQueryOne<Row>(
    siteId,
    `SELECT l.latitude AS from_lat, l.longitude AS from_lng,
            a.latitude AS to_lat,   a.longitude AS to_lng
       FROM job_cards j
       LEFT JOIN stock_locations l    ON l.id = j.location_id
       LEFT JOIN service_addresses a  ON a.id = ?
      WHERE j.id = ?`,
    [serviceAddressId, jobId],
  )
  if (!ends) return { km: null, source: null }

  const km = estimatedTripKm(
    { latitude: optionalNum(ends.from_lat), longitude: optionalNum(ends.from_lng) },
    { latitude: optionalNum(ends.to_lat), longitude: optionalNum(ends.to_lng) },
    roadFactor,
  )
  /*
   * ── THE LEG COUNT COMES FROM THE CLAIM, NOT AN ASSUMPTION ──────────────
   *
   * The first version always doubled this, reasoning that the technician has to
   * get back. That is a GUESS, and it fails in the direction that matters: it
   * silently doubles the tolerance headroom, so somebody claiming a single leg
   * gets twice the allowance and the check stops catching anything.
   *
   * So a return claim is measured against a return expectation and a one-way claim
   * against a one-way one. The person recording it knows which; the arithmetic
   * does not.
   */
  if (km === null) return { km: null, source: null }
  return { km: round(isReturn ? km * 2 : km, 2), source: 'estimated' }
}

/** Pure enough for the form: the shape checks, before any query. */
export function validateTravel(input: TravelInput): string | null {
  if (!input.travelledOn) return 'When was the trip?'
  if (input.recordedKm < 0) return 'A distance cannot be negative.'
  if (input.recordedKm > 5000) return 'That is further than any single trip — check the figure.'
  if (input.travelMinutes < 0) return 'Travel time cannot be negative.'
  if (input.travelMinutes > 24 * 60) return 'A single trip cannot run longer than a day.'
  if (input.recordedKm === 0 && input.travelMinutes === 0) {
    return 'Record either the distance or the time on the road.'
  }
  return null
}

/**
 * Record a trip, and put it on the job as a travel line.
 *
 * ── WHY A LINE, AND WHY `pending` ──────────────────────────────────────────
 *
 * Travel that is only a travel record never reaches a customer or a margin. So it
 * produces a `travel` line whose qty is the CHARGEABLE kilometres — the figure
 * that would be invoiced, not the claim.
 *
 * It lands in `pending` because who pays for a trip is a commercial decision and
 * the PRD requires a technician to be able to record work without making one. A
 * breached trip is doubly pending: it needs both a signature and a billing call.
 */
export async function saveTravel(
  siteId: number,
  actor: Actor,
  input: TravelInput,
): Promise<TravelSaveResult> {
  const refusal = validateTravel(input)
  if (refusal) return { ok: false, error: refusal }

  const job = await siteQueryOne<Row>(
    siteId,
    `SELECT id, status, document_number FROM job_cards WHERE id = ?`,
    [input.jobCardId],
  )
  if (!job) return { ok: false, error: 'That job no longer exists.' }
  if (String(job.status) === 'cancelled') {
    return { ok: false, error: 'A cancelled job takes no more travel.' }
  }

  const rules = await travelRules(siteId)
  const expected = await expectedFor(
    siteId,
    input.jobCardId,
    input.serviceAddressId,
    rules.roadFactor,
    input.isReturn,
  )

  const breached = breachesTolerance(input.recordedKm, expected.km, rules.tolerancePct)

  /*
   * Chargeable comes off the RECORDED figure at capture, and a later verification
   * may change it. That is the answer to "what do we bill before anybody has
   * checked": the claim, rounded — because most trips are unremarkable and holding
   * every one for a signature would stall the invoicing of ordinary work.
   */
  const chargeable = chargeableKm(input.recordedKm, rules.roundTo, rules.minimumKm)

  const id = await siteTransaction(siteId, async (tx) => {
    let travelId = input.id

    if (travelId === null) {
      const [res] = await tx.execute(
        `INSERT INTO job_card_travel
           (job_card_id, appointment_id, user_id, user_name, travelled_on,
            from_label, to_label, service_address_id,
            expected_km, expected_source, recorded_km, recorded_source, is_return,
            chargeable_km, rate_per_km, cost_per_km, travel_minutes,
            departed_lat, departed_lng, arrived_lat, arrived_lng, arrived_accuracy_m,
            tolerance_breached, note, user_created_id, user_created_name)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          input.jobCardId,
          input.appointmentId,
          input.userId,
          input.userName.slice(0, 120),
          input.travelledOn,
          text(input.fromLabel),
          text(input.toLabel),
          input.serviceAddressId,
          expected.km,
          expected.source,
          input.recordedKm.toFixed(2),
          input.recordedSource,
          input.isReturn ? 1 : 0,
          chargeable.toFixed(2),
          rules.ratePerKm.toFixed(4),
          rules.costPerKm.toFixed(4),
          input.travelMinutes,
          input.departedLat ?? null,
          input.departedLng ?? null,
          input.arrivedLat ?? null,
          input.arrivedLng ?? null,
          input.arrivedAccuracyM ?? null,
          breached ? 1 : 0,
          text(input.note),
          actor.userId,
          actor.userName.slice(0, 120),
        ] as never,
      )
      travelId = Number((res as { insertId: number }).insertId)
    } else {
      /*
       * Editing re-derives expected, chargeable and the flag, and CLEARS the
       * verification: a changed claim has not been checked, whatever was signed
       * off against the old figure. Leaving a stale signature on a new number is
       * how an approval trail stops meaning anything.
       */
      await tx.execute(
        `UPDATE job_card_travel
            SET appointment_id = ?, travelled_on = ?, from_label = ?, to_label = ?,
                service_address_id = ?, expected_km = ?, expected_source = ?,
                recorded_km = ?, recorded_source = ?, is_return = ?, chargeable_km = ?,
                travel_minutes = ?, tolerance_breached = ?, note = ?,
                verified_km = NULL, verified_by_user_id = NULL, verified_by_name = NULL,
                verified_at = NULL, verify_note = NULL
          WHERE id = ?`,
        [
          input.appointmentId,
          input.travelledOn,
          text(input.fromLabel),
          text(input.toLabel),
          input.serviceAddressId,
          expected.km,
          expected.source,
          input.recordedKm.toFixed(2),
          input.recordedSource,
          input.isReturn ? 1 : 0,
          chargeable.toFixed(2),
          input.travelMinutes,
          breached ? 1 : 0,
          text(input.note),
          travelId,
        ] as never,
      )
    }

    // The job line, created or moved in step with the trip.
    const [existing] = await tx.query<Row[]>(
      `SELECT line_id FROM job_card_travel WHERE id = ?`,
      [travelId],
    )
    const lineId = existing[0]?.line_id === null ? null : Number(existing[0]?.line_id)

    const description =
      `${input.userName} — ${chargeable.toFixed(chargeable % 1 === 0 ? 0 : 1)} km` +
      (input.toLabel ? ` to ${input.toLabel}` : '')

    if (lineId === null) {
      const [maxRow] = await tx.query<Row[]>(
        `SELECT COALESCE(MAX(line_number), 0) AS n FROM job_card_lines WHERE job_card_id = ?`,
        [input.jobCardId],
      )
      const [lineRes] = await tx.execute(
        `INSERT INTO job_card_lines
           (job_card_id, line_number, line_kind, billing_state, description, qty,
            unit_cost_excl, unit_price_incl, vat_rate_pct, discount_pct, travel_id, note)
         VALUES (?, ?, 'travel', 'pending', ?, ?, ?, ?, ?, 0, ?, ?)`,
        [
          input.jobCardId,
          Number(maxRow[0]?.n ?? 0) + 1,
          description,
          chargeable.toFixed(3),
          rules.costPerKm.toFixed(4),
          rules.ratePerKm.toFixed(4),
          await travelVatRate(siteId),
          travelId,
          text(input.note),
        ] as never,
      )
      await tx.execute(`UPDATE job_card_travel SET line_id = ? WHERE id = ?`, [
        Number((lineRes as { insertId: number }).insertId),
        travelId,
      ])
    } else {
      /*
       * An invoiced line is not touched. The customer has been charged for those
       * kilometres, and silently changing the quantity under a finalised invoice
       * would make the two disagree with nothing recording it.
       */
      await tx.execute(
        `UPDATE job_card_lines
            SET description = ?, qty = ?, unit_cost_excl = ?, unit_price_incl = ?, note = ?
          WHERE id = ? AND invoiced_qty = 0`,
        [
          description,
          chargeable.toFixed(3),
          rules.costPerKm.toFixed(4),
          rules.ratePerKm.toFixed(4),
          text(input.note),
          lineId,
        ] as never,
      )
    }

    await logActivityTx(tx, actor, {
      entity: 'job_card',
      entityId: input.jobCardId,
      action: input.id === null ? 'travel_recorded' : 'travel_changed',
      detail:
        `${input.userName} — ${input.recordedKm} km claimed, ${chargeable} km chargeable` +
        (expected.km === null
          ? ' (no expectation on file)'
          : ` against an estimated ${expected.km} km`) +
        (breached ? '. Outside the allowed tolerance — needs a signature.' : ''),
    })

    return travelId as number
  })

  return { ok: true, id, expectedKm: expected.km, chargeableKm: chargeable, breached }
}

/**
 * The VAT rate a travel line carries.
 *
 * The travel product's own selling rate, falling back to the default. Note
 * `vat_type = 'sales'`, not 'selling' — the products COLUMN is
 * `selling_vat_rate_id` but the ENUM value is 'sales', and the near-miss returns no
 * rows rather than an error. It silently put 0% VAT on a labour line once already.
 */
async function travelVatRate(siteId: number): Promise<number> {
  const travelProductId = await getSetting(siteId, 'job_travel_product_id')
  if (travelProductId) {
    const row = await siteQueryOne<Row>(
      siteId,
      `SELECT v.rate FROM products p JOIN vat_rates v ON v.id = p.selling_vat_rate_id
        WHERE p.id = ?`,
      [Number(travelProductId)],
    )
    if (row) return toNum(row.rate)
  }
  const fallback = await siteQueryOne<Row>(
    siteId,
    `SELECT rate FROM vat_rates WHERE vat_type = 'sales' AND is_default = 1 LIMIT 1`,
  )
  return toNum(fallback?.rate)
}

/**
 * Accept, or correct, what somebody claimed.
 *
 * ── VERIFYING A DIFFERENT FIGURE NEEDS A REASON ────────────────────────────
 *
 * Accepting the claim as it stands needs nothing — that is the ordinary case and
 * asking for a note on it would make the note meaningless. Reducing somebody
 * kilometres does need one: a manager quietly trimming a claim without a word is
 * exactly what ends up disputed, and the technician is entitled to see why.
 */
export async function verifyTravel(
  siteId: number,
  actor: Actor,
  travelId: number,
  verifiedKm: number,
  note?: string | null,
): Promise<TravelActionResult> {
  if (verifiedKm < 0) return { ok: false, error: 'A distance cannot be negative.' }

  const rules = await travelRules(siteId)

  return siteTransaction(siteId, async (tx) => {
    const [rows] = await tx.query<Row[]>(
      `SELECT t.id, t.job_card_id, t.user_name, t.recorded_km, t.line_id,
              l.invoiced_qty
         FROM job_card_travel t
         LEFT JOIN job_card_lines l ON l.id = t.line_id
        WHERE t.id = ?`,
      [travelId],
    )
    const trip = rows[0]
    if (!trip) return { ok: false as const, error: 'That trip no longer exists.' }

    const recorded = toNum(trip.recorded_km)
    const changed = round(verifiedKm, 2) !== round(recorded, 2)

    if (changed && !note?.trim()) {
      return {
        ok: false as const,
        error: `You are changing the claim from ${recorded} km to ${verifiedKm} km. Say why — the technician is entitled to see the reason.`,
      }
    }

    if (toNum(trip.invoiced_qty) > 0) {
      return {
        ok: false as const,
        error: 'Those kilometres have been invoiced. Credit the invoice to change what was charged.',
      }
    }

    const chargeable = chargeableKm(verifiedKm, rules.roundTo, rules.minimumKm)

    await tx.execute(
      `UPDATE job_card_travel
          SET verified_km = ?, verified_by_user_id = ?, verified_by_name = ?,
              verified_at = NOW(), verify_note = ?, chargeable_km = ?
        WHERE id = ?`,
      [
        verifiedKm.toFixed(2),
        actor.userId,
        actor.userName.slice(0, 120),
        text(note ?? null),
        chargeable.toFixed(2),
        travelId,
      ] as never,
    )

    if (trip.line_id !== null) {
      await tx.execute(`UPDATE job_card_lines SET qty = ? WHERE id = ? AND invoiced_qty = 0`, [
        chargeable.toFixed(3),
        Number(trip.line_id),
      ] as never)
    }

    await logActivityTx(tx, actor, {
      entity: 'job_card',
      entityId: Number(trip.job_card_id),
      action: 'travel_verified',
      detail: changed
        ? `${String(trip.user_name ?? '')} claimed ${recorded} km, accepted at ${verifiedKm} km — ${note?.trim()}`
        : `${String(trip.user_name ?? '')} — ${recorded} km accepted as claimed`,
    })

    return { ok: true as const }
  })
}

/**
 * Remove a trip and the line it produced.
 *
 * Both together: a trip without its line understates the job cost, and a line
 * without its trip is a charge with no evidence. Refused once invoiced.
 */
export async function deleteTravel(
  siteId: number,
  actor: Actor,
  jobId: number,
  travelId: number,
): Promise<TravelActionResult> {
  return siteTransaction(siteId, async (tx) => {
    const [rows] = await tx.query<Row[]>(
      `SELECT t.id, t.job_card_id, t.user_name, t.recorded_km, t.line_id, l.invoiced_qty
         FROM job_card_travel t
         LEFT JOIN job_card_lines l ON l.id = t.line_id
        WHERE t.id = ?`,
      [travelId],
    )
    const trip = rows[0]
    if (!trip) return { ok: false as const, error: 'That trip no longer exists.' }
    if (Number(trip.job_card_id) !== jobId) {
      return { ok: false as const, error: 'That trip belongs to a different job.' }
    }
    if (toNum(trip.invoiced_qty) > 0) {
      return {
        ok: false as const,
        error: 'Those kilometres have been invoiced. Credit the invoice rather than deleting the record.',
      }
    }

    // The trip first: fk_jtravel_line is SET NULL, so deleting the line while the
    // trip still points at it would silently blank the link instead of failing.
    await tx.execute(`DELETE FROM job_card_travel WHERE id = ?`, [travelId])
    if (trip.line_id !== null) {
      await tx.execute(`DELETE FROM job_card_lines WHERE id = ?`, [Number(trip.line_id)])
    }

    await logActivityTx(tx, actor, {
      entity: 'job_card',
      entityId: jobId,
      action: 'travel_removed',
      detail: `${String(trip.user_name ?? '')} — ${toNum(trip.recorded_km)} km removed`,
    })

    return { ok: true as const }
  })
}

export type TravelDrift = {
  /** Breached and nobody has looked. Money going out on an unchecked claim. */
  unverified: { travelId: number; jobId: number; userName: string; recordedKm: number; expectedKm: number | null }[]
  /** Trips with no line — kilometres the job cost that nobody billed. */
  uncosted: { travelId: number; jobId: number; userName: string; chargeableKm: number }[]
  /** Lines whose trip has gone. A charge with no evidence. */
  orphanedLines: { lineId: number; jobId: number; description: string }[]
}

/** Drift between the road and the costing. Reports, never repairs. */
export async function reconcileJobTravel(siteId: number): Promise<TravelDrift> {
  const [unverified, uncosted, orphaned] = await Promise.all([
    siteQuery<Row>(
      siteId,
      `SELECT id, job_card_id, user_name, recorded_km, expected_km
         FROM job_card_travel
        WHERE tolerance_breached = 1 AND verified_at IS NULL`,
    ),
    siteQuery<Row>(
      siteId,
      `SELECT id, job_card_id, user_name, chargeable_km
         FROM job_card_travel WHERE line_id IS NULL`,
    ),
    siteQuery<Row>(
      siteId,
      `SELECT l.id, l.job_card_id, l.description
         FROM job_card_lines l
        WHERE l.travel_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM job_card_travel t WHERE t.id = l.travel_id)`,
    ),
  ])

  return {
    unverified: unverified.map((r) => ({
      travelId: Number(r.id),
      jobId: Number(r.job_card_id),
      userName: String(r.user_name ?? ''),
      recordedKm: toNum(r.recorded_km),
      expectedKm: optionalNum(r.expected_km),
    })),
    uncosted: uncosted.map((r) => ({
      travelId: Number(r.id),
      jobId: Number(r.job_card_id),
      userName: String(r.user_name ?? ''),
      chargeableKm: toNum(r.chargeable_km),
    })),
    orphanedLines: orphaned.map((r) => ({
      lineId: Number(r.id),
      jobId: Number(r.job_card_id),
      description: String(r.description),
    })),
  }
}
