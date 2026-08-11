import 'server-only'
import { toXlsx, toCsv, exportFilename, type ExportColumn } from '@/lib/export/table'
import type { ImportField } from './spec'

/**
 * The blank file to fill in.
 *
 * Generated from the same `ImportField[]` that does the auto-mapping, so a
 * template heading no alias recognises cannot exist. That is the property worth
 * having here: a template the importer then fails to read is the most annoying
 * possible bug, and building both from one array makes it unreachable.
 *
 * The example row is not decoration. 'Fresh Produce › Fruit' in a Department
 * cell teaches the path separator far better than a hint on the mapping screen,
 * because it is in front of the person at the moment they are typing the column.
 */

type TemplateRow = Record<string, string>

export function templateColumns<T>(fields: readonly ImportField<T>[]): ExportColumn<TemplateRow>[] {
  return fields.map((field) => ({
    // The first alias is what auto-mapping prefers, so writing it here means a
    // returned template maps perfectly with nothing for the user to correct.
    header: field.aliases[0] ?? field.label,
    value: (row) => row[field.key] ?? '',
  }))
}

/** One row of examples, so the shape of each column is visible in the file. */
function exampleRow<T>(fields: readonly ImportField<T>[]): TemplateRow {
  const row: TemplateRow = {}
  for (const field of fields) {
    if (field.example) row[field.key] = field.example
  }
  return row
}

export function templateXlsx<T>(
  fields: readonly ImportField<T>[],
  title: string,
): { body: Buffer; filename: string } {
  const columns = templateColumns(fields)
  const example = exampleRow(fields)
  const rows = Object.keys(example).length > 0 ? [example] : []
  return {
    body: toXlsx(rows, columns, title.slice(0, 31)),
    filename: exportFilename(`${title.toLowerCase().replace(/\s+/g, '-')}-import-template`, 'xlsx'),
  }
}

export function templateCsv<T>(
  fields: readonly ImportField<T>[],
  title: string,
): { body: string; filename: string } {
  const columns = templateColumns(fields)
  const example = exampleRow(fields)
  const rows = Object.keys(example).length > 0 ? [example] : []
  return {
    body: toCsv(rows, columns),
    filename: exportFilename(`${title.toLowerCase().replace(/\s+/g, '-')}-import-template`, 'csv'),
  }
}
