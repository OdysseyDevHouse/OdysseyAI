/**
 * Employment facts shared by the server and the browser.
 *
 * Deliberately NOT `server-only`, and deliberately separate from
 * `site/employment.ts`, which is. The staff form needs the same employment
 * types, pay bases and BCEA ceiling the server validates against — importing
 * them from the server module would drag `siteDb` and mysql2 into the client
 * bundle, which is a build error rather than a subtle one.
 *
 * Same split as `periodLockModel.ts`: the vocabulary lives here, the queries
 * live there. Nothing in this file touches a database or a Node builtin.
 */

export type EmploymentType = 'permanent' | 'fixed_term' | 'casual' | 'contractor'
export type PayBasis = 'hourly' | 'salaried'

export const EMPLOYMENT_TYPES: { value: EmploymentType; label: string }[] = [
  { value: 'permanent', label: 'Permanent' },
  { value: 'fixed_term', label: 'Fixed term' },
  { value: 'casual', label: 'Casual' },
  { value: 'contractor', label: 'Contractor' },
]

export const PAY_BASES: { value: PayBasis; label: string }[] = [
  { value: 'hourly', label: 'Paid by the hour' },
  { value: 'salaried', label: 'Salaried' },
]

/** What to call each type in a table cell. */
export const EMPLOYMENT_TYPE_LABELS: Record<EmploymentType, string> = {
  permanent: 'Permanent',
  fixed_term: 'Fixed term',
  casual: 'Casual',
  contractor: 'Contractor',
}

/**
 * BCEA section 9 — the maximum ordinary hours in a week.
 *
 * Anything worked above a person's ordinary hours is overtime. Setting someone
 * above 45 would mean no hour they ever work counts as overtime, which is both
 * wrong arithmetically and unlawful as a standing pattern.
 */
export const BCEA_ORDINARY_HOURS_PW = 45

export type Employment = {
  userId: number
  userName: string
  employeeNumber: string | null
  employmentType: EmploymentType
  payBasis: PayBasis
  /** Null when the reader may not see pay. Never zero as a stand-in. */
  hourlyRate: number | null
  monthlySalary: number | null
  ordinaryHoursPw: number
  /**
   * Whether Sunday is an ordinary working day for this person.
   *
   * BCEA section 16 pays Sunday work at double — unless the employee
   * ordinarily works Sundays, in which case 16(2) makes it one and a half.
   * Per person, because the same shop has a weekend team who always work
   * Sundays and an office who never do.
   */
  worksSundays: boolean
  hiredOn: string | null
  terminatedOn: string | null
  leaveCycleStart: string | null
  notes: string | null
  /** Employed today — i.e. not terminated, or terminated in the future. */
  isCurrent: boolean
}

export type EmploymentInput = {
  employeeNumber: string | null
  employmentType: EmploymentType
  payBasis: PayBasis
  hourlyRate: number
  monthlySalary: number
  ordinaryHoursPw: number
  worksSundays: boolean
  hiredOn: string | null
  terminatedOn: string | null
  leaveCycleStart: string | null
  notes: string | null
}

/**
 * The rate to cost an hour at.
 *
 * A salaried person still has an hourly cost — it is what the month divides
 * into. Derived rather than stored so a salary change does not require
 * somebody to remember to update a second field.
 *
 * Returns null when pay is hidden or absent, which a report shows as "no rate
 * on file". Zero would silently say somebody worked for nothing.
 *
 * Pure arithmetic, so it lives here and both sides can call it — the form
 * previews the figure while somebody is typing, and the cost report computes
 * the real one.
 */
export function hourlyCostOf(employment: Employment): number | null {
  if (employment.payBasis === 'hourly') return employment.hourlyRate
  if (employment.monthlySalary === null) return null

  // 52 weeks over 12 months. The BCEA uses the same conversion when working a
  // daily wage out of a monthly one.
  const hoursPerMonth = employment.ordinaryHoursPw * (52 / 12)
  return hoursPerMonth > 0 ? employment.monthlySalary / hoursPerMonth : null
}

/** Shared by the form and the server so the two cannot disagree. */
export function validateEmployment(input: EmploymentInput): string | null {
  if (input.hourlyRate < 0 || input.monthlySalary < 0) {
    return 'A pay rate cannot be negative.'
  }
  if (input.ordinaryHoursPw <= 0) {
    return 'Ordinary hours must be more than zero — overtime is measured against them.'
  }
  if (input.ordinaryHoursPw > BCEA_ORDINARY_HOURS_PW) {
    return `Ordinary hours cannot exceed ${BCEA_ORDINARY_HOURS_PW} a week — that is the limit in section 9 of the BCEA.`
  }
  if (input.hiredOn && input.terminatedOn && input.terminatedOn < input.hiredOn) {
    return 'The end date is before the start date.'
  }
  if (input.employeeNumber && input.employeeNumber.length > 32) {
    return 'That employee number is too long.'
  }
  return null
}
