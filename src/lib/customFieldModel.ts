/**
 * What a custom field is, and what counts as a valid value for one.
 *
 * ── WHY THIS FILE HAS NO DATABASE IMPORT ───────────────────────────────────
 *
 * The same reason jobStatusModel.ts and orderStatusModel.ts do not: the setup
 * screen is a client component, and importing the site module would drag mysql2
 * into the browser bundle. Everything here is pure, so the screen refuses the
 * same values for the same reasons the server does — rather than the two drifting
 * until a form accepts something the action then rejects.
 */

export type CustomFieldEntity = 'job' | 'customer' | 'equipment' | 'sale'
export type CustomFieldType = 'text' | 'number' | 'date' | 'yesno' | 'list'

export const FIELD_ENTITIES: CustomFieldEntity[] = ['job', 'customer', 'equipment', 'sale']

/** What each entity is called on screen. Singular — it labels one record. */
export const ENTITY_LABEL: Record<CustomFieldEntity, string> = {
  job: 'Job',
  customer: 'Customer',
  equipment: 'Equipment',
  /**
   * A SALE, which is the only entity here whose fields are not asked for on
   * every record. They are captured at the till, and only when the tender
   * being paid with asks for them — see tender_types.asks_custom_comments.
   */
  sale: 'Sale',
}

/** The plural, for the tab that lists a whole set. */
export const ENTITY_PLURAL: Record<CustomFieldEntity, string> = {
  job: 'Jobs',
  customer: 'Customers',
  equipment: 'Equipment',
  sale: 'Sales',
}

export const FIELD_TYPES: CustomFieldType[] = ['text', 'number', 'date', 'yesno', 'list']

export const TYPE_LABEL: Record<CustomFieldType, string> = {
  text: 'Text',
  number: 'A number',
  date: 'A date',
  yesno: 'Yes or no',
  list: 'One of a list',
}

/**
 * A code is frozen at creation, so it has to be derivable from the name once and
 * then left alone.
 *
 * Lowercase, underscores, no leading digit — the shape a report filter and a
 * spreadsheet header can both carry without quoting.
 */
export function codeFromName(name: string): string {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40)
  // A code that starts with a digit breaks as an identifier in enough places
  // (spreadsheet headers, query params) to be worth prefixing rather than
  // refusing — somebody naming a field "2nd meter reading" meant something.
  return /^[0-9]/.test(base) ? `f_${base}`.slice(0, 40) : base
}

export function isValidCode(code: string): boolean {
  return /^[a-z][a-z0-9_]{0,39}$/.test(code)
}

export type FieldDefInput = {
  entity: CustomFieldEntity
  code: string
  name: string
  hint: string | null
  fieldType: CustomFieldType
  options: string[]
  unit: string | null
  isRequired: boolean
  isPublic: boolean
  isActive: boolean
}

/**
 * What is wrong with this definition, or null.
 *
 * One message rather than a list: a modal shows one error, and the first thing
 * wrong is the thing to fix.
 */
export function validateFieldDef(input: FieldDefInput): string | null {
  const name = input.name.trim()
  if (!name) return 'A field needs a name.'
  if (name.length > 120) return 'That name is too long.'

  if (!isValidCode(input.code)) {
    return 'A code must start with a letter and contain only letters, numbers and underscores.'
  }

  if (input.fieldType === 'list') {
    const options = input.options.map((o) => o.trim()).filter(Boolean)
    if (options.length < 2) {
      return 'A list needs at least two choices. With one, it is not a choice.'
    }
    if (new Set(options.map((o) => o.toLowerCase())).size !== options.length) {
      return 'Two of those choices are the same.'
    }
  }

  /*
   * A unit on a number is meaningful; on a yes/no it is nonsense. Refused rather
   * than ignored, because a silently dropped unit is a setting somebody believes
   * they saved.
   */
  if (input.unit && input.fieldType !== 'number') {
    return 'Only a number can carry a unit.'
  }

  return null
}

/**
 * What is wrong with this VALUE for that field, or null.
 *
 * Empty is always allowed here. Whether an empty required field blocks a save is
 * a question about the RECORD, not about the value, and it is answered where the
 * record is saved — so this function stays usable for a half-filled form.
 */
export function validateFieldValue(
  field: { fieldType: CustomFieldType; options: string[]; name: string },
  value: string | null,
): string | null {
  if (value === null || value.trim() === '') return null
  const v = value.trim()

  if (v.length > 500) return `${field.name} is too long.`

  switch (field.fieldType) {
    case 'number':
      // Number() accepts '' and whitespace, which is why the empty case is
      // returned above rather than relied on here.
      if (!Number.isFinite(Number(v))) return `${field.name} has to be a number.`
      return null
    case 'date':
      // ISO only. A locale date is ambiguous between two readers, and this value
      // is stored as text — so the format IS the meaning.
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return `${field.name} has to be a date.`
      if (Number.isNaN(Date.parse(`${v}T00:00:00Z`))) return `${field.name} is not a real date.`
      return null
    case 'yesno':
      if (v !== 'yes' && v !== 'no') return `${field.name} has to be yes or no.`
      return null
    case 'list':
      if (!field.options.includes(v)) return `${v} is not one of the choices for ${field.name}.`
      return null
    default:
      return null
  }
}

/** How a stored value reads on screen. */
export function formatFieldValue(
  field: { fieldType: CustomFieldType; unit: string | null },
  value: string | null,
): string {
  if (value === null || value.trim() === '') return ''
  const v = value.trim()
  if (field.fieldType === 'yesno') return v === 'yes' ? 'Yes' : 'No'
  if (field.fieldType === 'number' && field.unit) return `${v} ${field.unit}`
  return v
}
