/**
 * Per-device printing — the machine registry, and what each machine prints where.
 *
 *   npx tsx --conditions=react-server --env-file=.env scripts/test-device-printing.ts
 *
 * The reachability rules are gated in depth by test-kitchen-printing.ts, which
 * exercises them through the view the POS actually uses. This suite covers the
 * half that has no other cover: the document assignment layer, and the machine
 * rows it hangs off.
 *
 * The decisions under test are the ones that silently lose paper:
 *
 *   · EVERY DOCUMENT APPEARS, answered or not. An unanswered document is
 *     exactly the state where nothing comes out, so a list that showed only
 *     what was already working could never reveal it.
 *   · AN UNKNOWN doc_key IS REFUSED. The catalogue is the routing boundary, and
 *     a VARCHAR column will accept anything if nothing checks it.
 *   · THE PAPER IS CHECKED. Pointing the A4-only cash-up declaration at an 80mm
 *     head is accepted by every layer below this one and produces nothing.
 *   · "NOT SET" AND "USE THE BROWSER" ARE DIFFERENT FACTS. They behave the same
 *     today and mean opposite things — one should be prompted, one left alone.
 *   · A DANGLING PRINTER IS FLAGGED, never quietly rendered as blank.
 *   · FORGETTING A MACHINE CASCADES, and touches nothing else.
 */
import { siteExecute, siteQuery } from '../src/lib/siteDb'
import {
  touchDevice,
  getDevice,
  listDevices,
  renameDevice,
  forgetDevice,
  copyPrintingSetup,
  isValidDeviceId,
} from '../src/lib/site/devices'
import { createPrinter, setPrinterActive, reachableFrom, listPrinters } from '../src/lib/site/printers'
import {
  assignmentsForDevice,
  setDocumentPrinter,
  clearDocumentPrinter,
  printConfigForDevice,
} from '../src/lib/site/documentPrinters'
import { PRINT_DOCS } from '../src/lib/printing/documents'
import { planFor } from '../src/lib/printing/resolve'

const SITE = 1
let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

