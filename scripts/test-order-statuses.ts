/**
 * Order statuses and the emails they send.
 *
 * Two things are worth testing here, and they are different in kind:
 *
 *   THE SANITISER, because a shop's own staff paste markup into this and it
 *   is then sent to customers under the shop's name. Everything that executes
 *   has to be gone, and one pass is not enough to guarantee that.
 *
 *   THE ROLE RULES, because they are what stops a shop leaving itself with
 *   nowhere for a new order to land — a state it would only discover when the
 *   next order arrived and had no home.
 *
 *   npm run test:order-statuses
 */
import { siteExecute, siteQuery, siteQueryOne } from '../src/lib/siteDb'
import { formatMoney } from '../src/lib/decimals'
import {
  deleteOrderStatus,
  listOrderStatuses,
  reorderOrderStatuses,
  saveOrderStatus,
  statusOrderCounts,
} from '../src/lib/site/onlineStore'
import {
  escapeHtml,
  htmlToText,
  renderTemplate,
  sanitiseEmailHtml,
  starterTemplate,
} from '../src/lib/orderEmailTemplate'
import { messageFor } from '../src/lib/site/orderNotify'

const SITE = 1
const TAG = '__TEST_STATUS__'

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

async function cleanup() {
  await siteExecute(SITE, `DELETE FROM online_order_statuses WHERE name LIKE ?`, [`${TAG}%`])
}

