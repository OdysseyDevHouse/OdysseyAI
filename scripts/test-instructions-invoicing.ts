/**
 * Instructions on the INVOICING counter, not just the till.
 *
 *   npx tsx --conditions=react-server --env-file=.env scripts/test-instructions-invoicing.ts
 *
 * ── WHAT THIS IS FOR ────────────────────────────────────────────────────────
 *
 * The till asks a product's questions and the answers ride the line all the way
 * to stock and the kitchen ticket. The invoicing window is the OTHER counter —
 * same shop, same products, same `saveDraft` underneath — and the question is
 * whether a burger sold there behaves the same way.
 *
 * The answer today is no, and this suite says exactly where the break is rather
 * than describing it. Each assertion is written so it PASSES once the gap is
 * closed, so this doubles as the acceptance test for wiring it up.
 *
 * The layers, and which of them already work:
 *
 *   1. the SERVER (`saveDraft` / `getDocument`)  — already carries answers
 *   2. the PRICE GUARD (`checkPricing`)          — already accepts them
 *   3. the PAYLOAD (`InvoiceLinePayload`)        — DROPS them
 *   4. the SCREEN (`InvoiceEditor`)              — never asks
 */
import { siteQuery, siteQueryOne, siteExecute } from '../src/lib/siteDb'
import {
  createGroup,
  replaceOptions,
  listOptions,
  setGroupsForProduct,
  readInstructionLibrary,
} from '../src/lib/site/instructions'
import { saveDraft, getDocument } from '../src/lib/site/salesDocuments'
import { checkPricing } from '../src/lib/site/priceGuard'
import { NO_CAPABILITIES } from '../src/lib/site/permissions'
import { adjustPerUnit, chooseOption, askedGroups, validateSelection } from '../src/lib/instructionRules'
import { toNum } from '../src/lib/decimals'

const SITE = 1
const actor = { userId: 1, userName: 'Instructions Invoicing' }
let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

