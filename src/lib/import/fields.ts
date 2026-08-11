import { parseAmount, parseBool, parseDate } from './text'
import { norm, splitPath, PATH_SEPARATOR } from './lookups'
import {
  PROBLEM, SKIP, VALUE,
  type Cell, type FieldOutcome, type ImportField, type LookupTables,
} from './spec'

/**
 * The field parsers every spec is built from.
 *
 * Each is a small factory rather than a bare function so a spec reads as a
 * list of columns and nothing else. The value of having them here is that
 * 'that number is not a number' is worded once: an import whose refusals are
 * phrased twenty different ways reads as twenty different bugs.
 *
 * Every message names what to do, not just what is wrong. 'Not a number' tells
 * someone staring at a 20,000-row sheet nothing; 'Write it as 12.50, without a
 * currency symbol' tells them where to look and what to type.
 */

type Factory<T> = Omit<ImportField<T>, 'parse'> & { parse?: never }

/** Plain text, length-checked so the database's own limit is never the message. */
export function text<T>(field: Factory<T> & { max?: number }): ImportField<T> {
  const { max, ...rest } = field
  return {
    ...rest,
    parse: (cell) => {
      const value = cell.text.trim()
      if (max && value.length > max) {
        return PROBLEM(`Too long — keep it to ${max} characters or fewer. This one is ${value.length}.`)
      }
      return VALUE(value)
    },
  }
}

/** A number, written however a spreadsheet writes them. */
export function number<T>(
  field: Factory<T> & { min?: number; max?: number; integer?: boolean },
): ImportField<T> {
  const { min, max, integer, ...rest } = field
  return {
    ...rest,
    parse: (cell) => {
      const value = parseAmount(cell.text)
      if (value === null) {
        return PROBLEM(`"${cell.text}" is not a number. Write it as 12.50, without a currency symbol.`)
      }
      if (integer && !Number.isInteger(value)) {
        return PROBLEM(`${value} must be a whole number.`)
      }
      if (min !== undefined && value < min) return PROBLEM(`${value} is below the lowest allowed, ${min}.`)
      if (max !== undefined && value > max) return PROBLEM(`${value} is above the highest allowed, ${max}.`)
      return VALUE(value)
    },
  }
}

/** Yes/No, TRUE/FALSE, 1/0 — an unrecognised word is refused, never assumed. */
export function boolean<T>(field: Factory<T>): ImportField<T> {
  return {
    ...field,
    parse: (cell) => {
      const value = parseBool(cell.text)
      if (value === null) {
        return PROBLEM(`"${cell.text}" is not a yes or a no. Write Yes or No.`)
      }
      return VALUE(value)
    },
  }
}

/** A date, in whatever format the file settled on. See `detectDateFormat`. */
export function date<T>(field: Factory<T>): ImportField<T> {
  return {
    ...field,
    parse: (cell, lookups) => {
      const value = parseDate(cell.text, lookups.dateFormat)
      if (!value) {
        return PROBLEM(`"${cell.text}" is not a date this can read. Write it as 2026-03-15 or 15/03/2026.`)
      }
      return VALUE(value)
    },
  }
}

/** One of a fixed set of words, matched loosely and listed back when it misses. */
export function choice<T>(
  field: Factory<T> & { options: Readonly<Record<string, string>> },
): ImportField<T> {
  const { options, ...rest } = field
  return {
    ...rest,
    parse: (cell) => {
      const key = norm(cell.text)
      const match = Object.entries(options).find(([label]) => norm(label) === key)
      if (!match) {
        return PROBLEM(`"${cell.text}" is not one of: ${Object.keys(options).join(', ')}.`)
      }
      return VALUE(match[1])
    },
  }
}

/**
 * A reference to something that must already exist.
 *
 * Refusing rather than creating is the default for everything except
 * departments, because the thing being named carries settings a product file
 * cannot state — a VAT rate has a percentage, a location has a main flag, a
 * supplier has an entire account. Inventing one from a cell would be inventing
 * those too.
 */
export function reference<T>(
  field: Factory<T> & {
    /** Which Map to look in. */
    table: (lookups: LookupTables) => Map<string, number>
    /** What to call it in the refusal: 'brand', 'supplier code'. */
    noun: string
    /** Appended to the refusal — where to go and add one. */
    fix?: string
  },
): ImportField<T> {
  const { table, noun, fix, ...rest } = field
  return {
    ...rest,
    parse: (cell, lookups) => {
      const id = table(lookups).get(norm(cell.text))
      if (id === undefined) {
        return PROBLEM(`No ${noun} called "${cell.text}".${fix ? ` ${fix}` : ''}`)
      }
      return VALUE(id)
    },
  }
}

/**
 * A department, by full path or by an unambiguous leaf name.
 *
 * Returns the PATH rather than an id, because a path that does not exist yet is
 * still a valid answer here — departments are created on the way in, unlike
 * every other reference. The apply step walks it. See `ensureDepartmentPath`.
 *
 * The one refusal is a bare name two departments share: filing a row under
 * whichever branch happened to load first is exactly the silent
 * misclassification this whole module exists to avoid.
 */
export function departmentPath<T>(field: Factory<T>): ImportField<T> {
  return {
    ...field,
    lookup: 'department',
    parse: (cell, lookups): FieldOutcome<unknown> => {
      const segments = splitPath(cell.text)
      if (segments.length === 0) return SKIP

      const path = segments.join(` ${PATH_SEPARATOR} `)
      if (segments.length === 1 && lookups.departmentAmbiguous.has(norm(segments[0]))) {
        return PROBLEM(
          `More than one department is called "${segments[0]}". Write the full path, like "Fresh Produce ${PATH_SEPARATOR} ${segments[0]}".`,
        )
      }
      return VALUE(path)
    },
  }
}

/** Splits a cell holding several values — serial numbers, barcodes. */
export function list<T>(field: Factory<T> & { separator?: RegExp }): ImportField<T> {
  const { separator = /[;,|]/, ...rest } = field
  return {
    ...rest,
    parse: (cell) => {
      const values = cell.text.split(separator).map((v) => v.trim()).filter(Boolean)
      if (values.length === 0) return SKIP
      return VALUE(values)
    },
  }
}

/** Reads a cell as-is, for a field doing its own thing entirely. */
export function custom<T>(
  field: Factory<T> & { parse: (cell: Cell, lookups: LookupTables) => FieldOutcome<unknown> },
): ImportField<T> {
  return field as ImportField<T>
}