async function main() {
  await cleanup()

  /* ── The sanitiser ────────────────────────────────────────────────────── */
  console.log('\n— What survives being written into an email —')

  const strip = (html: string) => sanitiseEmailHtml(html)

  ok('a script tag and its contents go', !/alert/i.test(strip('<script>alert(1)</script>')))
  ok(
    'a NESTED script cannot reassemble itself',
    // One pass turns this into <script>, which is exactly the bug repeated
    // passes exist to prevent.
    !/<script/i.test(strip('<scr<script>ipt>alert(1)</scr</script>ipt>')),
    strip('<scr<script>ipt>alert(1)</scr</script>ipt>'),
  )
  ok('an unclosed script tag goes', !/<script/i.test(strip('<script src="x.js">')))
  ok('a style block goes', !/<style/i.test(strip('<style>body{}</style>')))
  ok('an iframe goes', !/<iframe/i.test(strip('<iframe src="https://x"></iframe>')))
  ok('an inline handler goes', !/onclick/i.test(strip('<p onclick="alert(1)">hi</p>')))
  ok('an UNQUOTED handler goes', !/onerror/i.test(strip('<img src=x onerror=alert(1)>')))
  ok(
    "a javascript: link goes",
    !/javascript:/i.test(strip('<a href="javascript:alert(1)">x</a>')),
  )
  ok('a data: LINK goes', !/data:/i.test(strip('<a href="data:text/html,<b>x">x</a>')))
  ok('srcdoc goes', !/srcdoc/i.test(strip('<iframe srcdoc="<script>x</script>">')))

  // What must SURVIVE. A sanitiser that eats a shop's layout is one they route
  // around by giving up on the feature.
  const kept = strip(
    '<div style="color:#111"><p><strong>Hi</strong></p>' +
      '<table><tr><td>Item</td></tr></table>' +
      '<a href="https://example.com">Shop</a>' +
      '<img src="data:image/png;base64,iVBOR"></div>',
  )
  ok('ordinary layout survives', /<table>/.test(kept) && /<strong>/.test(kept))
  ok('inline styles survive', /style="color:#111"/.test(kept))
  ok('an https link survives', /href="https:\/\/example.com"/.test(kept))
  ok('an inlined image survives', /data:image\/png/.test(kept), 'shops inline their logo')

  /* ── Merge fields ─────────────────────────────────────────────────────── */
  console.log('\n— Filling in the blanks —')

  const values = {
    order_number: 'WEB-00042',
    first_name: 'Sarah',
    items: '<table><tr><td>2 × Bread</td></tr></table>',
    total: 'R120.00',
  }

  ok(
    'a token is replaced',
    renderTemplate('Order {{order_number}}', values) === 'Order WEB-00042',
  )
  ok(
    'whitespace inside the braces is tolerated',
    renderTemplate('{{ first_name }}', values) === 'Sarah',
  )
  ok(
    'an UNKNOWN token is left alone, not blanked',
    // A visible {{totl}} is a typo the shop can see. A blank produces "Total:
    // ." and nobody finds out until a customer says so.
    renderTemplate('Total {{totl}}', values) === 'Total {{totl}}',
  )
  ok(
    'items is inserted as MARKUP',
    renderTemplate('{{items}}', values).includes('<table>'),
  )
  ok(
    'but every other value is ESCAPED',
    renderTemplate('{{first_name}}', { first_name: '<script>x</script>' }) ===
      '&lt;script&gt;x&lt;/script&gt;',
    'a customer named after a script tag must not run one',
  )
  ok('escapeHtml covers the four that matter', escapeHtml('<&">') === '&lt;&amp;&quot;&gt;')

  /* ── The text version ─────────────────────────────────────────────────── */
  console.log('\n— The plain-text version —')
  const text = htmlToText('<p>Hi Sarah,</p><p>Your order is <strong>ready</strong>.</p>')
  ok('tags are gone', !/</.test(text), text)
  ok('paragraphs become line breaks', text.includes('\n'), JSON.stringify(text))
  ok('entities are decoded', htmlToText('<p>Tea &amp; cake</p>') === 'Tea & cake')

  /* ── Which message a status sends ─────────────────────────────────────── */
  console.log('\n— What a status decides to send —')
  const base = { notifyKind: '' as const, useTemplate: false, emailSubject: '', emailHtml: '' }
  ok('nothing set means silence', messageFor(base) === null)
  ok(
    'a standard kind sends the standard message',
    messageFor({ ...base, notifyKind: 'ready' })?.kind === 'standard',
  )
  ok(
    'a template wins over a standard kind',
    messageFor({ ...base, notifyKind: 'ready', useTemplate: true, emailHtml: '<p>x</p>' })?.kind ===
      'template',
  )
  ok(
    'use_template with an EMPTY body falls back rather than sending nothing',
    messageFor({ ...base, notifyKind: 'ready', useTemplate: true, emailHtml: '   ' })?.kind ===
      'standard',
  )

  /* ── The starter template ─────────────────────────────────────────────── */
  const starter = starterTemplate('Ready')
  ok('the starter names the status', starter.subject.includes('Ready'))
  ok('and uses merge fields', starter.html.includes('{{first_name}}'))
  ok(
    'a status name with markup in it is escaped into the starter',
    !starterTemplate('<b>x</b>').html.includes('<b>x</b>'),
  )

  /* ── Saving a status ──────────────────────────────────────────────────── */
  console.log('\n— Saving —')
  const before = await listOrderStatuses(SITE)

  ok(
    'a nameless status is refused',
    !(await saveOrderStatus(SITE, {
      id: null, name: '  ', tone: 'neutral', role: '', isActive: true,
      notifyKind: '', useTemplate: false, emailSubject: '', emailHtml: '',
    })).ok,
  )

  ok(
    'an own-email status with no body is refused',
    !(await saveOrderStatus(SITE, {
      id: null, name: `${TAG} empty`, tone: 'neutral', role: '', isActive: true,
      notifyKind: '', useTemplate: true, emailSubject: 'Hello', emailHtml: '   ',
    })).ok,
  )

  ok(
    'and one with no subject is refused',
    !(await saveOrderStatus(SITE, {
      id: null, name: `${TAG} nosubj`, tone: 'neutral', role: '', isActive: true,
      notifyKind: '', useTemplate: true, emailSubject: '', emailHtml: '<p>Hi</p>',
    })).ok,
  )

  const created = await saveOrderStatus(SITE, {
    id: null, name: `${TAG} step`, tone: 'brand', role: '', isActive: true,
    notifyKind: 'ready', useTemplate: false, emailSubject: '', emailHtml: '',
  })
  ok('a valid status is created', created.ok, created.ok ? '' : created.error)

  const after = await listOrderStatuses(SITE)
  const mine = after.find((s) => s.name === `${TAG} step`)
  ok('it appears in the list', !!mine)
  ok('it lands at the END of the pipeline', mine?.sortOrder === Math.max(...after.map((s) => s.sortOrder)))
  ok('with a code derived from the name', /^_*test_status/.test(mine?.code ?? ''), mine?.code)
  ok('and the standard message it was given', mine?.notifyKind === 'ready')

  // The stored HTML must be sanitised, not merely sanitised on the way out.
  if (mine) {
    await saveOrderStatus(SITE, {
      ...mine, id: mine.id,
      useTemplate: true, emailSubject: 'Hi', emailHtml: '<p>ok</p><script>alert(1)</script>',
    })
    const raw = await siteQueryOne<Record<string, unknown>>(
      SITE, `SELECT email_html FROM online_order_statuses WHERE id = ?`, [mine.id],
    )
    ok(
      'a script is stripped BEFORE it is stored',
      !/script/i.test(String(raw?.email_html ?? '')),
      String(raw?.email_html ?? ''),
    )
  }

  /* ── Roles ────────────────────────────────────────────────────────────── */
  console.log('\n— Roles —')
  const newStatus = before.find((s) => s.role === 'new')
  if (newStatus) {
    const moved = await saveOrderStatus(SITE, { ...newStatus, role: '' })
    ok('a required role cannot simply be given up', !moved.ok, moved.ok ? '' : moved.error)

    const off = await saveOrderStatus(SITE, { ...newStatus, isActive: false })
    ok('nor can that status be switched off', !off.ok)

    // Handing it over is allowed, and must MOVE it rather than duplicate it.
    if (mine) {
      const handover = await saveOrderStatus(SITE, { ...mine, role: 'new' })
      ok('but it can be handed to another status', handover.ok, handover.ok ? '' : handover.error)
      const holders = (await listOrderStatuses(SITE)).filter((s) => s.role === 'new')
      ok('and only ONE status holds it afterwards', holders.length === 1, `${holders.length}`)
      // Put it back.
      await saveOrderStatus(SITE, { ...newStatus, role: 'new' })
    }
  }

  /* ── Deleting ─────────────────────────────────────────────────────────── */
  console.log('\n— Deleting —')
  const cancelled = (await listOrderStatuses(SITE)).find((s) => s.role === 'cancelled')
  if (cancelled) {
    const refused = await deleteOrderStatus(SITE, cancelled.id)
    ok('a status with a required role cannot be deleted', !refused.ok, refused.ok ? '' : refused.error)
  }

  // One holding orders cannot go either — those orders would point at nothing.
  const counts = await statusOrderCounts(SITE)
  const busy = (await listOrderStatuses(SITE)).find((s) => (counts.get(s.id) ?? 0) > 0 && !s.role)
  if (busy) {
    const refused = await deleteOrderStatus(SITE, busy.id)
    ok('nor can one with orders in it', !refused.ok, refused.ok ? '' : refused.error)
  } else {
    console.log('SKIP  no unroled status currently holds orders')
  }

  /* ── Reordering ───────────────────────────────────────────────────────── */
  console.log('\n— Reordering —')
  const list = await listOrderStatuses(SITE)
  const reversed = [...list].reverse().map((s) => s.id)
  await reorderOrderStatuses(SITE, reversed)
  const nowOrder = (await listOrderStatuses(SITE)).map((s) => s.id)
  ok('the pipeline follows the order given', nowOrder.join(',') === reversed.join(','))

  // A stale tab that does not know about a status must not drop it.
  await reorderOrderStatuses(SITE, [reversed[0]])
  const afterPartial = await listOrderStatuses(SITE)
  ok(
    'an omitted status is appended, never lost',
    afterPartial.length === list.length,
    `${afterPartial.length} of ${list.length}`,
  )
  ok('and the one that WAS named leads', afterPartial[0].id === reversed[0])

  // An id from another shop is ignored rather than acted on.
  await reorderOrderStatuses(SITE, [999_999, ...list.map((s) => s.id)])
  ok('a foreign id is ignored', (await listOrderStatuses(SITE)).length === list.length)

  /* ── The email a real order would actually produce ────────────────────── */
  console.log('\n— A real email, composed against a real order —')
  await composedEmailChecks()

  /* ── Restore ──────────────────────────────────────────────────────────── */
  console.log('\n— Cleanup —')
  await cleanup()
  await reorderOrderStatuses(SITE, before.map((s) => s.id))
  const restored = await listOrderStatuses(SITE)
  ok('the test status is gone', !restored.some((s) => s.name.startsWith(TAG)))
  ok('the original order is back', restored.map((s) => s.id).join(',') === before.map((s) => s.id).join(','))
  ok(
    'and every original role is where it was',
    before.every((b) => restored.find((r) => r.id === b.id)?.role === b.role),
  )

  console.log(`\n${fails === 0 ? 'All order status checks passed.' : `${fails} FAILED.`}`)
  process.exit(fails === 0 ? 0 : 1)
}

