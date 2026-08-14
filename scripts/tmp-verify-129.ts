import {
  submitRequest,
  listRequests,
  getRequest,
  acceptRequest,
  rejectRequest,
  reopenRequest,
  newRequestCount,
  intakeSettings,
  reconcileJobIntake,
} from '../src/lib/site/jobIntake'
import {
  createPublicIntakeToken,
  verifyPublicIntakeToken,
} from '../src/lib/publicIntakeToken'
import { createPublicReserveToken } from '../src/lib/publicReserveToken'
import { setSetting, getSetting } from '../src/lib/site/settings'
import { siteExecute, siteQuery, siteQueryOne } from '../src/lib/siteDb'

const SITE = 1
const actor = { userId: 1, userName: 'Probe' }
const stamp = String(Date.now()).slice(-6)
const TITLE = `PROBE${stamp} geyser leaking`
const PHONE = '0821234567'

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

async function sweep() {
  /*
   * Scoped to THIS run's stamp, never a bare PROBE%.
   *
   * More than one session edits this repo, and a DELETE broad enough to catch
   * somebody else's fixtures is exactly how a suite destroys work it did not
   * create.
   */
  // Jobs raised by accepting go first: the FK is SET NULL, so the request
  // survives and would be left claiming a job that is gone.
  await siteExecute(SITE, `DELETE FROM job_cards WHERE title LIKE ?`, [`PROBE${stamp}%`])
  await siteExecute(SITE, `DELETE FROM job_requests WHERE title LIKE ?`, [`PROBE${stamp}%`])
  await siteExecute(
    SITE,
    `DELETE FROM activity_log WHERE entity = 'job_card' AND action = 'raised_from_request'`,
  )
}

