/**
 * Instructions, end to end against a live site database.
 *
 * The questions a till asks, what the answers cost, what they take off the
 * shelf, and the two guards that stop a shop configuring something a cashier
 * cannot answer.
 *
 *   npm run test:instructions
 */
import { siteQuery, siteQueryOne, siteExecute } from '../src/lib/siteDb'
import {
  createGroup,
  updateGroup,
  deleteGroup,
  replaceOptions,
  listOptions,
  setGroupsForProduct,
  setGroupOrder,
  listGroups,
  validateOption,
  readInstructionLibrary,
} from '../src/lib/site/instructions'
import { saveDraft, getDocument } from '../src/lib/site/salesDocuments'
import { finaliseDocument } from '../src/lib/site/salesPosting'
import { checkPricing } from '../src/lib/site/priceGuard'
import { NO_CAPABILITIES } from '../src/lib/site/permissions'
import { seedOpeningStock, reconcileStock } from '../src/lib/site/stockMovements'
import { getTenderByCode } from '../src/lib/site/tenderTypes'
import {
  adjustPerUnit,
  askedGroups,
  validateSelection,
  describeSelection,
  pruneUnasked,
  type ChosenOption,
} from '../src/lib/instructionRules'
import { toNum } from '../src/lib/decimals'

const SITE = 1
const actor = { userId: 1, userName: 'Instructions Test' }
let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

async function stockOf(productId: number): Promise<number> {
  const row = await siteQueryOne<{ stock_on_hand: string }>(
    SITE,
    'SELECT stock_on_hand FROM products WHERE id = ?',
    [productId],
  )
  return toNum(row?.stock_on_hand)
}

