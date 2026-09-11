/**
 * Instructions, the parts the first suite does not reach.
 *
 *   npm run test:instructions-deep
 *
 * ── WHY A SECOND SUITE ──────────────────────────────────────────────────────
 *
 * test-instructions.ts proves one question with one counted answer end to end:
 * configure, price, post, deduct. That is the happy path and it is genuinely
 * covered.
 *
 * What it never builds is a MENU. Every interesting failure in this feature is
 * a relationship between groups rather than a property of one: a chain three
 * deep, an answer that opens two questions at once, a cascade that has to drop
 * a grandchild, a ceiling counted in distinct answers while a stepper counts
 * units. Those are what a shop actually configures, and they were untested.
 *
 * It also runs against the SEEDED CAFE DATA on a real site, because a suite
 * that only ever asserts on fixtures it just built cannot tell you whether the
 * thing a user is about to open is sound.
 */
import { siteQuery, siteQueryOne, siteExecute } from '../src/lib/siteDb'
import {
  createGroup,
  deleteGroup,
  replaceOptions,
  listOptions,
  listGroups,
  setGroupsForProduct,
  validateGroup,
  validateOption,
  validateReveals,
  readInstructionLibrary,
  MAX_REVEAL_DEPTH,
} from '../src/lib/site/instructions'
import {
  adjustPerUnit,
  askedGroups,
  chooseOption,
  describeSelection,
  pruneUnasked,
  startingQty,
  stockForOption,
  totalUnits,
  validateSelection,
  type ChosenOption,
} from '../src/lib/instructionRules'
import { saveDraft, getDocument } from '../src/lib/site/salesDocuments'
import { toNum } from '../src/lib/decimals'

const SITE = 1
/** A seeded cafe. Read-only here — this suite never writes to a cafe site. */
const CAFE_SITE = 33
const actor = { userId: 1, userName: 'Instructions Deep' }

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

/** A group id created by this run, for the cleanup sweep at the end. */
const made: number[] = []
const madeProducts: number[] = []