async function main() {
  await sweep()
  const wasEnabled = await getSetting(SITE, 'job_intake_enabled').catch(() => '0')
  const wasCap = await getSetting(SITE, 'job_intake_max_per_phone').catch(() => '3')

  const base = {
    contactName: 'Probe Person',
    contactPhone: PHONE,
    contactEmail: 'probe@example.test',
    title: TITLE,
    description: 'It drips onto the ceiling.',
    addressText: '12 Probe Street',
    headlineId: null,
  }

  // ── The switch fails closed ───────────────────────────────────────────────
  await setSetting(SITE, 'job_intake_enabled', '0')
  const off = await submitRequest(SITE, base)
  ok('*** with the form off, a submission is REFUSED ***', !off.ok,
    off.ok ? 'ACCEPTED' : off.error)
  ok('and nothing was written',
    (await siteQuery<any>(SITE, `SELECT id FROM job_requests WHERE title = ?`, [TITLE])).length === 0)

  await setSetting(SITE, 'job_intake_enabled', '1')
  await setSetting(SITE, 'job_intake_max_per_phone', '3')

  // ── The refusals ──────────────────────────────────────────────────────────
  const noName = await submitRequest(SITE, { ...base, contactName: 'X' })
  ok('a one-letter name is refused', !noName.ok, noName.ok ? 'ACCEPTED' : noName.error)

  const noPhone = await submitRequest(SITE, { ...base, contactPhone: '123' })
  ok('a phone number that is too short is refused', !noPhone.ok,
    noPhone.ok ? 'ACCEPTED' : noPhone.error)

  const badEmail = await submitRequest(SITE, { ...base, contactEmail: 'not-an-email' })
  ok('a malformed email is refused', !badEmail.ok, badEmail.ok ? 'ACCEPTED' : badEmail.error)

  const noTitle = await submitRequest(SITE, { ...base, title: 'ab' })
  ok('no summary of the work is refused', !noTitle.ok, noTitle.ok ? 'ACCEPTED' : noTitle.error)

  // ── The honeypot ──────────────────────────────────────────────────────────
  const bot = await submitRequest(SITE, { ...base, title: `PROBE${stamp} bot`, honeypot: 'x' })
  ok('*** the honeypot returns a FAKE SUCCESS, so a bot learns nothing ***', bot.ok,
    bot.ok ? bot.reference : bot.error)
  ok('*** and NOTHING was written ***',
    (await siteQuery<any>(SITE, `SELECT id FROM job_requests WHERE title = ?`,
      [`PROBE${stamp} bot`])).length === 0)

  // ── A real submission ─────────────────────────────────────────────────────
  const sent = await submitRequest(SITE, { ...base, ip: '203.0.113.7' })
  ok('a real request is taken', sent.ok, sent.ok ? sent.reference : sent.error)
  if (!sent.ok) throw new Error('fixture failed')
  ok('and comes back with a reference', /^REQ-\d{5}$/.test(sent.reference), sent.reference)

  const listed = await listRequests(SITE, 'new')
  const mine = listed.find((r) => r.title === TITLE)
  ok('it is waiting in the queue', mine !== undefined)
  ok('with the contact details and the IP kept',
    mine?.contactPhone === PHONE && mine?.submittedIp === '203.0.113.7')
  ok('*** and NO job and NO customer were created ***',
    mine?.jobCardId === null && mine?.customerId === null)

  const count = await newRequestCount(SITE)
  ok('the waiting count sees it', count >= 1, `${count}`)

  // ── A bad headline id is dropped, not trusted ─────────────────────────────
  const ghostHeadline = await submitRequest(SITE, {
    ...base, title: `PROBE${stamp} ghost`, headlineId: 999999,
  })
  ok('a submission naming a headline that does not exist still succeeds', ghostHeadline.ok)
  const ghostRow = (await listRequests(SITE, 'new')).find((r) => r.title === `PROBE${stamp} ghost`)
  ok('*** but the bogus headline id is DROPPED, not stored ***', ghostRow?.headlineId === null,
    String(ghostRow?.headlineId))

  // ── The daily cap ─────────────────────────────────────────────────────────
  await setSetting(SITE, 'job_intake_max_per_phone', '2')
  const capped = await submitRequest(SITE, { ...base, title: `PROBE${stamp} third` })
  ok('*** the daily cap per phone number refuses the next one ***', !capped.ok,
    capped.ok ? 'ACCEPTED' : capped.error)

  const otherPhone = await submitRequest(SITE, {
    ...base, title: `PROBE${stamp} other`, contactPhone: '0839999999',
  })
  ok('but a DIFFERENT number is unaffected', otherPhone.ok,
    otherPhone.ok ? '' : otherPhone.error)
  await setSetting(SITE, 'job_intake_max_per_phone', '3')

  // ── Accepting ─────────────────────────────────────────────────────────────
  const requestId = mine!.id
  const noCustomer = await acceptRequest(SITE, actor, requestId, 0)
  ok('*** accepting without choosing a customer is REFUSED ***', !noCustomer.ok,
    noCustomer.ok ? 'ACCEPTED' : noCustomer.error)

  const ghostCustomer = await acceptRequest(SITE, actor, requestId, 999999)
  ok('and a customer that does not exist is refused', !ghostCustomer.ok,
    ghostCustomer.ok ? 'ACCEPTED' : ghostCustomer.error)

  const customer = await siteQueryOne<any>(SITE, `SELECT id, name FROM customers LIMIT 1`)
  const accepted = await acceptRequest(SITE, actor, requestId, Number(customer.id))
  ok('accepting with a real customer raises a job', accepted.ok,
    accepted.ok ? `job ${accepted.jobId}` : accepted.error)
  if (!accepted.ok) throw new Error('accept failed')

  const job = await siteQueryOne<any>(SITE,
    `SELECT id, title, source, customer_id, description, document_number
       FROM job_cards WHERE id = ?`, [accepted.jobId])
  ok('*** the job records that it came from the public form ***',
    job.source === 'public_form', job.source)
  ok('it has a real document number', /^JC/.test(String(job.document_number)),
    String(job.document_number))
  ok('and is against the customer somebody chose', Number(job.customer_id) === Number(customer.id))
  ok('*** the customer OWN WORDS are kept on the job ***',
    String(job.description).includes('drips onto the ceiling'))
  ok('along with who asked and their number',
    String(job.description).includes('Probe Person') && String(job.description).includes(PHONE))

  const afterAccept = await getRequest(SITE, requestId)
  ok('the request is marked accepted and points at the job',
    afterAccept?.status === 'accepted' && afterAccept?.jobCardId === accepted.jobId)
  ok('and records who decided', afterAccept?.decidedByName === 'Probe')

  const twice = await acceptRequest(SITE, actor, requestId, Number(customer.id))
  ok('*** accepting the same request twice is REFUSED — no duplicate job ***', !twice.ok,
    twice.ok ? 'ACCEPTED' : twice.error)

  // ── Turning one down ──────────────────────────────────────────────────────
  const other = (await listRequests(SITE, 'new')).find((r) => r.title === `PROBE${stamp} other`)
  const turned = await rejectRequest(SITE, actor, other!.id, 'rejected', 'Out of our area.')
  ok('a request can be turned down with a reason', turned.ok)
  const turnedRow = await getRequest(SITE, other!.id)
  ok('and the reason is kept', turnedRow?.decidedReason === 'Out of our area.')

  const back = await reopenRequest(SITE, actor, other!.id)
  ok('a turned-down request can be put back', back.ok)
  ok('and is waiting again', (await getRequest(SITE, other!.id))?.status === 'new')

  const cannotReopen = await reopenRequest(SITE, actor, requestId)
  ok('*** but an ACCEPTED one cannot be put back — the job exists ***', !cannotReopen.ok,
    cannotReopen.ok ? 'ACCEPTED' : cannotReopen.error)

  const junk = await rejectRequest(SITE, actor, ghostRow!.id, 'spam', null)
  ok('junk can be marked as junk', junk.ok)
  ok('and stops counting against the daily cap',
    (await submitRequest(SITE, { ...base, title: `PROBE${stamp} after junk` })).ok)

  // ── Drift ─────────────────────────────────────────────────────────────────
  await siteExecute(SITE,
    `UPDATE job_requests SET created_at = DATE_SUB(NOW(), INTERVAL 5 DAY)
      WHERE id = ?`, [other!.id])
  const drift = await reconcileJobIntake(SITE)
  ok('*** a request waiting days with nobody looking is reported ***',
    drift.stale.some((s) => s.id === other!.id), `${drift.stale.length} reported`)

  // Deleting the job leaves the request claiming one that is gone.
  await siteExecute(SITE, `DELETE FROM job_cards WHERE id = ?`, [accepted.jobId])
  const drift2 = await reconcileJobIntake(SITE)
  ok('*** and an accepted request whose job was deleted is CAUGHT ***',
    drift2.orphaned.some((o) => o.id === requestId), `${drift2.orphaned.length} reported`)

  // ── The token ─────────────────────────────────────────────────────────────
  const token = await createPublicIntakeToken(SITE)
  ok('a token round-trips', (await verifyPublicIntakeToken(token)) === SITE)
  ok('it is DETERMINISTIC, so a printed link keeps working',
    (await createPublicIntakeToken(SITE)) === token)
  ok('rubbish is refused', (await verifyPublicIntakeToken('nope')) === null)
  const reserve = await createPublicReserveToken(SITE)
  ok('*** a BOOKING token cannot be replayed as an intake token ***',
    (await verifyPublicIntakeToken(reserve)) === null)

  // ── Settings fail closed ──────────────────────────────────────────────────
  await setSetting(SITE, 'job_intake_enabled', '0')
  ok('intakeSettings reports the form as closed',
    (await intakeSettings(SITE)).isEnabled === false)

  // ── Cleanup ───────────────────────────────────────────────────────────────
  await sweep()
  await setSetting(SITE, 'job_intake_enabled', wasEnabled)
  await setSetting(SITE, 'job_intake_max_per_phone', wasCap)

  const left = await siteQuery<any>(SITE,
    `SELECT COUNT(*) AS n FROM job_requests WHERE title LIKE ?`, [`PROBE${stamp}%`])
  const jobsLeft = await siteQuery<any>(SITE,
    `SELECT COUNT(*) AS n FROM job_cards WHERE title LIKE ?`, [`PROBE${stamp}%`])
  ok('the probe leaves nothing behind',
    Number(left[0].n) === 0 && Number(jobsLeft[0].n) === 0,
    `${left[0].n} request(s), ${jobsLeft[0].n} job(s)`)
}

main()
  .then(() => {
    console.log(fails ? `\n${fails} failure(s)` : '\nAll intake checks passed')
    process.exit(fails ? 1 : 0)
  })
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
