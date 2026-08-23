/**
 * What a custom form is made of (§24).
 *
 * Pure, and separate from `lib/site/jobForms.ts` for the reason serialStatus.ts
 * gives: the builder and the filling-in screen are both client components and
 * need these labels, while that module is `server-only` and imports the pool.
 * Types erase at compile time; constants do not.
 *
 * The validation below is the SAME function the server runs. A form rejecting a
 * value on screen that the action would have accepted — or worse, the reverse —
 * is how a field ends up with two definitions of valid.
 */

export const FORM_FIELD_TYPES = [
  'short_text',
  'long_text',
  'number',
  'measure',
  'date',
  'time',
  'dropdown',
  'multi_select',
  'choice',
  'checkbox',
  'yesno',
  'file',
  'photo',
  'signature',
  'gps',
  'record',
  'heading',
  'page_break',
] as const
export type FormFieldType = (typeof FORM_FIELD_TYPES)[number]

export const FIELD_TYPE_LABEL: Record<FormFieldType, string> = {
  short_text: 'Short text',
  long_text: 'Long text',
  number: 'A number',
  measure: 'A measurement',
  date: 'A date',
  time: 'A time',
  dropdown: 'One from a list',
  multi_select: 'Several from a list',
  choice: 'One of a few',
  checkbox: 'A tick box',
  yesno: 'Yes or no',
  file: 'A file',
  photo: 'A photograph',
  signature: 'A signature',
  gps: 'Where they were',
  record: 'Pick a record',
  heading: 'A heading',
  page_break: 'A page break',
}

/** Which kinds carry a list of options the builder must collect. */
export const TYPES_WITH_OPTIONS: readonly FormFieldType[] = ['dropdown', 'multi_select', 'choice']

/** Which kinds resolve to an uploaded file. */
export const TYPES_WITH_FILE: readonly FormFieldType[] = ['file', 'photo', 'signature']

/**
 * Which kinds are STRUCTURE rather than a question.
 *
 * They take no answer, are never required, and are skipped by the completeness
 * check — a heading that counted as unanswered would make every form with a
 * section permanently incomplete.
 */
export const TYPES_WITHOUT_ANSWERS: readonly FormFieldType[] = ['heading', 'page_break']

export function isFormFieldType(value: string): value is FormFieldType {
  return (FORM_FIELD_TYPES as readonly string[]).includes(value)
}

export function takesAnswer(type: FormFieldType): boolean {
  return !TYPES_WITHOUT_ANSWERS.includes(type)
}

export const RECORD_KINDS = ['customer', 'contact', 'site', 'asset'] as const
export type RecordKind = (typeof RECORD_KINDS)[number]

export const RECORD_KIND_LABEL: Record<RecordKind, string> = {
  customer: 'A customer',
  contact: 'A contact',
  site: 'A site',
  asset: 'A piece of equipment',
}

/* ── One field, and one answer ───────────────────────────────────────────── */

export type FormField = {
  id: number
  fieldType: FormFieldType
  label: string
  hint: string | null
  unit: string | null
  recordKind: RecordKind | null
  options: string[]
  isRequired: boolean
  minValue: number | null
  maxValue: number | null
  maxLength: number | null
  pattern: string | null
  showIfFieldId: number | null
  showIfValue: string | null
  sortOrder: number
}

/**
 * An answer, in the shape both the screen and the action use.
 *
 * One optional property per storage column rather than a tagged union, because
 * the field decides which one is meaningful and a union would mean the client
 * asserting a type the server has to re-check anyway.
 */
export type FormAnswer = {
  fieldId: number
  text?: string | null
  number?: number | null
  date?: string | null
  bool?: boolean | null
  attachmentId?: number | null
  recordId?: number | null
  latitude?: number | null
  longitude?: number | null
}

/**
 * Is this field currently on screen?
 *
 * A field with no condition always is. A conditional one appears when the field
 * it depends on holds the value it names — compared as TEXT, because that is the
 * only representation every type shares, and a condition on a number written
 * "400" must match a number answered 400.
 *
 * A condition pointing at a field with no answer yet is NOT shown. That is the
 * conservative reading and the right one: "why not?" should appear once somebody
 * has said No, not before they have said anything.
 */
export function isFieldVisible(
  field: FormField,
  answers: ReadonlyMap<number, FormAnswer>,
): boolean {
  if (field.showIfFieldId === null) return true
  const on = answers.get(field.showIfFieldId)
  if (!on) return false
  return answerAsText(on) === (field.showIfValue ?? '')
}

