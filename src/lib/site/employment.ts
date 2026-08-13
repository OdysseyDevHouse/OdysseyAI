import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute } from '../siteDb'
import { toNum } from '../decimals'
import { today as localToday } from './ledger'
import {
  BCEA_ORDINARY_HOURS_PW,
  validateEmployment,
  type Employment,
  type EmploymentInput,
  type EmploymentType,
  type PayBasis,
} from '../employmentModel'

export {
  BCEA_ORDINARY_HOURS_PW,
  EMPLOYMENT_TYPES,
  PAY_BASES,
  EMPLOYMENT_TYPE_LABELS,
  hourlyCostOf,
} from '../employmentModel'
export type { Employment, EmploymentInput, EmploymentType, PayBasis } from '../employmentModel'

/**
 * What a person is employed as, and what they are paid.
 *
 * ── PAY RATES DO NOT LEAVE THIS MODULE BY ACCIDENT ──────────────────────
 *
 * `listEmployment` and `getEmployment` take a `withCost` flag, and when it is
 * false the rate fields come back as null rather than as numbers a screen
 * might forget to hide. That is deliberate: hiding a figure in JSX still ships
 * it in the RSC payload, one browser devtools tab away from anybody.
 *
 * The flag is set from `staff.cost` by the caller. Making it a required
 * argument rather than an option means a new call site has to decide, rather
 * than inheriting a permissive default.
 */

type Row = RowDataPacket & {
  user_id: number
  user_name: string
  employee_number: string | null
  employment_type: EmploymentType
  pay_basis: PayBasis
  hourly_rate: string | number
  monthly_salary: string | number
  ordinary_hours_pw: string | number
  works_sundays: number | undefined
  hired_on: string | null
  terminated_on: string | null
  leave_cycle_start: string | null
  notes: string | null
}

function mapRow(r: Row, withCost: boolean): Employment {
  // Local date — toISOString() is UTC and reads "yesterday" after local midnight.
  const today = localToday()
  return {
    userId: r.user_id,
    userName: r.user_name,
    employeeNumber: r.employee_number,
    employmentType: r.employment_type,
    payBasis: r.pay_basis,
    hourlyRate: withCost ? toNum(r.hourly_rate) : null,
    monthlySalary: withCost ? toNum(r.monthly_salary) : null,
    ordinaryHoursPw: toNum(r.ordinary_hours_pw, BCEA_ORDINARY_HOURS_PW),
    // A site that has not run 062 has no column, so the row has no key —
    // false is then correct, being what every such site costs at today.
    worksSundays: r.works_sundays === 1,
    hiredOn: r.hired_on,
    terminatedOn: r.terminated_on,
    leaveCycleStart: r.leave_cycle_start,
    notes: r.notes,
    isCurrent: !r.terminated_on || r.terminated_on > today,
  }
}

const SELECT = `
  SELECT e.user_id, u.name AS user_name, e.employee_number, e.employment_type,
         e.pay_basis, e.hourly_rate, e.monthly_salary, e.ordinary_hours_pw,
         e.works_sundays,
         e.hired_on, e.terminated_on, e.leave_cycle_start, e.notes
    FROM user_employment e
    INNER JOIN users u ON u.id = e.user_id
`

/**
 * Everyone with employment terms on file.
 *
 * Not everyone in `users` — a user is anybody who can sign in, which includes
 * the owner's accountant and whoever set the site up. Employment is a separate
 * question, so a row here is what makes somebody staff.
 */
export async function listEmployment(siteId: number, withCost: boolean): Promise<Employment[]> {
  const rows = await siteQuery<Row>(siteId, `${SELECT} ORDER BY u.name ASC`)
  return rows.map((r) => mapRow(r, withCost))
}

export async function getEmployment(
  siteId: number,
  userId: number,
  withCost: boolean,
): Promise<Employment | null> {
  const row = await siteQueryOne<Row>(siteId, `${SELECT} WHERE e.user_id = ? LIMIT 1`, [userId])
  return row ? mapRow(row, withCost) : null
}

export type SaveResult = { ok: true } | { ok: false; error: string }

/**
 * Writes a person's terms, creating the row on first save.
 *
 * Upsert rather than insert-or-update at the call site: a user exists long
 * before anybody fills in their employment, so "have they got a row yet" is a
 * question no screen should have to ask.
 */
export async function saveEmployment(
  siteId: number,
  userId: number,
  input: EmploymentInput,
): Promise<SaveResult> {
  const problem = validateEmployment(input)
  if (problem) return { ok: false, error: problem }

  const user = await siteQueryOne<RowDataPacket & { id: number }>(
    siteId,
    'SELECT id FROM users WHERE id = ? LIMIT 1',
    [userId],
  )
  if (!user) return { ok: false, error: 'That person no longer exists.' }

  const number = input.employeeNumber?.trim() || null
  if (number) {
    const clash = await siteQueryOne<RowDataPacket & { user_id: number }>(
      siteId,
      'SELECT user_id FROM user_employment WHERE employee_number = ? AND user_id <> ? LIMIT 1',
      [number, userId],
    )
    if (clash) {
      return { ok: false, error: 'Somebody else already has that employee number.' }
    }
  }

  // The leave cycle follows the hire date unless told otherwise — BCEA s20
  // measures the annual entitlement from the start of employment, not from
  // January.
  const cycleStart = input.leaveCycleStart ?? input.hiredOn ?? null

  await siteExecute(
    siteId,
    `INSERT INTO user_employment
       (user_id, employee_number, employment_type, pay_basis, hourly_rate,
        monthly_salary, ordinary_hours_pw, works_sundays, hired_on, terminated_on,
        leave_cycle_start, notes)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE
       employee_number = VALUES(employee_number),
       employment_type = VALUES(employment_type),
       pay_basis = VALUES(pay_basis),
       hourly_rate = VALUES(hourly_rate),
       monthly_salary = VALUES(monthly_salary),
       ordinary_hours_pw = VALUES(ordinary_hours_pw),
       works_sundays = VALUES(works_sundays),
       hired_on = VALUES(hired_on),
       terminated_on = VALUES(terminated_on),
       leave_cycle_start = VALUES(leave_cycle_start),
       notes = VALUES(notes)`,
    [
      userId,
      number,
      input.employmentType,
      input.payBasis,
      input.hourlyRate.toFixed(4),
      input.monthlySalary.toFixed(4),
      input.ordinaryHoursPw.toFixed(2),
      input.worksSundays ? 1 : 0,
      input.hiredOn || null,
      input.terminatedOn || null,
      cycleStart,
      input.notes?.trim() || null,
    ],
  )
  return { ok: true }
}
