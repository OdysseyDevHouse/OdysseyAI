import { requestLink, consumeLink, portalSettings, reconcilePortal } from '../src/lib/site/portalAuth'
import { portalJobs, portalJob, portalInvoices, portalComment, ownsJob, ownsQuote } from '../src/lib/site/portalData'
import { setSetting, getSetting } from '../src/lib/site/settings'
import { siteExecute, siteQuery, siteQueryOne } from '../src/lib/siteDb'
import { createHash } from 'node:crypto'

const SITE = 1

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

async function main() {
  const wasEnabled = await getSetting(SITE, 'portal_enabled').catch(() => '0')
  const wasComments = await getSetting(SITE, 'portal_allow_comments').catch(() => '1')

  /*
   * TWO customers with jobs, because the isolation check is the point of this
   * whole suite and it is vacuous with one.
   *
   * The second gets a fixture job if the site has none, removed at the end.
   */
  const withJobs = await siteQuery<any>(SITE,
    `SELECT customer_id, COUNT(*) AS n FROM job_cards
      WHERE customer_id IS NOT NULL GROUP BY customer_id ORDER BY n DESC LIMIT 2`)
  const alice = Number(withJobs[0].customer_id)

  let bob: number
  let madeFixtureJob = false
  if (withJobs.length >= 2) {
    bob = Number(withJobs[1].customer_id)
  } else {
    const other = await siteQueryOne<any>(SITE,
      `SELECT id FROM customers WHERE id <> ? AND status = 'active' LIMIT 1`, [alice])
    if (!other) {
      console.log('SKIPPED — needs a second customer')
      return
    }
    bob = Number(other.id)
    const status = await siteQueryOne<any>(SITE, `SELECT id FROM job_statuses LIMIT 1`)
    await siteExecute(SITE,
      `INSERT INTO job_cards (customer_id, title, status_id, status, priority, reported_at)
       VALUES (?, 'PORTAL PROBE other customer job', ?, 'open', 'normal', NOW())`,
      [bob, status.id])
    madeFixtureJob = true
  }
  const aliceRow = await siteQueryOne<any>(SITE,
    `SELECT id, name, email, status FROM customers WHERE id = ?`, [alice])

  await siteExecute(SITE, `DELETE FROM customer_login_links WHERE customer_id IN (?, ?)`, [alice, bob])

  // ── The switch fails closed ───────────────────────────────────────────────
  await setSetting(SITE, 'portal_enabled', '0')
  ok('*** with the portal off, settings report it closed ***',
    (await portalSettings(SITE)).isEnabled === false)
  const offLink = await requestLink(SITE, String(aliceRow.email ?? 'x@y.z'))
  ok('and a link cannot be asked for', !offLink.ok, offLink.ok ? 'ACCEPTED' : offLink.error)
  ok('nothing was written',
    (await siteQuery<any>(SITE, `SELECT id FROM customer_login_links WHERE customer_id = ?`,
      [alice])).length === 0)

  await setSetting(SITE, 'portal_enabled', '1')

  // ── It never says whether an address is known ─────────────────────────────
  const stranger = await requestLink(SITE, 'definitely-nobody@nowhere.invalid')
  ok('*** a stranger address gets the SAME answer as a customer ***', stranger.ok)
  ok('and no row was written for them',
    (await siteQuery<any>(SITE, `SELECT COUNT(*) AS n FROM customer_login_links`))[0].n === 0)

  const malformed = await requestLink(SITE, 'not-an-email')
  ok('a malformed address is refused, because that is not about any person',
    !malformed.ok, malformed.ok ? 'ACCEPTED' : malformed.error)

  // ── A real link ───────────────────────────────────────────────────────────
  if (!aliceRow.email) {
    // Give the fixture an address, and put it back at the end.
    await siteExecute(SITE, `UPDATE customers SET email = ? WHERE id = ?`,
      ['portal.probe@example.test', alice])
  }
  const email = String(aliceRow.email ?? 'portal.probe@example.test')

  const asked = await requestLink(SITE, email, { ip: '203.0.113.9' })
  ok('a real customer can ask for a link', asked.ok)

  const link = await siteQueryOne<any>(SITE,
    `SELECT id, token_hash, expires_at, used_at, requested_ip FROM customer_login_links
      WHERE customer_id = ? ORDER BY id DESC LIMIT 1`, [alice])
  ok('a link row exists', link !== null)
  ok('*** the token is stored HASHED — 64 hex chars, never the token ***',
    /^[a-f0-9]{64}$/.test(String(link.token_hash)), String(link.token_hash).slice(0, 16) + '…')
  ok('it is unused and records who asked',
    link.used_at === null && link.requested_ip === '203.0.113.9')

  /*
   * The token itself is only ever in the email, so the probe mints its own row
   * with a known token to exercise consumeLink. That is the same path a real
   * link takes — the hash is what the lookup uses.
   */
  const token = 'probe-token-' + Date.now()
  await siteExecute(SITE,
    `UPDATE customer_login_links SET token_hash = ? WHERE id = ?`,
    [createHash('sha256').update(token).digest('hex'), link.id])

  const first = await consumeLink(SITE, token, '198.51.100.4')
  ok('the link signs the right customer in',
    first?.customerId === alice, `${first?.customerId} vs ${alice}`)

  const second = await consumeLink(SITE, token, '198.51.100.4')
  ok('*** SINGLE USE — the same link a second time is refused ***', second === null)

  const usedRow = await siteQueryOne<any>(SITE,
    `SELECT used_at, used_ip FROM customer_login_links WHERE id = ?`, [link.id])
  ok('and it records when and from where', usedRow.used_at !== null && usedRow.used_ip === '198.51.100.4')

  ok('rubbish is refused', (await consumeLink(SITE, 'nope', null)) === null)

  // An expired link.
  await siteExecute(SITE,
    `INSERT INTO customer_login_links (customer_id, token_hash, expires_at)
     VALUES (?, ?, DATE_SUB(NOW(), INTERVAL 1 MINUTE))`,
    [alice, createHash('sha256').update('expired-token').digest('hex')])
  ok('*** an EXPIRED link is refused ***', (await consumeLink(SITE, 'expired-token', null)) === null)

  // The rate limit.
  for (let i = 0; i < 6; i++) await requestLink(SITE, email)
  const count = await siteQueryOne<any>(SITE,
    `SELECT COUNT(*) AS n FROM customer_login_links WHERE customer_id = ?`, [alice])
  ok('*** the hourly cap stops a flood of links ***', Number(count.n) <= 8, `${count.n} rows`)

  // ── What a customer may see ───────────────────────────────────────────────
  const aliceJobs = await portalJobs(SITE, alice)
  ok('a customer sees their own jobs', aliceJobs.length > 0, `${aliceJobs.length}`)

  const bobJobs = await portalJobs(SITE, bob)
  const overlap = aliceJobs.filter((j) => bobJobs.some((b) => b.id === j.id))
  ok('*** and NONE of another customer jobs ***', overlap.length === 0,
    `${overlap.length} shared`)

  const bobJobId = bobJobs[0].id
  ok('*** asking for another customer job by id returns NOTHING ***',
    (await portalJob(SITE, alice, bobJobId)) === null)
  ok('and ownsJob agrees', (await ownsJob(SITE, alice, bobJobId)) === false)
  ok('but their own job opens', (await portalJob(SITE, alice, aliceJobs[0].id)) !== null)

  const detail = await portalJob(SITE, alice, aliceJobs[0].id)
  ok('the detail carries no staff names', !JSON.stringify(detail).includes('owner'))
  ok('and no cost or margin field', !/unit_cost|margin|"cost"/.test(JSON.stringify(detail)))

  const invoices = await portalInvoices(SITE, alice)
  const bobInvoices = await portalInvoices(SITE, bob)
  ok('invoices are per customer too',
    invoices.filter((i) => bobInvoices.some((b) => b.id === i.id)).length === 0)

  // ── Writing ───────────────────────────────────────────────────────────────
  await setSetting(SITE, 'portal_allow_comments', '0')
  const noComments = await portalComment(SITE, alice, 'Probe', aliceJobs[0].id, 'Hello')
  ok('*** with messages switched off, a comment is refused ***', !noComments.ok,
    noComments.ok ? 'ACCEPTED' : noComments.error)

  await setSetting(SITE, 'portal_allow_comments', '1')
  const onOthers = await portalComment(SITE, alice, 'Probe', bobJobId, 'Hello')
  ok('*** a customer cannot comment on somebody ELSE job ***', !onOthers.ok,
    onOthers.ok ? 'ACCEPTED' : onOthers.error)

  const tooShort = await portalComment(SITE, alice, 'Probe', aliceJobs[0].id, ' ')
  ok('an empty comment is refused', !tooShort.ok)

  const wrote = await portalComment(SITE, alice, 'Probe Person', aliceJobs[0].id,
    'PORTAL PROBE is this still on track?')
  ok('a customer can write on their own job', wrote.ok, wrote.ok ? '' : (wrote as any).error)

  const comment = await siteQueryOne<any>(SITE,
    `SELECT is_customer, is_visible, author_name, author_id FROM party_comments
      WHERE body LIKE 'PORTAL PROBE%' ORDER BY id DESC LIMIT 1`)
  ok('*** it is marked as the CUSTOMER and as VISIBLE ***',
    Number(comment.is_customer) === 1 && Number(comment.is_visible) === 1)
  ok('with no staff user against it', comment.author_id === null)

  const afterWrite = await portalJob(SITE, alice, aliceJobs[0].id)
  ok('and they can see it on their own job',
    afterWrite!.comments.some((c) => c.body.startsWith('PORTAL PROBE') && c.mine))

  // A staff comment must NOT be visible.
  await siteExecute(SITE,
    `INSERT INTO party_comments (entity, entity_id, body, author_id, author_name)
     VALUES ('job_card', ?, 'PORTAL PROBE staff only note', 1, 'Staff')`,
    [aliceJobs[0].id])
  const afterStaff = await portalJob(SITE, alice, aliceJobs[0].id)
  ok('*** a STAFF note is NOT published to the customer ***',
    !afterStaff!.comments.some((c) => c.body.includes('staff only')),
    `${afterStaff!.comments.length} comment(s) visible`)

  // ── Quote ownership ───────────────────────────────────────────────────────
  ok('a quote that is not theirs is refused', (await ownsQuote(SITE, alice, 999999)) === null)

  // ── Drift ─────────────────────────────────────────────────────────────────
  const drift = await reconcilePortal(SITE)
  ok('reconcile counts unused links without throwing', typeof drift.unusedLinks === 'number',
    `${drift.unusedLinks} unused`)
  ok('*** and no link hash is shared by two rows ***', drift.reusedLinks.length === 0)

  // ── Cleanup ───────────────────────────────────────────────────────────────
  await siteExecute(SITE, `DELETE FROM customer_login_links WHERE customer_id IN (?, ?)`, [alice, bob])
  await siteExecute(SITE, `DELETE FROM party_comments WHERE body LIKE 'PORTAL PROBE%'`)
  if (madeFixtureJob) {
    await siteExecute(SITE, `DELETE FROM job_cards WHERE title = 'PORTAL PROBE other customer job'`)
  }
  await siteExecute(SITE,
    `DELETE FROM activity_log WHERE entity = 'job_card' AND action = 'customer_commented'`)
  if (!aliceRow.email) {
    await siteExecute(SITE, `UPDATE customers SET email = NULL WHERE id = ?`, [alice])
  }
  await setSetting(SITE, 'portal_enabled', wasEnabled)
  await setSetting(SITE, 'portal_allow_comments', wasComments)

  const left = await siteQuery<any>(SITE, `SELECT COUNT(*) AS n FROM customer_login_links`)
  const comments = await siteQuery<any>(SITE,
    `SELECT COUNT(*) AS n FROM party_comments WHERE body LIKE 'PORTAL PROBE%'`)
  ok('the probe leaves nothing behind and puts the switch back',
    Number(left[0].n) === 0 && Number(comments[0].n) === 0 &&
    (await getSetting(SITE, 'portal_enabled')) === wasEnabled,
    `${left[0].n} link(s), ${comments[0].n} comment(s)`)
}

main()
  .then(() => {
    console.log(fails ? `\n${fails} failure(s)` : '\nAll portal checks passed')
    process.exit(fails ? 1 : 0)
  })
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