/** The comparable form of an answer, for conditions and for display. */
export function answerAsText(answer: FormAnswer): string {
  if (answer.bool !== null && answer.bool !== undefined) return answer.bool ? 'yes' : 'no'
  if (answer.number !== null && answer.number !== undefined) return String(answer.number)
  if (answer.date) return answer.date
  if (answer.text) return answer.text
  return ''
}

/** True when the field has been given something. */
export function isAnswered(field: FormField, answer: FormAnswer | undefined): boolean {
  if (!takesAnswer(field.fieldType)) return true
  if (!answer) return false

  if (TYPES_WITH_FILE.includes(field.fieldType)) {
    return answer.attachmentId !== null && answer.attachmentId !== undefined
  }
  if (field.fieldType === 'gps') {
    return (
      answer.latitude !== null &&
      answer.latitude !== undefined &&
      answer.longitude !== null &&
      answer.longitude !== undefined
    )
  }
  if (field.fieldType === 'record') {
    return answer.recordId !== null && answer.recordId !== undefined
  }
  /*
   * A checkbox is answered whether it is ticked or not.
   *
   * This is the one that catches people out: `false` is an answer to "is the
   * isolator locked off", and treating it as blank would make a required
   * checkbox impossible to satisfy honestly — the only way past would be to
   * tick it.
   */
  if (field.fieldType === 'checkbox' || field.fieldType === 'yesno') {
    return answer.bool !== null && answer.bool !== undefined
  }
  if (field.fieldType === 'number' || field.fieldType === 'measure') {
    return answer.number !== null && answer.number !== undefined
  }
  return (answer.text ?? '').trim() !== ''
}

/**
 * Why this answer is not acceptable, or null.
 *
 * Runs on the screen as somebody types and on the server before anything is
 * written. One function, so the two cannot disagree about what valid means.
 */
export function validateAnswer(
  field: FormField,
  answer: FormAnswer | undefined,
): string | null {
  if (!takesAnswer(field.fieldType)) return null

  const answered = isAnswered(field, answer)
  if (!answered) {
    return field.isRequired ? `${field.label} is required.` : null
  }
  if (!answer) return null

  if (field.fieldType === 'number' || field.fieldType === 'measure') {
    const n = answer.number as number
    if (!Number.isFinite(n)) return `${field.label} must be a number.`
    if (field.minValue !== null && n < field.minValue) {
      return `${field.label} cannot be less than ${field.minValue}.`
    }
    if (field.maxValue !== null && n > field.maxValue) {
      return `${field.label} cannot be more than ${field.maxValue}.`
    }
    return null
  }

  const text = (answer.text ?? '').trim()

  if (field.maxLength !== null && text.length > field.maxLength) {
    return `${field.label} is longer than ${field.maxLength} characters.`
  }

  /*
   * A pattern that does not compile is IGNORED rather than failing the answer.
   *
   * The pattern was typed by an administrator into a builder; the person it
   * would reject is a technician on a roof who cannot fix it. Refusing their
   * answer because somebody else wrote a bad regex punishes the wrong person,
   * and the field is still checked for required and length.
   */
  if (field.pattern && text !== '') {
    try {
      if (!new RegExp(field.pattern).test(text)) {
        return `${field.label} is not in the expected format.`
      }
    } catch {
      /* Unusable pattern. See above. */
    }
  }

  if (TYPES_WITH_OPTIONS.includes(field.fieldType) && field.options.length > 0) {
    const chosen =
      field.fieldType === 'multi_select' ? parseMultiSelect(text) : text === '' ? [] : [text]
    const bad = chosen.find((c) => !field.options.includes(c))
    if (bad !== undefined) return `${bad} is not one of the choices for ${field.label}.`
  }

  return null
}

/**
 * multi_select stores its chosen values as a JSON array in the text column.
 *
 * Tolerant of anything that is not an array, because the column is shared with
 * every other text answer and a malformed value must read as "nothing chosen"
 * rather than throwing on a screen somebody is trying to fill in.
 */
export function parseMultiSelect(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.map((v) => String(v)) : []
  } catch {
    return []
  }
}

/**
 * Everything wrong with a response, in field order.
 *
 * Invisible fields are skipped entirely — a required question behind a condition
 * that is not met has not been dodged, it was never asked. Validating it anyway
 * is how a form becomes impossible to submit.
 */
export function validateResponse(
  fields: readonly FormField[],
  answers: ReadonlyMap<number, FormAnswer>,
): string[] {
  const problems: string[] = []
  for (const field of fields) {
    if (!isFieldVisible(field, answers)) continue
    const problem = validateAnswer(field, answers.get(field.id))
    if (problem) problems.push(problem)
  }
  return problems
}