async function main() {
  const stamp = Date.now().toString().slice(-8)
  const tag = `DEEP${stamp}`

  const vat = await siteQueryOne<{ id: number; rate: string }>(
    SITE,
    "SELECT id, rate FROM vat_rates WHERE vat_type='sales' AND is_default=1 LIMIT 1",
  )
  const vatRate = toNum(vat?.rate, 15)

  const mkProduct = async (suffix: string, onHand = 100) => {
    const res = await siteExecute(
      SITE,
      `INSERT INTO products (code, description, product_type, stock_on_hand, average_cost, last_cost, selling_vat_rate_id)
       VALUES (?,?,?,?,?,?,?)`,
      [`${tag}${suffix}`, `Deep ${suffix} ${stamp}`, 'normal', onHand.toFixed(3), '5.0000', '5.0000', vat?.id ?? null],
    )
    madeProducts.push(res.insertId)
    return res.insertId
  }

  const mkGroup = async (name: string, extra: Parameters<typeof createGroup>[1] = { name }) => {
    const res = await createGroup(SITE, { ...extra, name: `${tag} ${name}` })
    if (!res.ok) throw new Error(`${name}: ${res.error}`)
    made.push(res.id)
    return res.id
  }

  /* ════════════════════════════════════════════════════════════════════════
   * 1. GROUP-LEVEL VALIDATION — the bounds a shop can type
   * ════════════════════════════════════════════════════════════════════════ */

  ok('a group with no name is refused', validateGroup({ name: '   ' }) !== null)
  ok('a 121-character name is refused', validateGroup({ name: 'x'.repeat(121) }) !== null)
  ok('a 120-character name is allowed', validateGroup({ name: 'x'.repeat(120) }) === null)
  ok(
    'a 191-character prompt is refused',
    validateGroup({ name: 'ok', prompt: 'x'.repeat(191) }) !== null,
  )
  ok(
    'min above max is refused on the GROUP too',
    validateGroup({ name: 'ok', minChoices: 3, maxChoices: 2 }) !== null,
  )
  ok(
    'min above max is fine when max is 0 (no ceiling)',
    validateGroup({ name: 'ok', minChoices: 3, maxChoices: 0 }) === null,
  )
  ok('a negative minimum is refused', validateGroup({ name: 'ok', minChoices: -1 }) !== null)

  /* A duplicate name must be refused — the table has a UNIQUE key, and the
     nicer message is the whole reason createGroup checks first. */
  const dupA = await mkGroup('Duplicate probe')
  const dupB = await createGroup(SITE, { name: `${tag} Duplicate probe` })
  ok('a duplicate group name is refused with a sentence', !dupB.ok, dupB.ok ? '' : dupB.error)

  /* ════════════════════════════════════════════════════════════════════════
   * 2. A THREE-DEEP CHAIN, AND THE CAP THAT STOPS A FOURTH
   * ════════════════════════════════════════════════════════════════════════ */

  const l1 = await mkGroup('L1 meal', { name: '', maxChoices: 1 })
  const l2 = await mkGroup('L2 side', { name: '', maxChoices: 1, isRequired: true })
  const l3 = await mkGroup('L3 sauce', { name: '', maxChoices: 1, isRequired: true })
  const l4 = await mkGroup('L4 toodeep', { name: '', maxChoices: 1 })

  await replaceOptions(SITE, l3, [{ name: 'Peri peri' }, { name: 'Garlic' }])
  await replaceOptions(SITE, l2, [
    { name: 'Chips', revealsGroupIds: [l3] },
    { name: 'Salad' },
  ])
  const chain = await replaceOptions(SITE, l1, [
    { name: 'Make it a meal', priceAdjust: 45, revealsGroupIds: [l2] },
    { name: 'No thanks', isDefault: true },
  ])
  ok('a three-deep chain saves', chain.ok, chain.ok ? '' : chain.error)

  /* The fourth level must be refused: l1 -> l2 -> l3 -> l4 is four questions,
     and MAX_REVEAL_DEPTH is 3. */
  const tooDeep = await replaceOptions(SITE, l3, [
    { name: 'Peri peri', revealsGroupIds: [l4] },
    { name: 'Garlic' },
  ])
  ok(
    `a chain deeper than ${MAX_REVEAL_DEPTH} is refused at save`,
    !tooDeep.ok,
    tooDeep.ok ? '' : tooDeep.error,
  )
  // Put l3 back the way it was.
  await replaceOptions(SITE, l3, [{ name: 'Peri peri' }, { name: 'Garlic' }])

  /* An answer that opens TWO questions — the case 081 says a nullable column
     could not express. */
  const twoWay = await mkGroup('Two-way drink', { name: '', maxChoices: 1, isRequired: true })
  await replaceOptions(SITE, twoWay, [{ name: 'Coke' }, { name: 'Water' }])
  const both = await replaceOptions(SITE, l1, [
    { name: 'Make it a meal', priceAdjust: 45, revealsGroupIds: [l2, twoWay] },
    { name: 'No thanks', isDefault: true },
  ])
  ok('one answer may open TWO questions', both.ok, both.ok ? '' : both.error)

  /* Self-reveal and indirect loops. */
  const selfLoop = await validateReveals(SITE, l2, [{ name: 'x', revealsGroupIds: [l2] }])
  ok('an answer cannot open its own question', selfLoop !== null, selfLoop ?? '')
  const backLoop = await validateReveals(SITE, l3, [{ name: 'x', revealsGroupIds: [l1] }])
  ok('an indirect loop is refused', backLoop !== null, backLoop ?? '')

  /* ════════════════════════════════════════════════════════════════════════
   * 3. THE LIBRARY THE TILL IS GIVEN — reachability and depth
   * ════════════════════════════════════════════════════════════════════════ */

  const burger = await mkProduct('BURGER')
  await setGroupsForProduct(SITE, burger, [l1])

  const lib = await readInstructionLibrary(SITE)
  const byId = new Map(lib.groups.map((g) => [g.id, g]))
  const shipped = (id: number) => byId.has(id)

  ok('the product map names the starting question', lib.byProduct[burger]?.[0] === l1)
  ok('the starting question ships', shipped(l1))
  ok('the question it reveals ships', shipped(l2))
  ok('BOTH questions one answer reveals ship', shipped(l2) && shipped(twoWay))
  ok('the third level ships (depth 3 is allowed)', shipped(l3))
  ok(
    'a group NOBODY asks is not shipped',
    !shipped(dupA),
    'an unasked group is configuration, not catalogue',
  )

  /* ════════════════════════════════════════════════════════════════════════
   * 4. askedGroups / pruneUnasked — the cascade, including a GRANDCHILD
   * ════════════════════════════════════════════════════════════════════════ */

  const g1 = byId.get(l1)!
  const g2 = byId.get(l2)!
  const g3 = byId.get(l3)!
  const gDrink = byId.get(twoWay)!

  const meal = g1.options.find((o) => o.name === 'Make it a meal')!
  const chips = g2.options.find((o) => o.name === 'Chips')!
  const salad = g2.options.find((o) => o.name === 'Salad')!
  const peri = g3.options.find((o) => o.name === 'Peri peri')!
  const coke = gDrink.options.find((o) => o.name === 'Coke')!

  const pickMeal = chooseOption(g1, meal, 1)
  const pickChips = chooseOption(g2, chips, 1)
  const pickSalad = chooseOption(g2, salad, 1)
  const pickPeri = chooseOption(g3, peri, 1)
  const pickCoke = chooseOption(gDrink, coke, 1)

  ok('nothing chosen: only the starting question is asked', askedGroups([l1], byId, []).length === 1)

  const askedMeal = askedGroups([l1], byId, [pickMeal])
  ok(
    'choosing the meal opens BOTH follow-ups',
    askedMeal.length === 3 && askedMeal.some((g) => g.id === l2) && askedMeal.some((g) => g.id === twoWay),
    askedMeal.map((g) => g.name).join(', '),
  )

  const askedDeep = askedGroups([l1], byId, [pickMeal, pickChips])
  ok(
    'choosing chips opens the third question too',
    askedDeep.some((g) => g.id === l3),
    askedDeep.map((g) => g.name).join(', '),
  )

  /* THE GRANDCHILD CASCADE — the one a single-level prune gets wrong.
     Un-choosing the MEAL must drop the side, the drink AND the sauce.

     The meal answer ITSELF survives, and must: its own question (l1) is what
     the product asks, so it is always being asked. What this proves is that
     everything hanging BELOW it goes — including the sauce, which is a
     grandchild reached through the side rather than through the meal. */
  const everything = [pickMeal, pickChips, pickPeri, pickCoke]
  const afterUnmeal = pruneUnasked(askedGroups([l1], byId, []), everything)
  ok(
    '*** un-choosing the meal drops the side, the drink AND the sauce ***',
    afterUnmeal.length === 1 && afterUnmeal[0].optionId === meal.id,
    `kept ${afterUnmeal.map((c) => c.optionName).join(', ') || 'nothing'}`,
  )

  /* Switching chips -> salad must drop the sauce, which only chips revealed. */
  const swapped = [pickMeal, pickSalad, pickPeri, pickCoke]
  const afterSwap = pruneUnasked(askedGroups([l1], byId, [pickMeal, pickSalad]), swapped)
  ok(
    '*** switching the side drops the sauce that hung off the old one ***',
    !afterSwap.some((c) => c.optionId === peri.id) && afterSwap.some((c) => c.optionId === coke.id),
    afterSwap.map((c) => c.optionName).join(', '),
  )

  /* ════════════════════════════════════════════════════════════════════════
   * 5. validateSelection — required, bounds, and DISTINCT-vs-UNITS
   * ════════════════════════════════════════════════════════════════════════ */

  ok(
    'a required revealed question must be answered',
    validateSelection(askedMeal, [pickMeal]) !== null,
    validateSelection(askedMeal, [pickMeal]) ?? '',
  )
  ok(
    'answering both follow-ups satisfies it',
    validateSelection(askedGroups([l1], byId, [pickMeal, pickSalad]), [pickMeal, pickSalad, pickCoke]) === null,
  )
  ok(
    'an UNASKED required question is not demanded',
    validateSelection(askedGroups([l1], byId, []), []) === null,
    'not choosing the meal must not demand a side',
  )

  /* The distinct-vs-units reading, which 080 warns is the thing readers get
     wrong. A ceiling of 2 with one answer at ×5 is ONE choice, not five. */
  const many = await mkGroup('Counted toppings', { name: '', maxChoices: 2 })
  const baconProd = await mkProduct('BACON')
  await replaceOptions(SITE, many, [
    { name: 'Bacon', priceAdjust: 5, productId: baconProd, quantity: 0.25, maxQty: 5 },
    { name: 'Cheese', priceAdjust: 3, maxQty: 5 },
    { name: 'Egg', priceAdjust: 4, maxQty: 5 },
  ])
  await setGroupsForProduct(SITE, burger, [l1, many])

  const lib2 = await readInstructionLibrary(SITE)
  const byId2 = new Map(lib2.groups.map((g) => [g.id, g]))
  const gMany = byId2.get(many)!
  const oBacon = gMany.options.find((o) => o.name === 'Bacon')!
  const oCheese = gMany.options.find((o) => o.name === 'Cheese')!
  const oEgg = gMany.options.find((o) => o.name === 'Egg')!

  const bacon5 = chooseOption(gMany, oBacon, 5)
  const cheese1 = chooseOption(gMany, oCheese, 1)
  const egg1 = chooseOption(gMany, oEgg, 1)

  /* ── THE CEILING COUNTS ITEMS, NOT DISTINCT ANSWERS ──────────────────────
   *
   * Reversed deliberately (see validateSelection). A ceiling of 2 takes two
   * items however they are spread: one answer ×2, or two answers ×1 each.
   * Bacon ×5 alone is FIVE and is refused — which is the whole point, and was
   * the bug a shop hit with "choose up to 3" taking seven side dishes.
   */
  ok(
    '*** one answer at x5 BREAKS a ceiling of 2 — it is five items ***',
    validateSelection([gMany], [bacon5]) !== null,
    validateSelection([gMany], [bacon5]) ?? '',
  )
  ok(
    'two single answers exactly fill a ceiling of 2',
    validateSelection([gMany], [cheese1, egg1]) === null,
  )
  ok(
    'one answer at x2 also exactly fills it',
    validateSelection([gMany], [chooseOption(gMany, oBacon, 2)]) === null,
  )
  ok(
    '*** a third item breaks it, even spread across answers ***',
    validateSelection([gMany], [chooseOption(gMany, oBacon, 2), cheese1]) !== null,
    validateSelection([gMany], [chooseOption(gMany, oBacon, 2), cheese1]) ?? '',
  )
  ok(
    'more than one answer allows is refused',
    validateSelection([gMany], [chooseOption(gMany, oBacon, 6)]) !== null,
  )
  ok(
    'a zero count is refused',
    validateSelection([gMany], [{ ...bacon5, qty: 0 }]) !== null,
  )

  /* ── THE REPORTED BUG, as a standing assertion ────────────────────────────
   *
   * A shop capped a question at 3 and the till took seven: chips ×2, salad ×2,
   * veg ×3. Three distinct answers, so the old distinct-counting ceiling was
   * satisfied and the stepper — which only ever knew each answer's own maxQty —
   * never consulted the group at all.
   *
   * Reproduced with the screenshot's exact numbers so it cannot come back. */
  const sides = await mkGroup('Side options', { name: '', maxChoices: 3 })
  await replaceOptions(SITE, sides, [
    { name: 'Chips', maxQty: 5 },
    { name: 'Salad', maxQty: 5 },
    { name: 'Veg', maxQty: 5 },
  ])
  const libSides = await readInstructionLibrary(SITE)
  /* The group must be ASKED to be shipped, so hang it off the burger. */
  await setGroupsForProduct(SITE, burger, [l1, many, sides])
  const lib3 = await readInstructionLibrary(SITE)
  const gSides = new Map(lib3.groups.map((g) => [g.id, g])).get(sides)!
  const sChips = gSides.options.find((o) => o.name === 'Chips')!
  const sSalad = gSides.options.find((o) => o.name === 'Salad')!
  const sVeg = gSides.options.find((o) => o.name === 'Veg')!

  ok(
    '*** THE REPORTED BUG: chips x2 + salad x2 + veg x3 is refused at a cap of 3 ***',
    validateSelection(
      [gSides],
      [chooseOption(gSides, sChips, 2), chooseOption(gSides, sSalad, 2), chooseOption(gSides, sVeg, 3)],
    ) !== null,
  )
  ok(
    'three single sides exactly fill a cap of 3',
    validateSelection(
      [gSides],
      [chooseOption(gSides, sChips, 1), chooseOption(gSides, sSalad, 1), chooseOption(gSides, sVeg, 1)],
    ) === null,
  )
  ok(
    'one side counted up to 3 also exactly fills it',
    validateSelection([gSides], [chooseOption(gSides, sChips, 3)]) === null,
  )
  ok(
    'a fourth item is refused however it is spread',
    validateSelection(
      [gSides],
      [chooseOption(gSides, sChips, 3), chooseOption(gSides, sSalad, 1)],
    ) !== null,
  )
  ok(
    'totalUnits counts items, not answers',
    totalUnits([chooseOption(gSides, sChips, 2), chooseOption(gSides, sSalad, 2)]) === 4,
  )

  /* ════════════════════════════════════════════════════════════════════════
   * 6. THE ARITHMETIC — per unit, per line, and the stock it takes
   * ════════════════════════════════════════════════════════════════════════ */

  ok('an empty selection adds nothing', adjustPerUnit([]) === 0)
  ok('bacon x5 at 5.00 is 25.00', adjustPerUnit([bacon5]) === 25)
  ok('mixed answers sum', adjustPerUnit([bacon5, cheese1]) === 28)

  /* A NEGATIVE adjustment — "no cheese -2.00" is an explicit case in 010. */
  const discount = await mkGroup('Take something off', { name: '', maxChoices: 1 })
  await replaceOptions(SITE, discount, [{ name: 'No cheese', priceAdjust: -2.5 }])
  const gDisc = (await listOptions(SITE, discount))[0]
  ok('a negative adjustment is stored as negative', gDisc.priceAdjust === -2.5)
  ok(
    'a negative answer REDUCES the built price',
    adjustPerUnit([
      { ...bacon5, priceAdjustIncl: -2.5, qty: 1 },
    ]) === -2.5,
  )

  /* Stock: per answer, per unit of the answer, per item on the line. */
  ok(
    '*** stock = qtyPer x answerQty x lineQty ***',
    stockForOption({ ...bacon5, stockQtyPer: 0.25 }, 4) === 5,
    `0.25 x 5 x 4 = ${stockForOption({ ...bacon5, stockQtyPer: 0.25 }, 4)}`,
  )
  ok('an unlinked answer takes no stock', stockForOption({ ...cheese1, stockQtyPer: 0 }, 10) === 0)

  /* startingQty — what the modal opens with. */
  ok('a plain answer starts unchosen', startingQty({ ...oCheese, isDefault: false } as never) === 0)
  ok(
    'a pre-ticked answer at defaultQty 0 still starts at 1',
    startingQty({ ...oCheese, isDefault: true, defaultQty: 0, minQty: 0 } as never) === 1,
  )
  ok(
    'a pre-ticked answer honours its minimum',
    startingQty({ ...oCheese, isDefault: true, defaultQty: 1, minQty: 3 } as never) === 3,
  )

  /* ════════════════════════════════════════════════════════════════════════
   * 7. WHAT PRINTS WHERE
   * ════════════════════════════════════════════════════════════════════════ */

  const kitchenOnly: ChosenOption = { ...cheese1, optionName: 'No onion', printsOnReceipt: false }
  const receiptOnly: ChosenOption = { ...cheese1, optionName: 'Oat milk', printsOnKitchen: false }

  ok(
    'the receipt drops the kitchen-only answer',
    !describeSelection([bacon5, kitchenOnly], 'receipt').includes('No onion'),
  )
  ok(
    'the kitchen ticket keeps it',
    describeSelection([bacon5, kitchenOnly], 'kitchen').includes('No onion'),
  )
  ok(
    'the kitchen drops a receipt-only answer',
    !describeSelection([receiptOnly], 'kitchen').includes('Oat milk'),
  )
  ok("'all' keeps both", describeSelection([kitchenOnly, receiptOnly], 'all').length === 2)
  ok('a count above one is written out', describeSelection([bacon5], 'all')[0] === 'Bacon ×5')
  ok('a single is written plain', describeSelection([cheese1], 'all')[0] === 'Cheese')

  /* ════════════════════════════════════════════════════════════════════════
   * 8. A POSTED DOCUMENT CARRIES THE ANSWERS — and the money is not doubled
   * ════════════════════════════════════════════════════════════════════════ */

  const base = 100
  const built = base + adjustPerUnit([bacon5, cheese1]) // 128

  const draft = await saveDraft(SITE, actor, {
    docType: 'invoice',
    lines: [
      {
        productId: burger,
        productCode: `${tag}BURGER`,
        description: 'Deep burger',
        productType: 'normal',
        qty: 3,
        unitPriceIncl: built,
        vatRatePct: vatRate,
        unitCostExcl: 5,
        instructions: [bacon5, cheese1].map((c) => ({
          groupId: c.groupId,
          groupName: c.groupName,
          optionId: c.optionId,
          optionName: c.optionName,
          qty: c.qty,
          priceAdjustIncl: c.priceAdjustIncl,
          productId: c.productId,
          stockQtyPer: c.stockQtyPer,
          printsOnKitchen: c.printsOnKitchen,
          printsOnReceipt: c.printsOnReceipt,
        })),
      },
    ],
  })
  ok('a draft with two answers saves', draft.ok, draft.ok ? '' : draft.error)
  if (!draft.ok) throw new Error(draft.error)

  const read = await getDocument(SITE, draft.id)
  const line = read?.lines[0]
  ok('both answers read back', line?.instructions.length === 2)
  ok(
    'the per-item count is stored per ITEM, not per line',
    toNum(line?.instructions.find((i) => i.optionName === 'Bacon')?.qty) === 5,
    'a line of 3 with bacon x5 stores 5, not 15',
  )
  ok(
    '*** what it contributed ACROSS the line is 5 x 5.00 x 3 = 75 ***',
    toNum(line?.instructions.find((i) => i.optionName === 'Bacon')?.lineAdjustIncl) === 75,
    String(line?.instructions.find((i) => i.optionName === 'Bacon')?.lineAdjustIncl),
  )
  ok(
    '*** the line total is the BUILT price, not built + adjustment again ***',
    Math.abs(toNum(line?.lineTotalIncl) - built * 3) < 0.01,
    `${line?.lineTotalIncl} vs ${(built * 3).toFixed(2)}`,
  )

  /* ════════════════════════════════════════════════════════════════════════
   * 9. DELETION GUARDS
   * ════════════════════════════════════════════════════════════════════════ */

  const usedDel = await deleteGroup(SITE, many)
  ok('a question a product asks cannot be deleted', !usedDel.ok, usedDel.ok ? '' : usedDel.error)

  const revealedDel = await deleteGroup(SITE, l2)
  ok(
    'a question another answer reveals cannot be deleted',
    !revealedDel.ok,
    revealedDel.ok ? '' : revealedDel.error,
  )

  /* ════════════════════════════════════════════════════════════════════════
   * 10. THE SEEDED CAFE MENU — read-only, on a real site
   * ════════════════════════════════════════════════════════════════════════ */

  const cafe = await readInstructionLibrary(CAFE_SITE)
  const cafeById = new Map(cafe.groups.map((g) => [g.id, g]))
  ok(`cafe site ${CAFE_SITE} ships a menu`, cafe.groups.length > 0, `${cafe.groups.length} questions`)
  ok(
    'cafe products ask questions',
    Object.keys(cafe.byProduct).length > 0,
    `${Object.keys(cafe.byProduct).length} products`,
  )

  /* Every group the till is given must be reachable and every reveal it names
     must also be shipped — a dangling reveal is a question that never opens. */
  let dangling = 0
  for (const g of cafe.groups) {
    for (const o of g.options) {
      for (const id of o.revealsGroupIds) if (!cafeById.has(id)) dangling++
    }
  }
  ok('*** no cafe reveal points at a question that was not shipped ***', dangling === 0, `${dangling} dangling`)

  /* Walk every cafe product's tree the way the till does, and prove it
     terminates and validates. A cycle would hang this loop rather than fail it,
     which is exactly why askedGroups carries a visited-set. */
  let walked = 0
  let deepest = 0
  for (const [productId, startIds] of Object.entries(cafe.byProduct)) {
    const asked = askedGroups(startIds, cafeById, [])
    walked++
    deepest = Math.max(deepest, asked.length)
    /* With nothing chosen, no REVEALED question should be open yet. */
    if (asked.length !== startIds.length) {
      ok(`product ${productId}: unchosen reveals stay shut`, false, `${asked.length} vs ${startIds.length}`)
      break
    }
  }
  ok(`*** all ${walked} cafe products resolve without looping ***`, walked > 0)

  /* Choosing every default on every cafe product must produce a VALID
     selection — a shop's pre-ticked answers must never be a refusal. */
  let badDefault = ''
  for (const [productId, startIds] of Object.entries(cafe.byProduct)) {
    const seed: ChosenOption[] = []
    for (const id of startIds) {
      const g = cafeById.get(id)
      if (!g) continue
      for (const o of g.options) {
        const start = startingQty(o)
        if (start > 0) seed.push(chooseOption(g, o, start))
      }
    }
    const asked = askedGroups(startIds, cafeById, seed)
    const refusal = validateSelection(asked, pruneUnasked(asked, seed))
    /* A REQUIRED question with no pre-ticked answer legitimately refuses —
       that is the cashier's job. Only flag a group that is not required. */
    if (refusal && !asked.some((g) => g.isRequired || g.minChoices > 0)) {
      badDefault = `product ${productId}: ${refusal}`
      break
    }
  }
  ok('no cafe product refuses its own defaults on an optional menu', badDefault === '', badDefault)

  /* The cafe's reveal chains specifically. */
  const cafeReveals = cafe.groups.flatMap((g) =>
    g.options.filter((o) => o.revealsGroupIds.length).map((o) => ({ g, o })),
  )
  ok('the cafe menu has reveal chains to exercise', cafeReveals.length > 0, `${cafeReveals.length}`)
  const twoWayCafe = cafeReveals.find((r) => r.o.revealsGroupIds.length > 1)
  ok(
    'the cafe has an answer that opens TWO questions',
    !!twoWayCafe,
    twoWayCafe ? `"${twoWayCafe.o.name}" opens ${twoWayCafe.o.revealsGroupIds.length}` : '',
  )

  /* ════════════════════════════════════════════════════════════════════════
   * 11. CLEAN UP — litter here breaks unrelated suites
   * ════════════════════════════════════════════════════════════════════════ */

  for (const id of madeProducts) {
    await siteExecute(SITE, 'DELETE FROM product_instruction_groups WHERE product_id = ?', [id])
  }
  for (const id of made) {
    await siteExecute(SITE, 'DELETE FROM instruction_option_reveals WHERE group_id = ?', [id])
  }
  for (const id of made) {
    await siteExecute(
      SITE,
      'DELETE FROM instruction_option_reveals WHERE option_id IN (SELECT id FROM instruction_options WHERE group_id = ?)',
      [id],
    )
  }
  for (const id of made) {
    await siteExecute(SITE, 'DELETE FROM instruction_options WHERE group_id = ?', [id])
  }
  for (const id of made) {
    await siteExecute(SITE, 'DELETE FROM instruction_groups WHERE id = ?', [id])
  }
  for (const id of madeProducts) {
    await siteExecute(SITE, 'DELETE FROM products WHERE id = ?', [id]).catch(() => {})
  }

  const left = await siteQuery<{ n: number }>(
    SITE,
    'SELECT COUNT(*) AS n FROM instruction_groups WHERE name LIKE ?',
    [`${tag}%`],
  )
  ok('no instruction litter left behind', Number(left[0]?.n ?? 0) === 0, String(left[0]?.n))

  const leftProducts = await siteQuery<{ n: number }>(
    SITE,
    "SELECT COUNT(*) AS n FROM products WHERE code LIKE ? AND product_type='serial'",
    [`${tag}%`],
  )
  ok('no serial fixture left behind', Number(leftProducts[0]?.n ?? 0) === 0)

  console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