async function main() {
  const stamp = Date.now().toString().slice(-8)
  const tag = `INV${stamp}`

  const vat = await siteQueryOne<{ id: number; rate: string }>(
    SITE,
    "SELECT id, rate FROM vat_rates WHERE vat_type='sales' AND is_default=1 LIMIT 1",
  )
  const vatRate = toNum(vat?.rate, 15)

  const mk = async (suffix: string, onHand = 100) => {
    const res = await siteExecute(
      SITE,
      `INSERT INTO products (code, description, product_type, stock_on_hand, average_cost, last_cost, selling_vat_rate_id)
       VALUES (?,?,'normal',?,?,?,?)`,
      [`${tag}${suffix}`, `Inv ${suffix} ${stamp}`, onHand.toFixed(3), '10.0000', '10.0000', vat?.id ?? null],
    )
    return res.insertId
  }

  const burgerId = await mk('B')
  const baconId = await mk('X')

  const group = await createGroup(SITE, {
    name: `${tag} Toppings`,
    prompt: 'Any toppings?',
    maxChoices: 3,
  })
  if (!group.ok) throw new Error(group.error)
  await replaceOptions(SITE, group.id, [
    { name: 'Extra bacon', priceAdjust: 12, productId: baconId, quantity: 0.5, maxQty: 3 },
    { name: 'No onions', priceAdjust: 0, printsOnReceipt: false },
  ])
  await setGroupsForProduct(SITE, burgerId, [group.id])

  const opts = await listOptions(SITE, group.id)
  const bacon = opts.find((o) => o.name === 'Extra bacon')!

  const lib = await readInstructionLibrary(SITE)
  const byId = new Map(lib.groups.map((g) => [g.id, g]))
  const g = byId.get(group.id)!
  const chosen = [chooseOption(g, g.options.find((o) => o.name === 'Extra bacon')!, 2)]

  /* ── 1. THE SHARED SERVER LAYER — the half that already works ─────────── */

  const shelf = 100
  const built = shelf + adjustPerUnit(chosen) // 100 + 24

  const structure = await siteQueryOne<{ id: number }>(
    SITE,
    'SELECT id FROM price_structures ORDER BY id LIMIT 1',
  )
  await siteExecute(
    SITE,
    `INSERT INTO product_prices (product_id, price_structure_id, selling_price_incl)
     VALUES (?,?,?) ON DUPLICATE KEY UPDATE selling_price_incl = VALUES(selling_price_incl)`,
    [burgerId, structure?.id ?? null, shelf.toFixed(4)],
  )

  /* The price guard is shared by both counters, and it already understands a
     built price — so an invoice line carrying its answers is accepted for the
     same reason a till line is. */
  const guarded = await checkPricing(SITE, NO_CAPABILITIES, structure?.id ?? null, [
    {
      productId: burgerId,
      description: 'Inv burger',
      unitPriceIncl: built,
      instructions: [{ optionId: bacon.id, qty: 2 }],
    },
  ])
  ok('the price guard accepts an invoice line built by its answers', guarded === null, guarded ?? '')

  /* `saveDraft` is the SAME function the invoicing action calls. Handed
     answers directly it stores them — which is what proves the gap is in the
     payload and the screen, not in the server. */
  const draft = await saveDraft(SITE, actor, {
    docType: 'invoice',
    lines: [
      {
        productId: burgerId,
        productCode: `${tag}B`,
        description: 'Inv burger',
        productType: 'normal',
        qty: 2,
        unitPriceIncl: built,
        vatRatePct: vatRate,
        unitCostExcl: 10,
        instructions: chosen.map((c) => ({
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
  ok('an INVOICE document stores answers when it is given them', draft.ok, draft.ok ? '' : draft.error)
  if (!draft.ok) throw new Error(draft.error)

  const read = await getDocument(SITE, draft.id)
  ok('and they read back off the invoice line', read?.lines[0].instructions.length === 1)
  ok(
    'the invoice line total is the BUILT price',
    Math.abs(toNum(read?.lines[0].lineTotalIncl) - built * 2) < 0.01,
    `${read?.lines[0].lineTotalIncl} vs ${(built * 2).toFixed(2)}`,
  )

  /* ── 2. THE PAYLOAD — the whitelist that drops them ───────────────────── */

  /*
   * `InvoiceLinePayload` is the shape the invoicing screen posts, and
   * `toLineInputs` maps it to what `saveDraft` takes. Neither mentions
   * instructions, so answers cannot cross that boundary however the screen is
   * changed. This is the same class of bug the till's `salePayloadLines`
   * carries a warning about: a field left out of the whitelist vanishes
   * silently at save.
   *
   * Asserted by READING THE SOURCE rather than by types, because the type is
   * exactly what is missing — a compile-time check cannot fail on an absent
   * field, it simply would not mention it.
   */
  const actionsSrc = await import('node:fs/promises').then((fs) =>
    fs.readFile('src/app/(invoicing)/invoicing/actions.ts', 'utf8'),
  )
  const payloadCarries = /InvoiceLinePayload\s*=\s*\{[^}]*instructions/s.test(actionsSrc)
  ok(
    'InvoiceLinePayload carries the chosen answers',
    payloadCarries,
    payloadCarries ? '' : 'MISSING — the screen has nowhere to put them',
  )

  const mapperCarries = /function toLineInputs[\s\S]{0,900}?instructions/.test(actionsSrc)
  ok(
    'toLineInputs passes them through to saveDraft',
    mapperCarries,
    mapperCarries ? '' : 'MISSING — they would be dropped even if the screen sent them',
  )

  /* ── 3. THE SCREEN — whether the counter ever asks ────────────────────── */

  const editorSrc = await import('node:fs/promises').then((fs) =>
    fs.readFile('src/app/(invoicing)/invoicing/[id]/InvoiceEditor.tsx', 'utf8'),
  )
  const asks = /InstructionsModal/.test(editorSrc)
  ok(
    'the invoicing screen asks a product its questions',
    asks,
    asks ? '' : 'MISSING — a burger sold here is never asked how it is cooked',
  )
  const editorLineHolds = /type EditorLine[\s\S]{0,3000}?instructions/.test(editorSrc)
  ok(
    'an invoicing line can hold answers',
    editorLineHolds,
    editorLineHolds ? '' : 'MISSING — EditorLine has no instructions field',
  )

  /* ── 4. WHAT A REQUIRED QUESTION MEANS HERE ───────────────────────────── */

  /*
   * The consequence, stated as a test rather than an opinion: a REQUIRED
   * question is satisfied at the till and unanswerable on the invoice. The
   * shared rule says the line is invalid; the invoicing screen has no way to
   * make it valid, and no way to report that it cannot.
   */
  const required = await createGroup(SITE, {
    name: `${tag} Cook`,
    prompt: 'How would you like it cooked?',
    isRequired: true,
    minChoices: 1,
    maxChoices: 1,
  })
  if (!required.ok) throw new Error(required.error)
  await replaceOptions(SITE, required.id, [{ name: 'Medium' }, { name: 'Well done' }])
  await setGroupsForProduct(SITE, burgerId, [group.id, required.id])

  const lib2 = await readInstructionLibrary(SITE)
  const byId2 = new Map(lib2.groups.map((x) => [x.id, x]))
  const asked = askedGroups(lib2.byProduct[burgerId] ?? [], byId2, [])
  const refusal = validateSelection(asked, [])
  ok(
    'a required question refuses an unanswered line (shared rule)',
    refusal !== null,
    refusal ?? '',
  )
  ok(
    'and the invoicing screen cannot satisfy it today',
    !asks,
    asks ? 'it can now — good' : 'confirmed: the counter cannot answer a required question',
  )

  /* ── 5. CLEAN UP ──────────────────────────────────────────────────────── */

  await siteExecute(SITE, 'DELETE FROM product_instruction_groups WHERE product_id = ?', [burgerId])
  for (const id of [group.id, required.id]) {
    await siteExecute(
      SITE,
      'DELETE FROM instruction_option_reveals WHERE option_id IN (SELECT id FROM instruction_options WHERE group_id = ?)',
      [id],
    )
    await siteExecute(SITE, 'DELETE FROM instruction_option_reveals WHERE group_id = ?', [id])
    await siteExecute(SITE, 'DELETE FROM instruction_options WHERE group_id = ?', [id])
    await siteExecute(SITE, 'DELETE FROM instruction_groups WHERE id = ?', [id])
  }
  /* The burger has a draft against it and cannot go; the bacon can. Both
     deletes are allowed to fail rather than being forced — see the note in
     test-instructions.ts about what a swallowed delete can leave behind. */
  for (const id of [baconId, burgerId]) {
    await siteExecute(SITE, 'DELETE FROM products WHERE id = ?', [id]).catch(() => {})
  }

  const left = await siteQuery<{ n: number }>(
    SITE,
    'SELECT COUNT(*) AS n FROM instruction_groups WHERE name LIKE ?',
    [`${tag}%`],
  )
  ok('no instruction litter left behind', Number(left[0]?.n ?? 0) === 0)

  console.log(
    fails === 0
      ? '\nALL PASS'
      : `\n${fails} FAILURE(S) — each names a layer that still drops the answers`,
  )
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
