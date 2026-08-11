/**
 * The spreadsheet import engine.
 *
 * What is actually being protected here:
 *
 *  - a file is READ the way a person wrote it — quoted commas, currency
 *    symbols, preamble rows above the headings, whatever Excel did to a barcode
 *  - every row lands in exactly one bucket and NOTHING is silently dropped,
 *    because "18,000 of 20,000 imported" is a number nobody can act on
 *  - a partial file never blanks the fields it does not mention, which is the
 *    one failure that would quietly destroy a catalogue
 *  - a department path creates each level once, no matter how many rows name it
 *
 *   npm run test:imports
 */
import { siteExecute, siteQueryOne, siteQuery } from '../src/lib/siteDb'
import type { RowDataPacket } from 'mysql2/promise'
import { readCsv, aliasSet } from '../src/lib/import/sheet'
import { autoMap, missingRequired, unmappedColumns } from '../src/lib/import/map'
import { planImport } from '../src/lib/import/plan'
import { applyBatch, fold, emptyTotals } from '../src/lib/import/apply'
import { mergeForUpdate, fileSpeaksTo } from '../src/lib/import/merge'
import { templateCsv } from '../src/lib/import/template'
import { fieldsFor, type ImportSpec } from '../src/lib/import/spec'
import { departmentPath } from '../src/lib/import/fields'
import { departmentSpec, ensureDepartmentPath } from '../src/lib/import/specs/departments'
import { supplierSpec } from '../src/lib/import/specs/suppliers'
import { customerSpec } from '../src/lib/import/specs/customers'
import { productSpec } from '../src/lib/import/specs/products'
import { getDepartment, listDepartments } from '../src/lib/site/departments'
import { splitCsvLine, parseAmount, parseDate, detectDateFormat } from '../src/lib/import/text'

const SITE = 1
const actor = { userId: 1, userName: 'Import Test' }
let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

/** Runs a whole file through the engine the way the wizard does. */
async function runFile<T>(
  spec: ImportSpec<T>,
  csv: string,
  mode: 'skip' | 'update' = 'skip',
) {
  const lookups = await spec.loadLookups(SITE)
  const fields = fieldsFor(spec, lookups)
  const read = readCsv(csv, aliasSet(fields))
  if (!read.ok) throw new Error(read.error)

  const mapping = autoMap(read.sheet.headers, fields)
  const plan = planImport(
    spec, fields, lookups, mapping, read.sheet.rows,
    read.sheet.headers, mode, read.sheet.headerLine,
  )

  const mapped = new Set(
    Object.entries(mapping).filter(([, col]) => col != null).map(([key]) => key),
  )
  const ctx = { siteId: SITE, actor, lookups, mapped }

  const outcomes = await applyBatch(spec, ctx, {
    entity: spec.entity,
    mode,
    offset: 0,
    rows: plan.ready.map((r) => ({ line: r.line, code: r.code, draft: r.draft })),
    mapped: [...mapped],
    dateFormat: lookups.dateFormat,
  })

  return { read: read.sheet, mapping, plan, outcomes, totals: fold(emptyTotals(), outcomes) }
}