async function main() {
  const stamp = Date.now().toString().slice(-6)

  /* Sweep what an earlier crashed run left. `name` is UNIQUE on printers, so
     litter fails the INSERT rather than the assertion it was making. Devices
     cascade their own rows, so they go first and take the rest with them. */
  await siteExecute(SITE, "DELETE FROM devices WHERE device_id LIKE 'dptest-%'")
  await siteExecute(SITE, "DELETE FROM printers WHERE name LIKE 'DPTEST%'")

  /* ── 1. The machine registry ─────────────────────────────────────────── */
  console.log('\n── The machine registry ────────────────────────────────────\n')

  ok('a UUID is a valid device id', isValidDeviceId('3f2b8c1a-4d5e-6f70-8192-a3b4c5d6e7f8'))
  ok('*** an id with a quote in it is refused ***', !isValidDeviceId("abc' OR 1=1--"))
  ok('*** an id too short to be stable is refused ***', !isValidDeviceId('abc'))
  ok('*** an over-long id is refused before it can truncate ***', !isValidDeviceId('a'.repeat(65)))

  const till = `dptest-${stamp}-till`
  const office = `dptest-${stamp}-offc`

  await touchDevice(SITE, {
    deviceId: till,
    label: `DPTEST till ${stamp}`,
    kind: 'desktop',
    platform: 'win32',
    appRole: 'pos',
  })
  const created = await getDevice(SITE, till)
  ok('a machine registers itself', created?.kind === 'desktop' && created.platform === 'win32')

  /* The two callers know different amounts. The catalog feed says only "a till
     asked for products"; the browser heartbeat knows the shell. Neither may
     erase what the other established, or the row flips on every page load. */
  await touchDevice(SITE, {
    deviceId: till,
    label: 'ignored',
    kind: 'unknown',
    platform: '',
    appRole: '',
  })
  const narrowed = await getDevice(SITE, till)
  ok(
    '*** a caller that knows less cannot erase what one that knew more said ***',
    narrowed?.kind === 'desktop' && narrowed.platform === 'win32' && narrowed.appRole === 'pos',
  )

  await renameDevice(SITE, till, `DPTEST front counter ${stamp}`)
  await touchDevice(SITE, {
    deviceId: till,
    label: 'a heartbeat label',
    kind: 'desktop',
    platform: 'win32',
    appRole: 'pos',
  })
  ok(
    '*** a heartbeat never overwrites a name a person typed ***',
    (await getDevice(SITE, till))?.label === `DPTEST front counter ${stamp}`,
  )

  ok('*** a machine this site does not know reads as absent ***',
     (await getDevice(SITE, `dptest-${stamp}-nope`)) === null)
  ok('a registered machine lists', (await listDevices(SITE)).some((d) => d.deviceId === till))

  /* ── 2. Printers, and what one machine can reach ─────────────────────── */
  console.log('\n── Printers ────────────────────────────────────────────────\n')

  /* A USB printer plugged into the till, and a network laser the shop shares.
     Since 247 each says so itself; there is no second table to consult. */
  const slip = await createPrinter(SITE, {
    name: `DPTEST Counter ${stamp}`,
    purpose: 'general',
    paper: 'slip80',
    slipColumns: null,
    connection: 'queue',
    deviceId: till,
    target: 'EPSON TM-T20III',
    shareName: '',
    port: null,
    drawerKick: true,
  })
  const laser = await createPrinter(SITE, {
    name: `DPTEST Office ${stamp}`,
    purpose: 'general',
    paper: 'a4',
    slipColumns: null,
    connection: 'network',
    deviceId: null,
    target: '192.0.2.20',
    shareName: '',
    port: 9100,
    drawerKick: false,
  })
  if (!slip.ok || !laser.ok) throw new Error('could not create printers')

  const printers = await listPrinters(SITE)
  const slipPrinter = printers.find((p) => p.id === slip.id)!
  const laserPrinter = printers.find((p) => p.id === laser.id)!

  ok('*** a queue printer is reachable from its own machine ***', reachableFrom(slipPrinter, till))
  ok('*** …and from no other ***', !reachableFrom(slipPrinter, office))
  ok('*** a network printer is reachable from anywhere ***',
     reachableFrom(laserPrinter, till) && reachableFrom(laserPrinter, office))
  ok('*** …and from a machine this shop has never seen ***', reachableFrom(laserPrinter, 'anything'))

  /* ── 3. Assignments ──────────────────────────────────────────────────── */
  console.log('\n── Assignments ─────────────────────────────────────────────\n')

  const blank = await assignmentsForDevice(SITE, till)
  ok(
    '*** every printable document appears, answered or not ***',
    blank.length === PRINT_DOCS.length,
    `${blank.length} of ${PRINT_DOCS.length}`,
  )
  ok('*** a machine with no rows reads as unset throughout ***', blank.every((a) => a.unset))

  const unknown = await setDocumentPrinter(SITE, till, 'not_a_document', { mode: 'printer', printerId: slip.id })
  ok('*** an unknown doc_key is refused ***', !unknown.ok)

  /* The refusal that saves a support call. Accepted, it produces nothing and
     explains nothing — the declaration has no ESC/POS renderer at all. */
  const wrongPaper = await setDocumentPrinter(SITE, till, 'cashup_declaration', {
    mode: 'printer',
    printerId: slip.id,
  })
  ok('*** an A4 document is refused by a slip printer ***', !wrongPaper.ok, wrongPaper.ok ? '' : wrongPaper.error)

  const rightPaper = await setDocumentPrinter(SITE, till, 'cashup_declaration', {
    mode: 'printer',
    printerId: laser.id,
  })
  ok('…and accepted by the A4 one', rightPaper.ok)

  ok(
    '*** copies outside 1..10 is refused ***',
    !(await setDocumentPrinter(SITE, till, 'slip', { mode: 'printer', printerId: slip.id, copies: 99 })).ok,
  )

  const saved = await setDocumentPrinter(SITE, till, 'slip', {
    mode: 'printer',
    printerId: slip.id,
    copies: 2,
  })
  ok('a document is pointed at a printer', saved.ok)

  const withSlip = await assignmentsForDevice(SITE, till)
  const slipRow = withSlip.find((a) => a.docKey === 'slip')!
  ok('the answer reads back', slipRow.printerId === slip.id && slipRow.copies === 2 && !slipRow.unset)

  /* Inheritance is DELIBERATE and NAMED. A destination whose origin a screen
     cannot state is one nobody can reason about. */
  const gift = withSlip.find((a) => a.docKey === 'gift_slip')!
  ok(
    '*** a gift slip inherits the till slip, and says where from ***',
    gift.printerId === slip.id && gift.inheritedFrom === 'slip' && !gift.unset,
  )

  await setDocumentPrinter(SITE, till, 'gift_slip', { mode: 'off' })
  const overridden = (await assignmentsForDevice(SITE, till)).find((a) => a.docKey === 'gift_slip')!
  ok('*** an explicit answer beats the inherited one ***',
     overridden.mode === 'off' && overridden.inheritedFrom === null)

  /* "Not set" and "use the browser" behave identically and are different facts:
     one is a shop that has not decided, one is a shop that has. */
  await setDocumentPrinter(SITE, till, 'invoice', { mode: 'browser' })
  const decided = (await assignmentsForDevice(SITE, till)).find((a) => a.docKey === 'invoice')!
  ok('*** "use the browser" is stored, not confused with unset ***',
     decided.mode === 'browser' && !decided.unset)

  await clearDocumentPrinter(SITE, till, 'invoice')
  const undecided = (await assignmentsForDevice(SITE, till)).find((a) => a.docKey === 'invoice')!
  ok('*** clearing deletes the row and returns to unset ***', undecided.unset)

  /* A printer switched off after the assignment was made. The row survives —
     that is the point of never deleting a printer — and must be FLAGGED. */
  await setPrinterActive(SITE, laser.id, false)
  const stranded = (await assignmentsForDevice(SITE, till)).find((a) => a.docKey === 'cashup_declaration')!
  ok('*** a document pointing at a switched-off printer is flagged ***', stranded.unreachable)
  ok('…and does not read as unset, which would hide it', !stranded.unset)
  await setPrinterActive(SITE, laser.id, true)

  /* ── 4. The offline blob ─────────────────────────────────────────────── */
  console.log('\n── What a till carries offline ─────────────────────────────\n')

  const config = await printConfigForDevice(SITE, till)
  ok('the blob names the machine', config.deviceId === till)
  ok(
    '*** an unreachable printer is dropped rather than sent with a blank address ***',
    config.printers.every((p) => p.target !== ''),
  )
  ok('a reachable printer carries its resolved address', config.printers.some((p) => p.target === 'EPSON TM-T20III'))
  ok(
    '*** the inherited network address rides along without a device row ***',
    config.printers.some((p) => p.id === laser.id && p.target === '192.0.2.20'),
  )
  ok('unset documents are not sent — the till infers them', config.assignments.every((a) => a.docKey !== 'purchase_order'))

  /* The whole round trip: what the server resolved is what an offline till
     decides. This is the assertion that connects the two halves. */
  const plan = planFor('slip', config)
  ok(
    '*** an offline till resolves the same printer the server did ***',
    plan.kind === 'printer' && plan.printer.id === slip.id && plan.copies === 2,
  )
  ok('*** and the same width, so the slip is not confetti ***',
     plan.kind === 'printer' && plan.printer.columns === 48)

  /* ── 5. Copying, and forgetting ──────────────────────────────────────── */
  console.log('\n── Copying and forgetting ──────────────────────────────────\n')

  await touchDevice(SITE, {
    deviceId: office,
    label: `DPTEST office ${stamp}`,
    kind: 'browser',
    platform: '',
    appRole: 'backoffice',
  })
  const copied = await copyPrintingSetup(SITE, till, office)
  ok('a machine copies another machine’s document assignments', copied.ok)

  const officeConfig = await printConfigForDevice(SITE, office)
  ok('*** the copy carries the document assignments ***',
     officeConfig.assignments.some((a) => a.docKey === 'slip'))

  /* And carries them HONESTLY. The copied slip assignment points at a printer
     plugged into the till, so on the office PC it is unreachable and says why —
     which is the truthful outcome, because that printer genuinely is somewhere
     else. Silently rewriting it to a local printer would be a guess. */
  ok('*** …but a printer plugged into the other machine stays unreachable ***',
     !officeConfig.printers.some((p) => p.target === 'EPSON TM-T20III'))
  const officeSlip = (await assignmentsForDevice(SITE, office)).find((a) => a.docKey === 'slip')!
  ok('…and the row says so in words', officeSlip.unreachable && officeSlip.unreachableBecause !== null,
     officeSlip.unreachableBecause ?? '')

  /* The network laser, by contrast, IS reachable from the copy — which is the
     whole reason a shared printer is worth defining as a network one. */
  ok('*** a network printer survives the copy and stays reachable ***',
     officeConfig.printers.some((p) => p.id === laser.id))
  ok('*** copying onto itself is refused ***', !(await copyPrintingSetup(SITE, till, till)).ok)
  ok('*** copying onto a machine this site does not know is refused ***',
     !(await copyPrintingSetup(SITE, till, `dptest-${stamp}-ghost`)).ok)

  await forgetDevice(SITE, office)
  ok('a forgotten machine is gone', (await getDevice(SITE, office)) === null)
  const orphanDocs = await siteQuery<any>(
    SITE,
    'SELECT * FROM device_document_printers WHERE device_id = ?',
    [office],
  )
  ok('*** forgetting cascades its document assignments ***', orphanDocs.length === 0)
  ok('*** …and touches no other machine ***', (await getDevice(SITE, till)) !== null)
  ok('…nor the shop’s printers', (await printConfigForDevice(SITE, till)).printers.length > 0)

  /* A queue printer whose machine is forgotten becomes UNCONFIGURED, not
     deleted. SET NULL rather than CASCADE, deliberately: deleting the printer
     would take four hundred products' kitchen routing with it, and the fix here
     is one click — pick a queue again. */
  await touchDevice(SITE, {
    deviceId: office,
    label: `DPTEST office ${stamp}`,
    kind: 'browser',
    platform: '',
    appRole: 'backoffice',
  })
  const doomed = await createPrinter(SITE, {
    name: `DPTEST Doomed ${stamp}`,
    purpose: 'general',
    paper: 'a4',
    slipColumns: null,
    connection: 'queue',
    deviceId: office,
    target: 'HP LaserJet',
    shareName: '',
    port: null,
    drawerKick: false,
  })
  if (!doomed.ok) throw new Error('could not create the doomed printer')
  await forgetDevice(SITE, office)
  const survivor = (await listPrinters(SITE, true)).find((p) => p.id === doomed.id)
  ok('*** forgetting a machine does NOT delete its printer ***', survivor !== undefined)
  ok('…it reads as needing to be finished', survivor?.unconfigured === true)
  ok('…and its machine reads as gone', survivor?.deviceId === null)

  /* Sweep. Printers last — device_document_printers holds an FK into them. */
  await siteExecute(SITE, "DELETE FROM devices WHERE device_id LIKE 'dptest-%'")
  await siteExecute(SITE, "DELETE FROM printers WHERE name LIKE 'DPTEST%'")

  console.log(
    fails === 0
      ? '\nEvery per-device printing rule holds.\n'
      : `\n${fails} check(s) failed.\n`,
  )
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
