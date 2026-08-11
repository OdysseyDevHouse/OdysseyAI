import { normaliseHeader } from './text'

/**
 * Only the parts of a field that matching needs.
 *
 * Deliberately narrower than `ImportField`, because the mapping screen runs in
 * the browser and a field's `parse` is a function — functions do not cross the
 * server→client boundary. Typing against what is actually read lets one
 * implementation serve both sides instead of one for each.
 */
type Mappable = {
  key: string
  aliases: readonly string[]
  required?: boolean
  label: string
}

/**
 * Matching the file's columns to the import's fields.
 *
 * Auto-mapping is a guess, and the mapping screen exists because a guess that
 * cannot be corrected is worse than no guess at all: a heading spelled slightly
 * off silently drops a whole column, and the user finds out when 4,000 products
 * have no cost. So this decides a starting point and the screen makes it
 * visible and editable.
 */

/** field key → column index in the file, or null for "not mapped". */
export type Mapping = Record<string, number | null>

/**
 * Chooses a column for each field.
 *
 * Earlier aliases beat later ones, so a field listing ['code', 'itemcode']
 * prefers a column literally called Code. Each column is claimed once — two
 * fields cannot read the same column, because that is always a mistake and
 * silently letting it through produces two fields with the same wrong value.
 */
export function autoMap(
  headers: readonly string[],
  fields: readonly Mappable[],
): Mapping {
  const normalised = headers.map((h) => normaliseHeader(h))
  const claimed = new Set<number>()
  const mapping: Mapping = {}

  // Two passes so an exact first-alias match cannot lose a column to a field
  // whose fifth alias happened to be tried earlier.
  for (const pass of [0, 1]) {
    for (const field of fields) {
      if (mapping[field.key] != null) continue

      const aliases = pass === 0 ? field.aliases.slice(0, 1) : field.aliases
      for (const alias of aliases) {
        const wanted = normaliseHeader(alias)
        const index = normalised.findIndex((h, i) => h === wanted && !claimed.has(i))
        if (index !== -1) {
          mapping[field.key] = index
          claimed.add(index)
          break
        }
      }
    }
  }

  for (const field of fields) {
    if (mapping[field.key] === undefined) mapping[field.key] = null
  }

  return mapping
}

/** Fields the file has to carry that it does not. Blocks the import. */
export function missingRequired<T extends Mappable>(
  fields: readonly T[],
  mapping: Mapping,
): T[] {
  return fields.filter((f) => f.required && mapping[f.key] == null)
}

/** Headings in the file that no field claimed — shown so a typo is visible. */
export function unmappedColumns(headers: readonly string[], mapping: Mapping): string[] {
  const claimed = new Set(Object.values(mapping).filter((v): v is number => v != null))
  return headers
    .map((header, index) => ({ header, index }))
    .filter(({ header, index }) => header.trim() && !claimed.has(index))
    .map(({ header }) => header)
}
