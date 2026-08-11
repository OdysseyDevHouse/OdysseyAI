import 'server-only'
import type { ImportSpec } from './spec'
import { departmentSpec } from './specs/departments'
import { supplierSpec } from './specs/suppliers'
import { customerSpec } from './specs/customers'
import { productSpec } from './specs/products'

/**
 * Everything that can be imported, by its id in the URL.
 *
 * One route serves all of them — `/setup/import/[entity]` — so adding an
 * import is adding a spec and one line here, not a screen. That is the whole
 * return on the engine: the seventh import costs what the second one did.
 */

// The specs disagree about their draft shapes, which is the point — each one
// is typed against its own entity. They meet the engine through the same
// interface, so the registry holds them at their common shape.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const SPECS: readonly ImportSpec<any>[] = [
  // Listed in the order a shop switching systems should run them: the things
  // products point at come before products do.
  departmentSpec,
  supplierSpec,
  customerSpec,
  productSpec,
]

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function specFor(entity: string): ImportSpec<any> | null {
  return SPECS.find((spec) => spec.entity === entity) ?? null
}

/** Plain data for the index screen — never the specs themselves, which hold functions. */
export function importCatalogue(): {
  entity: string
  title: string
  singular: string
  description: string
  capability: string
}[] {
  return SPECS.map((spec) => ({
    entity: spec.entity,
    title: spec.title,
    singular: spec.singular,
    description: spec.description,
    capability: spec.capability,
  }))
}