async function main() {
  const stamp = Date.now().toString().slice(-8)
  const vat = await siteQueryOne<{ id: number; rate: string }>(
    SITE,
    "SELECT id, rate FROM vat_rates WHERE vat_type='sales' AND is_default=1 LIMIT 1",
  )
  const vatRate = toNum(vat?.rate, 15)

  const mk = async (suffix: string, type: string, onHand: number, cost: number) => {
    const res = await siteExecute(
      SITE,
      `INSERT INTO products (code, description, product_type, stock_on_hand, average_cost, last_cost, selling_vat_rate_id)
       VALUES (?,?,?,?,?,?,?)`,
      [
        `INS${stamp}${suffix}`,
        `Instr ${suffix} ${stamp}`,
        type,
        onHand.toFixed(3),
        cost.toFixed(4),
        cost.toFixed(4),
        vat?.id ?? null,
      ],
    )
    return res.insertId
  }

  const burgerId = await mk('B', 'normal', 100, 20)
  const baconId = await mk('X', 'normal', 100, 3)
  const serialId = await mk('S', 'serial', 10, 5)

  await seedOpeningStock(SITE, actor)

  /* ── 1. Per-option bounds are validated ──────────────────────────────── */

  ok(
    'min above max is refused',
    validateOption({ name: 'x', minQty: 3, maxQty: 2 }) !== null,
    validateOption({ name: 'x', minQty: 3, maxQty: 2 }) ?? '',
  )
  ok(
    'min above max is FINE when max is 0 (no ceiling)',
    validateOption({ name: 'x', minQty: 3, maxQty: 0 }) === null,
  )
  ok(
    'a preselected count above the maximum is refused',
    validateOption({ name: 'x', maxQty: 2, defaultQty: 5 }) !== null,
  )
  ok('a maximum above 99 is refused', validateOption({ name: 'x', maxQty: 500 }) !== null)

  /* ── 2. A question with a counted answer ─────────────────────────────── */

  const toppings = await createGroup(SITE, {
    name: `Instr toppings ${stamp}`,
    prompt: 'Any toppings?',
    maxChoices: 3,
  })
  if (!toppings.ok) throw new Error(toppings.error)

  const sauce = await createGroup(SITE, {
    name: `Instr sauce ${stamp}`,
    prompt: 'Which sauce?',
    maxChoices: 1,
    isRequired: true,
  })
  if (!sauce.ok) throw new Error(sauce.error)

  const saved = await replaceOptions(SITE, toppings.id, [
    {
      name: 'Extra bacon',
      priceAdjust: 2.5,
      productId: baconId,
      quantity: 0.5,
      maxQty: 3,
      minQty: 1,
      revealsGroupIds: [sauce.id],
    },
    { name: 'No onions', priceAdjust: 0, printsOnReceipt: false },
  ])
  ok('options saved', saved.ok, saved.ok ? '' : saved.error)

  const sauceSaved = await replaceOptions(SITE, sauce.id, [{ name: 'Peri-peri' }])
  ok('sauce option saved', sauceSaved.ok)

  const opts = await listOptions(SITE, toppings.id)
  const bacon = opts.find((o) => o.name === 'Extra bacon')!
  const onions = opts.find((o) => o.name === 'No onions')!
  ok('the counted bounds came back', bacon.maxQty === 3 && bacon.minQty === 1)
  ok('the print flags came back', onions.printsOnKitchen && !onions.printsOnReceipt)
  ok('the reveal came back', bacon.revealsGroupIds.includes(sauce.id))

  /* ── 3. Guards on configuration ──────────────────────────────────────── */

  const serialLink = await replaceOptions(SITE, sauce.id, [
    { name: 'Peri-peri', productId: serialId },
  ])
  ok(
    'an option cannot deduct a serial-tracked product',
    !serialLink.ok,
    serialLink.ok ? '' : serialLink.error,
  )
  // Put it back the way it was.
  await replaceOptions(SITE, sauce.id, [{ name: 'Peri-peri' }])

  const loop = await replaceOptions(SITE, sauce.id, [
    { name: 'Peri-peri', revealsGroupIds: [toppings.id] },
  ])
  ok('a loop of questions is refused', !loop.ok, loop.ok ? '' : loop.error)
  await replaceOptions(SITE, sauce.id, [{ name: 'Peri-peri' }])

  const del = await deleteGroup(SITE, sauce.id)
  ok(
    'a question another answer reveals cannot be deleted',
    !del.ok,
    del.ok ? '' : del.error,
  )

  /* ── 4. The library the till is given ────────────────────────────────── */

  await setGroupsForProduct(SITE, burgerId, [toppings.id])
  const library = await readInstructionLibrary(SITE)
  const shipped = library.groups.filter((g) => g.name.includes(stamp))
  ok(
    'both the asked question and the one it reveals are shipped',
    shipped.length === 2,
    shipped.map((g) => g.name).join(', '),
  )
  ok('the product map points at the question', library.byProduct[burgerId]?.[0] === toppings.id)

  const byId = new Map(library.groups.map((g) => [g.id, g]))

  /* ── 5. The rules, as the till and the server both run them ──────────── */

  const chosenBacon: ChosenOption = {
    groupId: toppings.id,
    groupName: 'toppings',
    optionId: bacon.id,
    optionName: 'Extra bacon',
    qty: 3,
    priceAdjustIncl: 2.5,
    productId: baconId,
    stockQtyPer: 0.5,
    printsOnKitchen: true,
    printsOnReceipt: true,
  }
  const chosenOnions: ChosenOption = {
    groupId: toppings.id,
    groupName: 'toppings',
    optionId: onions.id,
    optionName: 'No onions',
    qty: 1,
    priceAdjustIncl: 0,
    productId: null,
    stockQtyPer: 0,
    printsOnKitchen: true,
    printsOnReceipt: false,
  }

  ok('three rashers price at 3 x 2.50', adjustPerUnit([chosenBacon, chosenOnions]) === 7.5)

  const askedNow = askedGroups([toppings.id], byId, [chosenBacon])
  ok(
    'choosing bacon opens the sauce question',
    askedNow.length === 2 && askedNow.some((g) => g.id === sauce.id),
  )
  ok(
    'not choosing it leaves the sauce question unasked',
    askedGroups([toppings.id], byId, []).length === 1,
  )

  ok(
    'a required revealed question refuses an empty answer',
    validateSelection(askedNow, [chosenBacon]) !== null,
  )
  ok(
    'unchoosing bacon drops the sauce that was chosen under it',
    pruneUnasked(askedGroups([toppings.id], byId, []), [chosenBacon, chosenOnions]).length === 2,
  )

  const overCount = { ...chosenBacon, qty: 9 }
  ok(
    'more than the option allows is refused',
    validateSelection(askedGroups([toppings.id], byId, [overCount]), [overCount]) !== null,
  )

  ok(
    'the receipt leaves out the kitchen-only answer',
    describeSelection([chosenBacon, chosenOnions], 'receipt').join('|') === 'Extra bacon ×3',
  )
  ok(
    'the kitchen ticket keeps both',
    describeSelection([chosenBacon, chosenOnions], 'kitchen').length === 2,
  )

  /* ── 6. The price guard must NOT refuse an ordinary cashier ──────────── */

  const shelf = 20 * (1 + vatRate / 100)
  await siteExecute(
    SITE,
    `INSERT INTO product_prices (product_id, price_structure_id, selling_price_incl)
     SELECT ?, id, ? FROM price_structures ORDER BY id LIMIT 1
     ON DUPLICATE KEY UPDATE selling_price_incl = VALUES(selling_price_incl)`,
    [burgerId, shelf.toFixed(4)],
  )
  const structure = await siteQueryOne<{ id: number }>(
    SITE,
    'SELECT id FROM price_structures ORDER BY id LIMIT 1',
  )

  // A cashier with NEITHER override right — the case that would otherwise kill
  // the whole feature, because every modified line would be refused.
  const cashier = NO_CAPABILITIES
  const built = shelf + 7.5

  const refusedWithout = await checkPricing(SITE, cashier, structure?.id ?? null, [
    { productId: burgerId, description: 'Burger', unitPriceIncl: built },
  ])
  ok(
    'a built price with NO answers declared is still refused',
    refusedWithout !== null,
    refusedWithout ?? '',
  )

  const refusedWith = await checkPricing(SITE, cashier, structure?.id ?? null, [
    {
      productId: burgerId,
      description: 'Burger',
      unitPriceIncl: built,
      instructions: [{ optionId: bacon.id, qty: 3 }],
    },
  ])
  ok(
    '*** the same price WITH its answers is allowed ***',
    refusedWith === null,
    refusedWith ?? '',
  )

  const lying = await checkPricing(SITE, cashier, structure?.id ?? null, [
    {
      productId: burgerId,
      // Claiming the answers justify far more than they do.
      unitPriceIncl: shelf + 500,
      description: 'Burger',
      instructions: [{ optionId: bacon.id, qty: 3 }],
    },
  ])
  ok('a price the answers cannot justify is refused', lying !== null)

  /* ── 7. A posted sale: rows, money and stock ─────────────────────────── */

  const baconBefore = await stockOf(baconId)

  const draft = await saveDraft(SITE, actor, {
    docType: 'invoice',
    lines: [
      {
        productId: burgerId,
        productCode: `INS${stamp}B`,
        description: 'Burger with bacon',
        productType: 'normal',
        // TWO burgers, so the per-item multiply is exercised.
        qty: 2,
        unitPriceIncl: built,
        vatRatePct: vatRate,
        unitCostExcl: 20,
        note: 'no ice',
        instructions: [
          {
            groupId: toppings.id,
            groupName: 'Toppings',
            optionId: bacon.id,
            optionName: 'Extra bacon',
            qty: 3,
            priceAdjustIncl: 2.5,
            productId: baconId,
            stockQtyPer: 0.5,
            printsOnKitchen: true,
            printsOnReceipt: true,
          },
        ],
      },
    ],
  })
  ok('draft saved', draft.ok, draft.ok ? '' : draft.error)
  if (!draft.ok) throw new Error(draft.error)

  const read = await getDocument(SITE, draft.id)
  ok('the answers read back on the line', read?.lines[0].instructions.length === 1)
  ok('the note read back on the line', read?.lines[0].note === 'no ice')
  ok(
    'what it contributed across the line was stored',
    toNum(read?.lines[0].instructions[0].lineAdjustIncl) === 15,
    String(read?.lines[0].instructions[0].lineAdjustIncl),
  )

  // The line total must be the BUILT price, and must not have the adjustment
  // added a second time.
  ok(
    '*** the answers are not charged twice ***',
    Math.abs(toNum(read?.lines[0].lineTotalIncl) - built * 2) < 0.01,
    `line total ${read?.lines[0].lineTotalIncl} vs expected ${(built * 2).toFixed(2)}`,
  )

  const cash = await getTenderByCode(SITE, 'CASH')
  const posted = await finaliseDocument(SITE, actor, {
    documentId: draft.id,
    tenders: [{ tenderTypeId: cash!.id, amount: Math.ceil(built * 2) }],
  })
  ok('posted', posted.ok, posted.ok ? '' : posted.error)

  const baconAfter = await stockOf(baconId)
  ok(
    '*** the answer took its own stock: 2 burgers x 3 rashers x 0.5 = 3 ***',
    Math.abs(baconBefore - baconAfter - 3) < 0.001,
    `${baconBefore} -> ${baconAfter}`,
  )

  const moves = await siteQuery<{ note: string; qty_change: string }>(
    SITE,
    'SELECT note, qty_change FROM stock_movements WHERE product_id = ? ORDER BY id DESC LIMIT 1',
    [baconId],
  )
  ok(
    'the movement names the parent and the answer',
    (moves[0]?.note ?? '').includes('Extra bacon'),
    moves[0]?.note ?? '',
  )

  /*
   * Stock reconciliation, scoped to the products THIS run created.
   *
   * reconcileStock answers for the whole site, and another suite running at the
   * same moment — or one that left a fixture behind — puts its drift in this
   * result too. An unscoped assertion here fails for reasons that have nothing
   * to do with instructions, and the failure looks identical to a real one, so
   * the next person spends their time on the wrong bug.
   *
   * The drift is printed either way: a bare pass/fail on a ledger check is not
   * enough to act on.
   */
  const drift = await reconcileStock(SITE)
  const mine = drift.filter((d) => [burgerId, baconId, serialId].includes(d.productId))
  ok(
    '*** reconcileStock returns ZERO drift for this run ***',
    mine.length === 0,
    mine.length ? JSON.stringify(mine) : `${drift.length} unrelated row(s) elsewhere on the site`,
  )

  /* ── 8. Ordering ─────────────────────────────────────────────────────── */

  const ordered = await setGroupOrder(SITE, [sauce.id, toppings.id])
  ok('the library order saved', ordered.ok)
  const listed = (await listGroups(SITE, true)).filter((g) => g.name.includes(stamp))
  ok(
    'and it is the order the library lists in',
    listed[0]?.id === sauce.id && listed[1]?.id === toppings.id,
  )
  ok('the same id twice is refused', !(await setGroupOrder(SITE, [sauce.id, sauce.id])).ok)

  /* ── 9. Clean up ─────────────────────────────────────────────────────── */
  //
  // Litter here is not harmless: a leaked group on a UNIQUE name, or a product
  // left behind, makes an unrelated suite fail before its first assertion.
  await siteExecute(SITE, 'DELETE FROM product_instruction_groups WHERE product_id = ?', [burgerId])
  await updateGroup(SITE, toppings.id, { name: `Instr toppings ${stamp}` })
  await siteExecute(SITE, 'DELETE FROM instruction_option_reveals WHERE group_id = ?', [sauce.id])
  await siteExecute(SITE, 'DELETE FROM instruction_options WHERE group_id IN (?,?)', [
    toppings.id,
    sauce.id,
  ])
  await siteExecute(SITE, 'DELETE FROM instruction_groups WHERE id IN (?,?)', [
    toppings.id,
    sauce.id,
  ])

  const leftGroups = await siteQuery<{ n: number }>(
    SITE,
    'SELECT COUNT(*) AS n FROM instruction_groups WHERE name LIKE ?',
    [`%${stamp}%`],
  )
  ok('no instruction litter left behind', Number(leftGroups[0]?.n ?? 0) === 0)

  /*
   * The fixture products too, where they can go.
   *
   * The burger cannot: it has a POSTED sale against it, and sales_document_lines
   * holds product_id ON DELETE SET NULL, so removing it would silently blank the
   * product off a real invoice line. That one is left in place deliberately —
   * exactly as test-sales-posting leaves its own — and the delete is allowed to
   * fail rather than being forced.
   */
  for (const id of [baconId, serialId, burgerId]) {
    await siteExecute(SITE, 'DELETE FROM products WHERE id = ?', [id]).catch(() => {})
  }

  console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
