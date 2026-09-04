/**
 * Kitchen printing — routing, the per-printer delta, and grouping.
 *
 *   npx tsx --conditions=react-server --env-file=.env scripts/test-kitchen-printing.ts
 *
 * The decisions under test are the ones that would silently ruin a service:
 *
 *   · A PRODUCT WITH NO PRINTER IS SKIPPED. There is no default and no fallback,
 *     so a retail line on a hospitality till must produce no docket at all
 *     rather than paper in front of a chef.
 *   · THE DELTA IS PER LINE PER PRINTER. This is what 229 replaced the old
 *     scalar for: a steak routed to two stations owes each of them separately,
 *     and sending it to one must not blind the other.
 *   · 3 SENT + 2 ADDED PRINTS 2. The rule the whole feature exists for.
 *   · A REDUCTION UN-SENDS NOTHING. Food already on the grill cannot be recalled
 *     by editing a bill, so the delta clamps at zero.
 *   · GROUPS SURVIVE THE ROUND TRIP. A course typed on the product must reach
 *     the docket, and case/spacing must not split one course into two.
 *   · A CANCELLATION NETS OFF, and can never take the total below what was
 *     really sent. Voiding what the kitchen never saw must cancel NOTHING.
 */
import { siteExecute, siteQuery, siteQueryOne } from '../src/lib/siteDb'
import {
  listKitchenPrinters,
  setPrintersForProduct,
  printersForProduct,
  printersForProducts,
  printerMapForDevice,
  printerMapForTerminal,
  sentQtyByLineAndPrinter,
  recordKitchenSend,
  recordKitchenCancel,
  sentQtyByProductAndPrinter,
  anyLineForProduct,
  distinctKitchenGroups,
} from '../src/lib/site/kitchenPrinters'
/* The printer LIST and the per-machine address moved out of kitchenPrinters in
   246 — neither was a kitchen question. This suite still gates them, because
   the fold-in is exactly the change that could break kitchen printing. */
import { createPrinter, setPrinterActive, updatePrinter } from '../src/lib/site/printers'
import { touchDevice } from '../src/lib/site/devices'
import { saveDraft, saveForLaterDocument, getDocument } from '../src/lib/site/salesDocuments'
import { kitchenDelta, groupKitchenLines } from '../src/lib/kitchenTicket'
import { toNum } from '../src/lib/decimals'

const SITE = 1
const actor = { userId: 1, userName: 'Kitchen test' }
let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