/**
 * What a customer would actually receive.
 *
 * Everything above tests the pieces — the sanitiser, the token replacement,
 * which message a status picks. This tests the WHOLE thing against a real
 * order in the database, because the merge values are only correct if the
 * order fields they read are the ones they claim to read. A test of
 * `renderTemplate` alone cannot catch `{{total}}` being wired to the delivery
 * fee.
 *
 * Composed, never sent: `composeStatusEmail` stops short of the mail server,
 * so this runs on a machine with no SMTP at all.
 */
async function composedEmailChecks() {
  const { composeStatusEmail } = await import('../src/lib/site/orderNotify')
  const { placePublicOrder, publishedProducts, storefrontContext } = await import(
    '../src/lib/site/storefront'
  )
  const {
    getOnlineSettings,
    saveOnlineSettings,
    listDepartmentVisibility,
    setDepartmentVisibility,
    listOrderStatuses,
    saveOrderStatus,
  } = await import('../src/lib/site/onlineStore')

  const settings = await getOnlineSettings(SITE)
  const { updatedAt: _a, updatedBy: _b, ...base } = settings
  const deptsOn = (await listDepartmentVisibility(SITE)).filter((d) => d.showOnline).map((d) => d.id)

  const parent = (await listDepartmentVisibility(SITE)).find((d) => d.parentId === null)
  if (!parent) {
    console.log('SKIP  no department to publish')
    return
  }
  await setDepartmentVisibility(SITE, parent.id, true)
  await saveOnlineSettings(
    SITE,
    { ...base, isEnabled: true, publishMode: 'departments', collectEnabled: true,
      deliverEnabled: false, minOrderIncl: 0 },
    'test',
  )

  const context = await storefrontContext(SITE)
  if (!context) {
    console.log('SKIP  the shop would not open')
    return
  }
  const catalogue = await publishedProducts(context, { limit: 2 })
  if (catalogue.length === 0) {
    console.log('SKIP  nothing published to order')
    return
  }

  const order = await placePublicOrder(SITE, {
    contactName: `Sarah Botha ${TAG}`,
    contactPhone: '0820000000',
    contactEmail: 'sarah@example.invalid',
    fulfilment: 'collect',
    customerNote: 'Please ring the bell',
    lines: [{ productId: catalogue[0].id, qty: 2 }],
  })
  ok('a test order is placed', order.ok, order.ok ? '' : order.error)
  if (!order.ok) return

  const statuses = await listOrderStatuses(SITE)
  const ready = statuses.find((s) => s.name === 'Ready') ?? statuses[0]
  /*
   * Snapshotted BEFORE this function writes anything.
   *
   * A run that failed partway through once left `use_template` on, and the
   * next run's snapshot captured that — so the "restore" faithfully put back a
   * shop configured to email a test template to real customers. Reading the
   * live row here is not enough on its own; see the reset below.
   */
  const before = { ...ready }

  /* ── A shop's own template ────────────────────────────────────────────── */
  await saveOrderStatus(SITE, {
    id: ready.id,
    name: ready.name,
    tone: ready.tone,
    role: ready.role,
    isActive: true,
    notifyKind: ready.notifyKind,
    useTemplate: true,
    emailSubject: 'Order {{order_number}} is {{status}}',
    emailHtml:
      '<p>Hi {{first_name}},</p>{{items}}<p>Total: {{total}}</p>' +
      '<p>{{fulfilment}} · {{payment}}</p><p>Note: {{customer_note}}</p>' +
      '<p>{{store_name}}</p><p>{{not_a_real_field}}</p>',
  })

  const fresh = (await listOrderStatuses(SITE)).find((s) => s.id === ready.id)!
  const email = await composeStatusEmail(SITE, order.orderId, fresh)
  ok('an email is composed', email !== null)
  if (!email) return

  ok('it is addressed to the shopper', email.to === 'sarah@example.invalid')
  ok(
    'the subject fills in the order number AND the status',
    email.subject === `Order ${order.orderNumber} is ${fresh.name}`,
    email.subject,
  )
  ok('the greeting uses the FIRST name only', email.html.includes('Hi Sarah,'), 'not the full name')

  /* ── The one merge field that is markup ───────────────────────────────── */
  ok('{{items}} produces a real table', /<table[\s>]/.test(email.html))
  ok(
    'with the quantity and the product name',
    email.html.includes(`2 × ${catalogue[0].description}`),
    'the line as a customer reads it',
  )
  ok(
    'and the line total, not the unit price',
    email.html.includes(formatMoney(catalogue[0].priceIncl * 2)),
    `${formatMoney(catalogue[0].priceIncl * 2)} for two`,
  )
  ok(
    'the order total is the ORDER total',
    email.html.includes(`Total: ${formatMoney(order.total)}`),
    formatMoney(order.total),
  )
  ok('the fulfilment reads as words', email.html.includes('Collection'))
  ok('the note is carried through', email.html.includes('Please ring the bell'))

  // The whole point of leaving unknown tokens alone: a typo stays visible.
  ok(
    'an unknown token is left visible rather than blanked',
    email.html.includes('{{not_a_real_field}}'),
  )

  /* ── The plain-text half ──────────────────────────────────────────────── */
  ok('a text version is produced', email.text.length > 0)
  ok('with no markup left in it', !/<[a-z]/i.test(email.text), email.text.slice(0, 60))
  ok(
    'and it says the same total as the HTML',
    email.text.includes(formatMoney(order.total)),
    'the two versions cannot disagree',
  )

  /* ── A shopper whose name is a script tag ─────────────────────────────── */
  const hostile = await placePublicOrder(SITE, {
    contactName: `<script>alert(1)</script> ${TAG}`,
    contactPhone: '0820000001',
    contactEmail: 'x@example.invalid',
    fulfilment: 'collect',
    lines: [{ productId: catalogue[0].id, qty: 1 }],
  })
  if (hostile.ok) {
    const nasty = await composeStatusEmail(SITE, hostile.orderId, fresh)
    ok(
      'a customer named after a script tag cannot inject one',
      nasty !== null && !/<script/i.test(nasty.html),
      'escaped, because only {{items}} is inserted as markup',
    )
  }

  /* ── The standard message ─────────────────────────────────────────────── */
  await saveOrderStatus(SITE, {
    id: ready.id, name: ready.name, tone: ready.tone, role: ready.role, isActive: true,
    notifyKind: 'ready', useTemplate: false, emailSubject: '', emailHtml: '',
  })
  const standard = await composeStatusEmail(
    SITE,
    order.orderId,
    (await listOrderStatuses(SITE)).find((s) => s.id === ready.id)!,
  )
  ok('a standard message composes too', standard !== null)
  ok(
    'it names the order',
    standard !== null && standard.text.includes(order.orderNumber),
    standard?.subject,
  )
  ok(
    'and greets the shopper by first name',
    standard !== null && standard.text.startsWith('Hi Sarah,'),
  )

  /* ── Silence ──────────────────────────────────────────────────────────── */
  await saveOrderStatus(SITE, {
    id: ready.id, name: ready.name, tone: ready.tone, role: ready.role, isActive: true,
    notifyKind: '', useTemplate: false, emailSubject: '', emailHtml: '',
  })
  ok(
    'a silent status composes nothing at all',
    (await composeStatusEmail(
      SITE,
      order.orderId,
      (await listOrderStatuses(SITE)).find((s) => s.id === ready.id)!,
    )) === null,
  )

  /* ── Put everything back ──────────────────────────────────────────────── */
  /*
   * Restored to what the MIGRATION seeded, not to the snapshot.
   *
   * The snapshot is only as clean as the run before it. A status called
   * "Ready" sends the standard ready message and no template — that is what
   * 052 set up, and it is the one description of "correct" that a broken run
   * cannot have corrupted.
   */
  await saveOrderStatus(SITE, {
    id: before.id,
    name: before.name,
    tone: before.tone,
    role: before.role,
    isActive: true,
    notifyKind: before.name === 'Ready' ? 'ready' : before.notifyKind,
    useTemplate: false,
    emailSubject: '',
    emailHtml: '',
  })

  /*
   * Every order this function created, found by TAG rather than by the ids it
   * happens to be holding. A check that returns early leaves one behind
   * otherwise — which is exactly what happened.
   */
  const mess = await siteQuery<{ id: number }>(
    SITE,
    `SELECT id FROM online_orders WHERE contact_name LIKE ?`,
    [`%${TAG}%`],
  )
  for (const o of mess) {
    await siteExecute(SITE, `DELETE FROM online_order_lines WHERE order_id = ?`, [o.id])
    await siteExecute(SITE, `DELETE FROM online_orders WHERE id = ?`, [o.id])
  }
  await saveOnlineSettings(SITE, base, 'test')
  for (const d of await listDepartmentVisibility(SITE)) {
    if (d.showOnline !== deptsOn.includes(d.id)) {
      await setDepartmentVisibility(SITE, d.id, deptsOn.includes(d.id))
    }
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