async function main() {
  const stamp = Date.now().toString().slice(-8)
  const S = '›'

  // ── The text primitives, which everything else is built on ────────────
  console.log('\n── Reading what a person actually wrote')

  ok(
    '*** a quoted comma does not shift the columns ***',
    splitCsvLine('A,"Smith, T (Pty) Ltd",99.50')[2] === '99.50',
    splitCsvLine('A,"Smith, T (Pty) Ltd",99.50')[2],
  )
  ok('a doubled quote is one literal quote', splitCsvLine('A,"say ""hi""",1')[1] === 'say "hi"')
  ok('R and spaces come off an amount', parseAmount('R 12 345.67') === 12345.67)
  ok('a parenthesised amount is negative', parseAmount('(500.00)') === -500)
  ok('a trailing minus is negative', parseAmount('750.00-') === -750)
  ok('1,234.56 is not twelve hundred thousand', parseAmount('1,234.56') === 1234.56)
  ok('99,50 with no dot is a comma decimal', parseAmount('99,50') === 99.5)
  ok('a blank is not zero', parseAmount('') === null)
  ok('a word is not a number', parseAmount('n/a') === null)
  ok(
    'the file, not the row, decides day-first',
    detectDateFormat(['03/04/2026', '20/08/2026']) === 'dd/mm/yyyy',
  )
  ok(
    'one 12/25 flips the whole file to month-first',
    detectDateFormat(['03/04/2026', '12/25/2026']) === 'mm/dd/yyyy',
  )
  ok('a named month with a short year reads', parseDate('15-Mar-26', null) === '2026-03-15')

  // ── Finding the header under a pile of preamble ───────────────────────
  console.log('\n── Finding the headings')

  const lookups = await departmentSpec.loadLookups(SITE)
  const deptFields = fieldsFor(departmentSpec, lookups)
  const aliases = aliasSet(deptFields)

  const preamble = readCsv(
    [
      'Stock Report — Acme Trading (Pty) Ltd',
      'Printed 2026-03-15',
      '',
      'Department,Code,Colour',
      `Preamble Test ${stamp},PRE,#2f6fed`,
    ].join('\n'),
    aliases,
  )
  ok('*** headings are found under three preamble lines ***', preamble.ok)
  if (preamble.ok) {
    ok('  and the body starts after them', preamble.sheet.rows.length === 1, `${preamble.sheet.rows.length} rows`)
    ok('  with the source line number kept', preamble.sheet.headerLine === 4, String(preamble.sheet.headerLine))
  }

  const noHeader = readCsv('just,some,numbers\n1,2,3', aliases)
  ok('a file with no recognisable heading is refused, not guessed at', !noHeader.ok)

  // ── Mapping ───────────────────────────────────────────────────────────
  console.log('\n── Matching columns to fields')

  const mapped = readCsv('DEPARTMENT NAME,dept_code,Colour\nA,B,#ffffff', aliases)
  if (mapped.ok) {
    const mapping = autoMap(mapped.sheet.headers, deptFields)
    ok(
      'spacing and capitals do not stop a heading matching',
      mapping.color === 2,
      JSON.stringify(mapping),
    )
    ok('a required field with no column is reported', missingRequired(deptFields, { path: null }).length === 1)
    ok(
      'a column nothing claimed is named, so a typo is visible',
      unmappedColumns(['Department', 'Barcodeee'], { path: 0 }).includes('Barcodeee'),
    )
  }

  // ── The department tree ───────────────────────────────────────────────
  console.log('\n── Departments: a path is created once, however often it is named')

  const before = (await listDepartments(SITE, true)).length

  const run = await runFile(
    departmentSpec,
    [
      'Department,Code,Colour',
      `Imp ${stamp} ${S} Fruit ${S} Citrus,CIT,#2f6fed`,
      `Imp ${stamp} ${S} Fruit ${S} Berries,BER,`,
      `Imp ${stamp} ${S} Veg,VEG,`,
    ].join('\n'),
  )

  ok('*** every row was understood ***', run.plan.problems.length === 0, JSON.stringify(run.plan.problems))
  ok('  three rows ready', run.plan.ready.length === 3, String(run.plan.ready.length))
  ok('  three created', run.totals.created === 3, JSON.stringify(run.totals))
  ok('  nothing failed', run.totals.failed === 0)

  const after = await listDepartments(SITE, true)
  const mine = after.filter((d) => d.name.includes(String(stamp)) || ['Fruit', 'Citrus', 'Berries', 'Veg'].includes(d.name))
  ok(
    '*** the shared parent was created ONCE, not once per row ***',
    after.length - before === 5,
    `${after.length - before} new (root + Fruit + Citrus + Berries + Veg)`,
  )
  ok('  the leaf carries the code from its own row', mine.some((d) => d.name === 'Citrus' && d.code === 'CIT'))
  ok(
    '  a branch walked through did NOT take the leaf colour',
    mine.some((d) => d.name === 'Fruit' && d.color === null),
    String(mine.find((d) => d.name === 'Fruit')?.color),
  )

  // ── Re-importing the same file ────────────────────────────────────────
  console.log('\n── The same file twice')

  const again = await runFile(
    departmentSpec,
    ['Department,Code,Colour', `Imp ${stamp} ${S} Fruit ${S} Citrus,CIT,#2f6fed`].join('\n'),
  )
  ok(
    '*** a re-import skips rather than duplicating ***',
    again.plan.skipped.length === 1,
    `plan: ${JSON.stringify(again.plan.counts)} ready=${JSON.stringify(again.plan.ready.map((r) => r.code))}`,
  )
  ok('  and writes nothing', again.totals.created === 0)

  const afterRerun = (await listDepartments(SITE, true)).length
  ok('  the tree did not grow', afterRerun === after.length, `${afterRerun} vs ${after.length}`)

  // ── Update mode must not blank what the file omits ────────────────────
  console.log('\n── A partial file in update mode')

  const citrus = after.find((d) => d.name === 'Citrus')
  if (citrus) {
    // Give it a picture the import knows nothing about — the exact thing an
    // unconditional UPDATE would silently wipe.
    await siteExecute(SITE, 'UPDATE departments SET pos_image_id = NULL, sort_order = 7 WHERE id = ?', [citrus.id])

    const partial = await runFile(
      departmentSpec,
      ['Department,Colour', `Imp ${stamp} ${S} Fruit ${S} Citrus,#ff0000`].join('\n'),
      'update',
    )
    ok('*** an existing path updates rather than duplicating ***', partial.totals.updated === 1, JSON.stringify(partial.totals))

    const reread = await getDepartment(SITE, citrus.id)
    ok('  the mapped column changed', reread?.color === '#ff0000', String(reread?.color))
    ok(
      '*** the UNMAPPED code was not blanked ***',
      reread?.code === 'CIT',
      String(reread?.code),
    )
    ok(
      '*** and sort order the import never heard of survived ***',
      reread?.sortOrder === 7,
      String(reread?.sortOrder),
    )
  }

  // ── Nothing is ever silently dropped ──────────────────────────────────
  console.log('\n── Every row is accounted for')

  const messy = await runFile(
    departmentSpec,
    [
      'Department,Code,Colour',
      `Imp ${stamp} ${S} Veg,VEG,`,                      // exists → skipped
      `Imp2 ${stamp} ${S} New,NEW,`,                     // creates
      `,ORPHAN,`,                                        // no name → problem
      `Imp2 ${stamp} ${S} New,DUP,`,                     // same path twice → problem
      `Imp3 ${stamp},X,not-a-colour`,                    // bad colour reaches the DB refusal
    ].join('\n'),
  )

  const accounted =
    messy.plan.ready.length + messy.plan.skipped.length + messy.plan.problems.length
  ok(
    '*** every row is in exactly one bucket ***',
    accounted === messy.plan.counts.total,
    `${accounted} of ${messy.plan.counts.total}`,
  )
  ok(
    '*** a blank required cell is caught BEFORE anything is written ***',
    messy.plan.problems.some((p) => p.line === 4 && /needed/.test(p.reason)),
    messy.plan.problems.map((p) => `${p.line}:${p.reason}`).join(' | '),
  )
  ok(
    '  the same path twice in one file is refused by name',
    messy.plan.problems.some((p) => /line 3 of this file/.test(p.reason)),
    messy.plan.problems.map((p) => p.reason).join(' | '),
  )
  ok(
    '  a colour in the wrong notation is refused with what to write',
    messy.plan.problems.some((p) => /#2f6fed/.test(p.reason)),
    messy.plan.problems.map((p) => p.reason).join(' | '),
  )
  ok('  the row that could import did', messy.totals.created >= 1, JSON.stringify(messy.totals))

  // ── The walker itself ─────────────────────────────────────────────────
  console.log('\n── ensureDepartmentPath')

  const fresh = await departmentSpec.loadLookups(SITE)
  const walk1 = await ensureDepartmentPath(SITE, fresh, `Walk ${stamp} ${S} One ${S} Two`)
  ok('*** a three-level path creates three ***', walk1.ok && walk1.created.length === 3, JSON.stringify(walk1))

  const walk2 = await ensureDepartmentPath(SITE, fresh, `Walk ${stamp} ${S} One ${S} Three`)
  ok('  a sibling reuses both ancestors', walk2.ok && walk2.created.length === 1, JSON.stringify(walk2))

  const walk3 = await ensureDepartmentPath(SITE, fresh, `walk ${stamp} ${S} ONE ${S} two`)
  ok(
    '*** case-only difference matches, it does not duplicate ***',
    walk3.ok && walk1.ok && walk3.id === walk1.id,
    JSON.stringify(walk3),
  )

  // A bare name shared by two branches cannot be resolved. The departments spec
  // matches on the whole path, so the refusal it needs is the one the PRODUCT
  // side asks for — departmentPath() — reading a freshly loaded tree.
  await ensureDepartmentPath(SITE, fresh, `Amb ${stamp} A ${S} Shared${stamp}`)
  await ensureDepartmentPath(SITE, fresh, `Amb ${stamp} B ${S} Shared${stamp}`)

  const reloaded = await departmentSpec.loadLookups(SITE)
  ok(
    '  a name under two parents is recorded as ambiguous',
    reloaded.departmentAmbiguous.has(`SHARED${stamp}`),
    [...reloaded.departmentAmbiguous].filter((v) => v.includes(String(stamp))).join(', '),
  )

  const bare = departmentPath<{ departmentPath?: string }>({
    key: 'departmentPath', label: 'Department', aliases: ['Department'],
  }).parse({ text: `Shared${stamp}`, line: 2 }, reloaded)
  ok(
    '*** a bare name two branches share is refused, not guessed ***',
    bare.kind === 'problem' && /more than one/i.test(bare.reason),
    JSON.stringify(bare),
  )

  const full = departmentPath<{ departmentPath?: string }>({
    key: 'departmentPath', label: 'Department', aliases: ['Department'],
  }).parse({ text: `Amb ${stamp} A ${S} Shared${stamp}`, line: 3 }, reloaded)
  ok('  and the full path resolves it', full.kind === 'value', JSON.stringify(full))

  // ── merge helpers ─────────────────────────────────────────────────────
  console.log('\n── mergeForUpdate')

  const stored = { code: 'A1', name: 'Stored', cost: 12.5, barcode: '600123' }
  const overlaid = mergeForUpdate(stored, { name: 'From file' }, new Set(['name']))
  ok('the mapped field changes', overlaid.name === 'From file')
  ok('*** an unmapped field keeps its stored value ***', overlaid.cost === 12.5, String(overlaid.cost))
  ok('  including one the file never mentioned', overlaid.barcode === '600123')

  const blanked = mergeForUpdate(stored, { barcode: null }, new Set(['barcode']))
  ok('a field that opted into clearing does clear', blanked.barcode === null)

  const untouched = mergeForUpdate(stored, {}, new Set(['barcode']))
  ok(
    '*** a mapped column with a blank cell leaves the value alone ***',
    untouched.barcode === '600123',
    String(untouched.barcode),
  )

  ok('fileSpeaksTo sees a mapped key', fileSpeaksTo(new Set(['supplierCode']), 'supplierCode'))
  ok(
    '*** and refuses a replace when the file never mentioned it ***',
    !fileSpeaksTo(new Set(['code', 'description']), 'supplierCode', 'supplierCost'),
  )

  // ── Suppliers: the update rule on a real entity ───────────────────────
  console.log('\n── Suppliers')

  const sup = await runFile(
    supplierSpec,
    [
      'Supplier Code,Supplier Name,Contact,Email,Payment Terms,Lead Time,Category',
      `IMPS${stamp},"Acme Trading, Ltd",Jane Dlamini,orders@acme.co.za,45,7,Groceries`,
      `IMPT${stamp},Beta Wholesale,,beta@example.com,30,3,Groceries`,
    ].join('\n'),
  )
  ok('*** suppliers import ***', sup.totals.created === 2, JSON.stringify(sup.totals))
  ok('  nothing was refused', sup.plan.problems.length === 0, JSON.stringify(sup.plan.problems))

  const acme = await siteQueryOne<RowDataPacket & {
    id: number; name: string; contact_name: string; payment_terms_days: number
    lead_time_days: number; category: string; email: string
  }>(SITE, 'SELECT * FROM suppliers WHERE code = ?', [`IMPS${stamp}`])

  ok(
    '*** the quoted comma survived into the name ***',
    acme?.name === 'Acme Trading, Ltd',
    String(acme?.name),
  )
  ok('  terms were read as a number', Number(acme?.payment_terms_days) === 45, String(acme?.payment_terms_days))

  // THE test this whole design exists for: a two-column file must not blank
  // every field it does not mention.
  const partialSup = await runFile(
    supplierSpec,
    ['Supplier Code,Payment Terms', `IMPS${stamp},60`].join('\n'),
    'update',
  )
  ok('*** a two-column file updates ***', partialSup.totals.updated === 1, JSON.stringify(partialSup.totals))

  const afterPartial = await siteQueryOne<RowDataPacket & {
    name: string; contact_name: string; payment_terms_days: number
    lead_time_days: number; category: string; email: string
  }>(SITE, 'SELECT * FROM suppliers WHERE code = ?', [`IMPS${stamp}`])

  ok('  the mapped column changed', Number(afterPartial?.payment_terms_days) === 60, String(afterPartial?.payment_terms_days))
  ok('*** the unmapped NAME was not blanked ***', afterPartial?.name === 'Acme Trading, Ltd', String(afterPartial?.name))
  ok('*** the unmapped CONTACT was not blanked ***', afterPartial?.contact_name === 'Jane Dlamini', String(afterPartial?.contact_name))
  ok('*** the unmapped EMAIL was not blanked ***', afterPartial?.email === 'orders@acme.co.za', String(afterPartial?.email))
  ok('*** the unmapped LEAD TIME was not zeroed ***', Number(afterPartial?.lead_time_days) === 7, String(afterPartial?.lead_time_days))
  ok('*** the unmapped CATEGORY was not blanked ***', afterPartial?.category === 'Groceries', String(afterPartial?.category))

  // Cross-field validation, before anything is written.
  const badStatus = await runFile(
    supplierSpec,
    ['Supplier Code,Supplier Name,Status', `IMPU${stamp},Gamma,On hold`].join('\n'),
  )
  ok(
    '*** a non-active account with no reason is refused at review ***',
    badStatus.plan.problems.some((p) => /reason/i.test(p.reason)),
    badStatus.plan.problems.map((p) => p.reason).join(' | '),
  )
  ok('  and nothing was written', badStatus.totals.created === 0)

  // ── Customers: the price-list trap ────────────────────────────────────
  console.log('\n── Customers')

  const cust = await runFile(
    customerSpec,
    [
      'Customer Code,Customer Name,Email,Credit Limit,Terms',
      `IMPC${stamp},"Smith, T (Pty) Ltd",accounts@smith.co.za,"R 10 000.00",30`,
    ].join('\n'),
  )
  ok('*** customers import ***', cust.totals.created === 1, JSON.stringify(cust.totals))

  const smith = await siteQueryOne<RowDataPacket & {
    id: number; name: string; credit_limit: string
  }>(SITE, 'SELECT * FROM customers WHERE code = ?', [`IMPC${stamp}`])
  ok('  the quoted comma survived', smith?.name === 'Smith, T (Pty) Ltd', String(smith?.name))
  ok('  a formatted rand amount read as a number', Number(smith?.credit_limit) === 10000, String(smith?.credit_limit))

  const noGroup = await runFile(
    customerSpec,
    ['Customer Code,Customer Name,Price List', `IMPD${stamp},Nope Ltd,No Such Group`].join('\n'),
  )
  ok(
    '*** an unknown price list is refused, not silently retail ***',
    noGroup.plan.problems.some((p) => /customer group/i.test(p.reason)),
    noGroup.plan.problems.map((p) => p.reason).join(' | '),
  )
  ok(
    '  and the refusal explains where a price list actually lives',
    noGroup.plan.problems.some((p) => /group, not the account/i.test(p.reason)),
    noGroup.plan.problems.map((p) => p.reason).join(' | '),
  )
  ok(
    '  unresolved values are grouped for the review screen',
    noGroup.plan.unresolved.some((u) => u.kind === 'customerGroup' && u.values[0].value === 'No Such Group'),
    JSON.stringify(noGroup.plan.unresolved),
  )

  // ── Products: four writes, and the one that must not run ──────────────
  console.log('\n── Products')

  const prodLookups = await productSpec.loadLookups(SITE)
  const prodFields = fieldsFor(productSpec, prodLookups)

  const priceCols = prodFields.filter((f) => f.key.startsWith('price:'))
  const minCols = prodFields.filter((f) => f.key.startsWith('min:'))
  ok('*** a price column exists per price list ***', priceCols.length >= 1, `${priceCols.length} price columns`)
  ok('  and a min/max pair per location', minCols.length >= 1, `${minCols.length} min columns`)

  const firstPrice = priceCols[0]
  const firstMin = minCols[0]
  const structureId = Number(firstPrice.key.slice('price:'.length))
  const locationId = Number(firstMin.key.slice('min:'.length))

  const prod = await runFile(
    productSpec,
    [
      `Product Code,Description,Barcode,Cost,Department,Supplier,${firstPrice.aliases[0]},${firstMin.aliases[0]}`,
      `IMPP${stamp},Coca-Cola 2L,5449000000996,12.50,Imp ${stamp} ${S} Cold Drinks,IMPS${stamp},24.99,6`,
    ].join('\n'),
  )
  ok('*** a product imports ***', prod.totals.created === 1, JSON.stringify(prod.totals))
  ok('  with no refusals', prod.plan.problems.length === 0, JSON.stringify(prod.plan.problems))
  ok('  and nothing was left half-written', prod.totals.partial === 0, JSON.stringify(prod.totals.problems))

  const made = await siteQueryOne<RowDataPacket & {
    id: number; description: string; barcode: string; last_cost: string; department_id: number
  }>(SITE, 'SELECT * FROM products WHERE code = ?', [`IMPP${stamp}`])
  ok('  the barcode survived Excel', made?.barcode === '5449000000996', String(made?.barcode))
  ok('  the department was created on the way in', Number(made?.department_id) > 0, String(made?.department_id))

  const madePrice = await siteQueryOne<RowDataPacket & { selling_price_incl: string }>(
    SITE,
    'SELECT selling_price_incl FROM product_prices WHERE product_id = ? AND price_structure_id = ?',
    [made?.id, structureId],
  )
  ok('*** the selling price was written ***', Number(madePrice?.selling_price_incl) === 24.99, String(madePrice?.selling_price_incl))

  const madeLevel = await siteQueryOne<RowDataPacket & { min_stock: string; max_stock: string }>(
    SITE,
    'SELECT min_stock, max_stock FROM product_location_stock WHERE product_id = ? AND location_id = ?',
    [made?.id, locationId],
  )
  ok('*** the reorder level went to the right location ***', Number(madeLevel?.min_stock) === 6, String(madeLevel?.min_stock))

  const madeLink = await siteQueryOne<RowDataPacket & { supplier_id: number; is_preferred: number }>(
    SITE,
    'SELECT supplier_id, is_preferred FROM product_suppliers WHERE product_id = ?',
    [made?.id],
  )
  ok('*** the supplier link was made ***', Number(madeLink?.supplier_id) > 0, String(madeLink?.supplier_id))

  // A partial file: the single most destructive thing this design prevents.
  const partialProd = await runFile(
    productSpec,
    ['Product Code,' + firstPrice.aliases[0], `IMPP${stamp},29.99`].join('\n'),
    'update',
  )
  ok('*** a code-and-price file updates ***', partialProd.totals.updated === 1, JSON.stringify(partialProd.totals))

  const afterProd = await siteQueryOne<RowDataPacket & {
    description: string; barcode: string; last_cost: string; department_id: number
    weight_description: string; visible_in_pos: number; pack_description: string
  }>(SITE, 'SELECT * FROM products WHERE code = ?', [`IMPP${stamp}`])

  const newPrice = await siteQueryOne<RowDataPacket & { selling_price_incl: string }>(
    SITE,
    'SELECT selling_price_incl FROM product_prices WHERE product_id = ? AND price_structure_id = ?',
    [made?.id, structureId],
  )
  ok('  the price changed', Number(newPrice?.selling_price_incl) === 29.99, String(newPrice?.selling_price_incl))
  ok('*** the unmapped COST was not zeroed ***', Number(afterProd?.last_cost) === 12.5, String(afterProd?.last_cost))
  ok('*** the unmapped BARCODE was not cleared ***', afterProd?.barcode === '5449000000996', String(afterProd?.barcode))
  ok('*** the unmapped DEPARTMENT was not cleared ***', Number(afterProd?.department_id) > 0, String(afterProd?.department_id))
  ok('*** the DESCRIPTION survived ***', afterProd?.description === 'Coca-Cola 2L', String(afterProd?.description))
  ok(
    '*** a property flag the import never mentioned kept its value ***',
    afterProd?.weight_description === made?.weight_description,
    `${afterProd?.weight_description} vs ${made?.weight_description}`,
  )

  // The guard that matters most: a file with no supplier column must not strip
  // the supplier link, because saveProductSuppliers replaces the whole set.
  const stillLinked = await siteQueryOne<RowDataPacket & { n: number }>(
    SITE,
    'SELECT COUNT(*) AS n FROM product_suppliers WHERE product_id = ?',
    [made?.id],
  )
  ok(
    '*** a file with no supplier column did NOT strip the supplier link ***',
    Number(stillLinked?.n) === 1,
    String(stillLinked?.n),
  )

  // The levels equivalent: naming only a minimum must not zero the maximum.
  await siteExecute(
    SITE,
    'UPDATE product_location_stock SET max_stock = 99 WHERE product_id = ? AND location_id = ?',
    [made?.id, locationId],
  )
  await runFile(
    productSpec,
    ['Product Code,' + firstMin.aliases[0], `IMPP${stamp},8`].join('\n'),
    'update',
  )
  const afterLevel = await siteQueryOne<RowDataPacket & { min_stock: string; max_stock: string }>(
    SITE,
    'SELECT min_stock, max_stock FROM product_location_stock WHERE product_id = ? AND location_id = ?',
    [made?.id, locationId],
  )
  ok('  a min-only file set the minimum', Number(afterLevel?.min_stock) === 8, String(afterLevel?.min_stock))
  ok(
    '*** and did NOT reset the maximum to "no ceiling" ***',
    Number(afterLevel?.max_stock) === 99,
    String(afterLevel?.max_stock),
  )

  // Opening stock on an existing product is refused out loud, not ignored.
  const restock = await runFile(
    productSpec,
    ['Product Code,Opening Stock', `IMPP${stamp},500`].join('\n'),
    'update',
  )
  ok(
    '*** opening stock on an existing product is reported, not silently dropped ***',
    restock.totals.partial === 1 &&
      restock.totals.problems.some((p) => p.warnings?.some((w) => /stock take|adjustment/i.test(w.reason))),
    JSON.stringify(restock.totals.problems),
  )

  // An unknown supplier stops the row rather than making a supplier-less product.
  const badSupplier = await runFile(
    productSpec,
    ['Product Code,Description,Supplier', `IMPQ${stamp},Orphan,NOSUCHSUP${stamp}`].join('\n'),
  )
  ok(
    '*** an unknown supplier code refuses the row ***',
    badSupplier.totals.failed === 1 &&
      badSupplier.totals.problems.some((p) => /Import suppliers first/i.test(p.reason ?? '')),
    JSON.stringify(badSupplier.totals.problems),
  )

  const orphan = await siteQueryOne<RowDataPacket & { n: number }>(
    SITE, 'SELECT COUNT(*) AS n FROM products WHERE code = ?', [`IMPQ${stamp}`],
  )
  ok('  and no half-made product was left behind', Number(orphan?.n) === 0, String(orphan?.n))

  // An unknown brand is refused too — three spellings would be three brands.
  const badBrand = await runFile(
    productSpec,
    ['Product Code,Description,Brand', `IMPR${stamp},Thing,No Such Brand`].join('\n'),
  )
  ok(
    '*** an unknown brand is refused rather than created ***',
    badBrand.plan.problems.some((p) => /brand/i.test(p.reason)),
    badBrand.plan.problems.map((p) => p.reason).join(' | '),
  )

  // ── The template round trip ───────────────────────────────────────────
  console.log('\n── The template imports back into itself')

  const template = templateCsv(deptFields, departmentSpec.title)
  const templateRead = readCsv(template.body, aliases)
  ok('*** the generated template is readable by its own importer ***', templateRead.ok)
  if (templateRead.ok) {
    const templateMap = autoMap(templateRead.sheet.headers, deptFields)
    ok(
      '  and every column maps, with nothing left for the user to fix',
      deptFields.every((f) => templateMap[f.key] != null),
      JSON.stringify(templateMap),
    )
    ok('  missingRequired is clean', missingRequired(deptFields, templateMap).length === 0)
  }

  // ── Tidy up ───────────────────────────────────────────────────────────
  // Strictly in reference order: a department cannot go while a product points
  // at it, and a supplier cannot go while a product_suppliers row names it.
  // Anything left behind sits in a real site's tree and fails the NEXT run's
  // "created once" count, so the teardown is as deliberate as the test.
  const madeProducts = await siteQuery<RowDataPacket & { id: number }>(
    SITE, 'SELECT id FROM products WHERE code LIKE ?', [`IMP_${stamp}`],
  )
  for (const p of madeProducts) {
    await siteExecute(SITE, 'DELETE FROM product_suppliers WHERE product_id = ?', [p.id]).catch(() => {})
    await siteExecute(SITE, 'DELETE FROM product_prices WHERE product_id = ?', [p.id]).catch(() => {})
    await siteExecute(SITE, 'DELETE FROM stock_movements WHERE product_id = ?', [p.id]).catch(() => {})
    await siteExecute(SITE, 'DELETE FROM product_location_stock WHERE product_id = ?', [p.id]).catch(() => {})
    await siteExecute(SITE, 'DELETE FROM products WHERE id = ?', [p.id]).catch(() => {})
  }

  await siteExecute(SITE, 'DELETE FROM suppliers WHERE code LIKE ?', [`IMP_${stamp}`]).catch(() => {})
  await siteExecute(SITE, 'DELETE FROM customers WHERE code LIKE ?', [`IMP_${stamp}`]).catch(() => {})

  const created = (await listDepartments(SITE, true)).filter(
    (d) =>
      d.name.includes(String(stamp)) ||
      ['Fruit', 'Citrus', 'Berries', 'Veg', 'One', 'Two', 'Three', 'New', 'Cold Drinks'].includes(d.name),
  )
  // Deepest first, because a parent with children RESTRICTs. Several passes:
  // a parent only becomes deletable once its children have gone, and id order
  // does not always match tree depth.
  created.sort((a, b) => b.id - a.id)
  for (let pass = 0; pass < 5; pass++) {
    for (const dept of created) {
      await siteExecute(SITE, 'DELETE FROM departments WHERE id = ?', [dept.id]).catch(() => {})
    }
  }

  const leftovers = await siteQueryOne<RowDataPacket & { n: number }>(
    SITE,
    'SELECT COUNT(*) AS n FROM departments WHERE name LIKE ?',
    [`%${stamp}%`],
  )
  ok('test departments cleaned up', Number(leftovers?.n ?? 0) === 0, String(leftovers?.n))

  const partyLeft = await siteQueryOne<RowDataPacket & { n: number }>(
    SITE,
    `SELECT (SELECT COUNT(*) FROM suppliers WHERE code LIKE ?)
          + (SELECT COUNT(*) FROM customers WHERE code LIKE ?)
          + (SELECT COUNT(*) FROM products  WHERE code LIKE ?) AS n`,
    [`IMP_${stamp}`, `IMP_${stamp}`, `IMP_${stamp}`],
  )
  ok('test records cleaned up', Number(partyLeft?.n ?? 0) === 0, String(partyLeft?.n))

  console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