async function main() {
  const stamp = Date.now().toString().slice(-6)

  /* Sweep what an earlier crashed run left. `name` is UNIQUE on
     printers, so litter fails the INSERT rather than the assertion it
     was making. Sends go first — the printer FK is ON DELETE RESTRICT. */
  await siteExecute(
    SITE,
    `DELETE ksl FROM kitchen_send_lines ksl
       INNER JOIN kitchen_sends ks ON ks.id = ksl.send_id
       INNER JOIN printers p ON p.id = ks.printer_id
      WHERE p.name LIKE 'KTEST%'`,
  )
  await siteExecute(
    SITE,
    `DELETE ks FROM kitchen_sends ks
       INNER JOIN printers p ON p.id = ks.printer_id
      WHERE p.name LIKE 'KTEST%'`,
  )
  await siteExecute(SITE, "DELETE FROM printers WHERE name LIKE 'KTEST%'")
  await siteExecute(SITE, "DELETE FROM devices WHERE device_id LIKE 'ktest-%'")
  await siteExecute(SITE, "DELETE FROM products WHERE code LIKE 'KIT9%'")

  const vat = await siteQueryOne<any>(
    SITE,
    "SELECT id, rate FROM vat_rates WHERE vat_type='sales' AND is_default=1 LIMIT 1",
  )
  const rate = toNum(vat?.rate, 15)

  /* ── Products: one routed to two stations, one to one, one to none ────── */

  async function makeProduct(code: string, group: string): Promise<number> {
    const res = await siteExecute(
      SITE,
      `INSERT INTO products (code, description, product_type, stock_on_hand, average_cost,
                             last_cost, selling_vat_rate_id, visible_in_pos, kitchen_group)
       VALUES (?,?,'service',0,4,4,?,1,?)`,
      [code, `Kitchen test ${code}`, vat?.id ?? null, group],
    )
    return res.insertId
  }

  const steakId = await makeProduct(`KIT9S${stamp}`, 'Mains')
  const cokeId = await makeProduct(`KIT9C${stamp}`, 'Drinks')
  // Deliberately UNROUTED and ungrouped — the "bag of ice" case.
  const iceId = await makeProduct(`KIT9I${stamp}`, '')

  /* ── 1. Printers ────────────────────────────────────────────────────────── */
  console.log('\n── Printers ────────────────────────────────────────────────\n')

  /* A kitchen printer on the network — reachable from every machine with no
     driver installed anywhere, which is how a restaurant actually wires one. */
  const kitchen = (name: string, target = '192.0.2.40') =>
    createPrinter(SITE, {
      name,
      purpose: 'kitchen' as const,
      paper: 'slip80' as const,
      slipColumns: null,
      connection: 'network' as const,
      deviceId: null,
      target,
      shareName: '',
      port: 9100,
      drawerKick: false,
    })

  const grill = await kitchen(`KTEST Grill ${stamp}`)
  const bar = await kitchen(`KTEST Bar ${stamp}`)
  ok('a printer is created', grill.ok && bar.ok)
  if (!grill.ok || !bar.ok) throw new Error('could not create printers')

  const dupe = await kitchen(`KTEST Grill ${stamp}`)
  ok('*** a duplicate name is refused ***', !dupe.ok)

  /* Deactivate-then-recreate reconnects rather than making "Bar 2" — a station
     coming back after a refit is the same station. */
  await setPrinterActive(SITE, bar.id, false)
  const revived = await kitchen(`KTEST Bar ${stamp}`)
  ok('*** re-adding a switched-off printer revives it, same id ***',
     revived.ok && revived.id === bar.id)

  const active = await listKitchenPrinters(SITE)
  ok('an active printer lists', active.some((p) => p.id === grill.id))

  /* The purpose filter: a general printer must not reach a product's Kitchen
     tab, or a shop routes steaks to the office laser. */
  const laser = await createPrinter(SITE, {
    name: `KTEST Office ${stamp}`,
    purpose: 'general' as const,
    paper: 'a4' as const,
    slipColumns: null,
    connection: 'network' as const,
    deviceId: null,
    target: '192.0.2.9',
    shareName: '',
    port: 9100,
    drawerKick: false,
  })
  ok('*** a general printer is not offered as a kitchen station ***',
     laser.ok && !(await listKitchenPrinters(SITE)).some((p) => laser.ok && p.id === laser.id))

  /* ── 2. Routing ─────────────────────────────────────────────────────────── */
  console.log('\n── Routing ─────────────────────────────────────────────────\n')

  // The steak goes to BOTH — the case a single scalar could never express.
  await setPrintersForProduct(SITE, steakId, [grill.id, bar.id])
  await setPrintersForProduct(SITE, cokeId, [bar.id])
  // The ice is routed nowhere at all, deliberately.

  const steakRoutes = await printersForProduct(SITE, steakId)
  ok('a product routes to more than one printer', steakRoutes.length === 2)

  const routing = await printersForProducts(SITE, [steakId, cokeId, iceId])
  ok('*** an unrouted product is absent from the map, not empty in it ***',
     !routing.has(iceId))
  ok('a routed product carries its printers', (routing.get(cokeId) ?? []).length === 1)

  // Replacing the set really unroutes — an empty save is a real answer.
  await setPrintersForProduct(SITE, cokeId, [])
  ok('*** an empty save unroutes rather than being ignored ***',
     (await printersForProduct(SITE, cokeId)).length === 0)
  await setPrintersForProduct(SITE, cokeId, [bar.id])

  /* ── 3. Which machine reaches which printer ──────────────────── */
  console.log('\n── Reachability ───────────────────────────────\n')

  /* Since 247 a printer knows its own location, so reachability is two rules
     rather than a table: a NETWORK printer is reachable from every machine, and
     a QUEUE printer only from the machine its queue is installed on.

     `terminal` is still read because the send history below records WHICH TILL
     put paper out — a fact about the sale, not about the printer. */
  const terminal = await siteQueryOne<any>(SITE, 'SELECT id FROM terminals LIMIT 1')

  const device = `ktest-${stamp}-aaaa`
  const other = `ktest-${stamp}-bbbb`
  for (const id of [device, other]) {
    await touchDevice(SITE, {
      deviceId: id,
      label: `KTEST ${id.slice(-4)} ${stamp}`,
      kind: 'desktop',
      platform: 'win32',
      appRole: 'pos',
    })
  }

  /* The whole point of the network option: nothing was ever said about THIS
     machine and the grill, and it reaches it anyway. Move the printer and every
     machine follows — one edit, not one per till. */
  const map = await printerMapForDevice(SITE, device)
  const grillRow = map.find((m) => m.printerId === grill.id)
  ok('*** a network printer is reachable from a machine that was never told about it ***',
     grillRow?.bridgePrinter === '192.0.2.40')
  ok('…and from a second machine, with no second edit',
     (await printerMapForDevice(SITE, other)).find((m) => m.printerId === grill.id)?.bridgePrinter ===
       '192.0.2.40')

  ok('*** the kitchen view excludes general printers ***',
     !map.some((m) => laser.ok && m.printerId === laser.id))

  /* A QUEUE printer belongs to one machine. Every active kitchen printer still
     APPEARS on the others — an empty address is exactly the state where food
     silently stops printing, so the screen must be able to show it — but it
     carries no way in. */
  const pass = await createPrinter(SITE, {
    name: `KTEST Pass ${stamp}`,
    purpose: 'kitchen' as const,
    paper: 'slip58' as const,
    slipColumns: null,
    connection: 'queue' as const,
    deviceId: device,
    target: 'EPSON-PASS',
    shareName: '',
    port: null,
    drawerKick: false,
  })
  if (!pass.ok) throw new Error('could not create the queue printer')

  const own = (await printerMapForDevice(SITE, device)).find((m) => m.printerId === pass.id)
  ok('*** a queue printer is reachable from its own machine ***', own?.bridgePrinter === 'EPSON-PASS')
  ok('…carrying ITS paper width, not the counter’s', own?.columns === 32)

  const foreign = (await printerMapForDevice(SITE, other)).find((m) => m.printerId === pass.id)
  ok('*** …and appears but is unreachable from any other machine ***',
     foreign !== undefined && foreign.bridgePrinter === '')

  /* A half-finished printer reaches nothing, from anywhere. It is the state a
     manager leaves behind when they add a printer for a machine they are not
     sitting at, so it must be visible rather than silently broken. */
  const half = await createPrinter(SITE, {
    name: `KTEST Half ${stamp}`,
    purpose: 'kitchen' as const,
    paper: 'slip80' as const,
    slipColumns: null,
    connection: 'queue' as const,
    deviceId: null,
    target: '',
    shareName: '',
    port: null,
    drawerKick: false,
  })
  if (!half.ok) throw new Error('could not create the half-finished printer')
  ok('*** an unfinished printer reaches nothing ***',
     (await printerMapForDevice(SITE, device)).find((m) => m.printerId === half.id)?.bridgePrinter === '')

  /* Re-pointing the shop’s network printer moves every machine at once. */
  await updatePrinter(SITE, grill.id, {
    name: `KTEST Grill ${stamp}`,
    purpose: 'kitchen' as const,
    paper: 'slip80' as const,
    slipColumns: null,
    connection: 'network' as const,
    deviceId: null,
    target: '192.0.2.99',
    shareName: '',
    port: 9100,
    drawerKick: false,
  })
  ok('*** one address change moves every machine ***',
     (await printerMapForDevice(SITE, device)).find((m) => m.printerId === grill.id)?.bridgePrinter ===
       '192.0.2.99' &&
     (await printerMapForDevice(SITE, other)).find((m) => m.printerId === grill.id)?.bridgePrinter ===
       '192.0.2.99')

  /* The terminal-shaped view, still working. A till no machine has claimed
     reaches nothing — the honest answer rather than an error. */
  const unclaimed = await siteQueryOne<any>(
    SITE,
    "SELECT id FROM terminals WHERE device_id IS NULL OR device_id = '' LIMIT 1",
  )
  if (unclaimed) {
    ok('*** an unclaimed till reaches nothing ***',
       (await printerMapForTerminal(SITE, unclaimed.id)).length === 0)
  } else {
    console.log('SKIP  unclaimed till — every terminal on this site is claimed')
  }

  /* ── 4. The delta, per line per printer ─────────────────────────────────── */
  console.log('\n── The delta ───────────────────────────────────────────────\n')

  const draft = await saveDraft(SITE, actor, {
    docType: 'invoice',
    customerName: 'Table K1',
    lines: [
      {
        productId: steakId,
        description: 'Steak',
        productType: 'service',
        qty: 1,
        unitPriceIncl: 100,
        vatRatePct: rate,
        unitCostExcl: 4,
      },
      {
        productId: cokeId,
        description: 'Coke',
        productType: 'service',
        qty: 3,
        unitPriceIncl: 20,
        vatRatePct: rate,
        unitCostExcl: 4,
      },
      {
        productId: iceId,
        description: 'Bag of ice',
        productType: 'service',
        qty: 1,
        unitPriceIncl: 15,
        vatRatePct: rate,
        unitCostExcl: 4,
      },
    ],
  } as never)
  if (!draft.ok) throw new Error(`draft failed: ${draft.error}`)
  /* Pulled out of the union so the closures below can see it. `draft.ok` narrows
     here but not inside a callback, which is where `owed()` reads it. */
  const documentId = draft.id
  await saveForLaterDocument(SITE, documentId)

  const doc = await getDocument(SITE, documentId)
  if (!doc) throw new Error('document vanished')

  ok('*** the kitchen group reaches the line from the product ***',
     doc.lines.find((l) => l.productId === steakId)?.kitchenGroup === 'Mains')

  const steakLine = doc.lines.find((l) => l.productId === steakId)!
  const cokeLine = doc.lines.find((l) => l.productId === cokeId)!

  /** What a printer is owed right now, straight from the send history. */
  async function owed(lineId: number, printerId: number, qty: number): Promise<number> {
    const sent = await sentQtyByLineAndPrinter(SITE, documentId)
    return kitchenDelta([
      { lineId, qty, sentQty: sent.get(`${lineId}:${printerId}`) ?? 0 },
    ])[0]?.qty ?? 0
  }

  ok('a new line owes the grill everything', (await owed(steakLine.id, grill.id, 1)) === 1)
  ok('…and owes the bar everything too', (await owed(steakLine.id, bar.id, 1)) === 1)

  // Fire the GRILL only.
  await recordKitchenSend(SITE, {
    documentId: documentId,
    printerId: grill.id,
    terminalId: terminal?.id ?? null,
    sentBy: actor.userId,
    sentByName: actor.userName,
    source: 'manual',
    lines: [{ lineId: steakLine.id, qty: 1 }],
  })

  ok('the grill now owes nothing', (await owed(steakLine.id, grill.id, 1)) === 0)
  ok('*** …but the bar still owes the whole line ***',
     (await owed(steakLine.id, bar.id, 1)) === 1)

  /* ── 5. Three Cokes, then two more ──────────────────────────────────────── */
  console.log('\n── 3 sent, 2 added ─────────────────────────────────────────\n')

  await recordKitchenSend(SITE, {
    documentId: documentId,
    printerId: bar.id,
    terminalId: terminal?.id ?? null,
    sentBy: actor.userId,
    sentByName: actor.userName,
    source: 'auto',
    lines: [{ lineId: cokeLine.id, qty: 3 }],
  })
  ok('three sent leaves nothing owing', (await owed(cokeLine.id, bar.id, 3)) === 0)
  ok('*** two more added owes exactly two ***', (await owed(cokeLine.id, bar.id, 5)) === 2)

  /* A REDUCTION un-sends nothing. Food already on the grill cannot be recalled
     by editing a bill, so this clamps rather than going negative. */
  ok('*** reducing below what was sent owes nothing, never a negative ***',
     (await owed(cokeLine.id, bar.id, 1)) === 0)

  /* ── 6. Cancellation ────────────────────────────────────────────────────── */
  console.log('\n── Cancellation ────────────────────────────────────────────\n')

  /* Reset the Cokes to a known state: the bar has had 3 of 3. */
  const cokeSent = (await sentQtyByLineAndPrinter(SITE, documentId)).get(`${cokeLine.id}:${bar.id}`)
  ok('the bar has had three cokes', cokeSent === 3)

  // Cancel two of them.
  await recordKitchenCancel(SITE, {
    documentId,
    printerId: bar.id,
    terminalId: terminal?.id ?? null,
    sentBy: actor.userId,
    sentByName: actor.userName,
    lines: [{ lineId: cokeLine.id, qty: 2 }],
  })

  const afterCancel = await sentQtyByLineAndPrinter(SITE, documentId)
  ok('*** a cancellation nets off the send ***',
     afterCancel.get(`${cokeLine.id}:${bar.id}`) === 1)
  /* The payoff of the negative row: the arithmetic is unchanged, so a line of 3
     with 2 cancelled is owed 2 again — the kitchen was told to stop, so it must
     be told to start if the customer changes their mind back. */
  ok('*** …so the kitchen is owed them again ***', (await owed(cokeLine.id, bar.id, 3)) === 2)

  // A cancellation is recorded as its own kind, so reports can exclude it.
  const cancelRows = await siteQuery<any>(
    SITE,
    "SELECT source, COUNT(*) AS n FROM kitchen_sends WHERE document_id = ? AND source = 'cancel' GROUP BY source",
    [documentId],
  )
  ok('a cancellation is filed under its own source', Number(cancelRows[0]?.n ?? 0) === 1)

  /* Resolved BY PRODUCT, because a voided basket line carries no database line
     id — the whole reason `sentQtyByProductAndPrinter` exists. */
  const byProduct = await sentQtyByProductAndPrinter(SITE, documentId)
  ok('*** the product view sees the same net ***',
     byProduct.get(`${cokeId}:${bar.id}`) === 1)
  ok('a line can be found for a product to hang a cancellation on',
     (await anyLineForProduct(SITE, documentId, cokeId)) === cokeLine.id)

  /* The case that must print NOTHING: the ice was never routed anywhere, so
     voiding it has nothing to tell any kitchen. */
  ok('*** an unrouted product has nothing to cancel ***',
     !byProduct.has(`${iceId}:${bar.id}`) && !byProduct.has(`${iceId}:${grill.id}`))

  /* And the clamp: the grill was sent 1 steak, so it can never be told to
     cancel 5 — that would drive the net negative, reading as the kitchen being
     owed MORE than was ordered. */
  const steakHad = byProduct.get(`${steakId}:${grill.id}`) ?? 0
  ok('the grill had exactly one steak', steakHad === 1)
  await recordKitchenCancel(SITE, {
    documentId,
    printerId: grill.id,
    terminalId: terminal?.id ?? null,
    sentBy: actor.userId,
    sentByName: actor.userName,
    lines: [{ lineId: steakLine.id, qty: Math.min(5, steakHad) }],
  })
  const steakAfter = (await sentQtyByLineAndPrinter(SITE, documentId)).get(
    `${steakLine.id}:${grill.id}`,
  )
  ok('*** cancelling clamps at what was sent — never below zero ***', steakAfter === 0)

  /* ── 7. Grouping ────────────────────────────────────────────────────────── */
  console.log('\n── Grouping ────────────────────────────────────────────────\n')

  const groups = groupKitchenLines(
    doc.lines.map((l) => ({
      qty: Math.abs(l.qty),
      description: l.description,
      notes: [],
      note: '',
      kitchenGroup: l.kitchenGroup,
    })),
  )
  ok('lines sort into their courses', groups.length === 3)
  ok('*** the ungrouped line prints last, under no heading ***',
     groups.at(-1)?.title === '' && groups.at(-1)?.lines[0].description === 'Bag of ice')

  const known = await distinctKitchenGroups(SITE)
  ok('the groups in use are offered as suggestions',
     known.includes('Mains') && known.includes('Drinks'))

  /* ── Cleanup ────────────────────────────────────────────────────────────── */
  /* Sends first — kitchen_sends holds the printer FK with ON DELETE RESTRICT,
     which is the point of that constraint: history outlives its printer. */
  await siteExecute(
    SITE,
    `DELETE ksl FROM kitchen_send_lines ksl
       INNER JOIN kitchen_sends ks ON ks.id = ksl.send_id
      WHERE ks.document_id = ?`,
    [documentId],
  )
  await siteExecute(SITE, 'DELETE FROM kitchen_sends WHERE document_id = ?', [documentId])
  await siteExecute(SITE, 'DELETE FROM sales_document_lines WHERE document_id = ?', [documentId])
  await siteExecute(SITE, 'DELETE FROM sales_documents WHERE id = ?', [documentId])
  await siteExecute(SITE, "DELETE FROM printers WHERE name LIKE 'KTEST%'")
  await siteExecute(SITE, "DELETE FROM devices WHERE device_id LIKE 'ktest-%'")
  await siteExecute(SITE, 'DELETE FROM products WHERE id IN (?,?,?)', [steakId, cokeId, iceId])

  console.log(fails === 0 ? '\nAll kitchen printing rules hold.\n' : `\n${fails} FAILURE(S)\n`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
