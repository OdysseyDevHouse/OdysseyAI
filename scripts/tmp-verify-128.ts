import {
  requestFeedback,
  recordFeedback,
  feedbackFor,
  listFeedback,
  markSeen,
  feedbackSummary,
  reconcileJobFeedback,
} from '../src/lib/site/jobFeedback'
import { createFeedbackToken, readFeedbackToken } from '../src/lib/feedbackToken'
import { getSetting, setSetting } from '../src/lib/site/settings'
import { siteExecute, siteQuery, siteQueryOne } from '../src/lib/siteDb'

const SITE = 1
const actor = { userId: 1, userName: 'Probe' }

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

async function main() {
  /*
   * Mail OFF for the whole run, restored at the end.
   *
   * requestFeedback emails a REAL CUSTOMER, and this box has real SMTP. The
   * switch is job_feedback_enabled, and turning it off is also what proves the
   * disabled path works — so nothing is lost by testing with it off first.
   */
  const wasEnabled = await getSetting(SITE, 'job_feedback_enabled').catch(() => '0')

  const JOB = 12
  await siteExecute(SITE, `DELETE FROM job_feedback WHERE job_card_id = ?`, [JOB])

  // ── The switch ────────────────────────────────────────────────────────────
  await setSetting(SITE, 'job_feedback_enabled', '0')
  const off = await requestFeedback(SITE, JOB)
  ok('*** with the switch off, nothing is asked and it says so ***',
    !off.sent && off.skipped === 'disabled', `skipped ${off.skipped}`)
  ok('and no row was written',
    (await siteQuery<any>(SITE, `SELECT id FROM job_feedback WHERE job_card_id = ?`, [JOB])).length === 0)

  // ── Asking ────────────────────────────────────────────────────────────────
  await setSetting(SITE, 'job_feedback_enabled', '1')

  /*
   * The job's own email is blanked for the test, and the customer account has
   * none on this fixture, so the send path stops at "no email address" —
   * exercising everything up to the send without touching a real inbox.
   */
  const jobBefore = await siteQueryOne<any>(SITE,
    `SELECT customer_email FROM job_cards WHERE id = ?`, [JOB])
  await siteExecute(SITE, `UPDATE job_cards SET customer_email = NULL WHERE id = ?`, [JOB])
  const noEmail = await requestFeedback(SITE, JOB)
  ok('a job with no address is skipped, with a reason',
    !noEmail.sent && (noEmail.skipped ?? '').includes('email'), `skipped ${noEmail.skipped}`)
  ok('*** and NO row is claimed — so it can be asked properly later ***',
    (await siteQuery<any>(SITE, `SELECT id FROM job_feedback WHERE job_card_id = ?`, [JOB])).length === 0)

  // Now give it an address that cannot deliver: the claim happens, the send fails.
  await siteExecute(SITE,
    `UPDATE job_cards SET customer_email = 'probe@invalid.test' WHERE id = ?`, [JOB])
  const asked = await requestFeedback(SITE, JOB)
  ok('with an address, the row is claimed',
    (await feedbackFor(SITE, JOB)) !== null, `sent=${asked.sent} skipped=${asked.skipped}`)

  const again = await requestFeedback(SITE, JOB)
  ok('*** asking twice claims nothing new — closed, reopened, closed asks once ***',
    !again.sent && again.skipped === 'already asked', `skipped ${again.skipped}`)

  const pending = await feedbackFor(SITE, JOB)
  ok('the row is asked-but-unanswered',
    pending !== null && pending.requestedAt !== null && pending.respondedAt === null &&
    pending.rating === null)

  // ── Answering ─────────────────────────────────────────────────────────────
  const zero = await recordFeedback(SITE, JOB, 0, null)
  ok('a rating of zero is refused', !zero.ok, zero.ok ? 'ACCEPTED' : zero.error)
  const six = await recordFeedback(SITE, JOB, 6, null)
  ok('and one of six', !six.ok, six.ok ? 'ACCEPTED' : six.error)

  const noRow = await recordFeedback(SITE, 999999, 5, 'x')
  ok('*** a job nobody was ASKED about cannot be rated — the UPDATE hits nothing ***',
    !noRow.ok, noRow.ok ? 'ACCEPTED' : noRow.error)

  const answered = await recordFeedback(SITE, JOB, 2, '  The tap still drips.  ')
  ok('a real answer saves', answered.ok, answered.ok ? '' : (answered as any).error)

  const got = await feedbackFor(SITE, JOB)
  ok('it reads back with the rating and a TRIMMED comment',
    got?.rating === 2 && got?.comment === 'The tap still drips.', `"${got?.comment}"`)
  ok('and is marked answered', got?.respondedAt !== null)

  // ── Seen ──────────────────────────────────────────────────────────────────
  ok('a fresh answer is unread', got?.seenAt === null)
  const unseen = await listFeedback(SITE, { unseenOnly: true })
  ok('and appears on the unread list', unseen.some((f) => f.jobId === JOB))

  await markSeen(SITE, actor, JOB)
  const afterSeen = await feedbackFor(SITE, JOB)
  ok('marking it read records who', afterSeen?.seenAt !== null && afterSeen?.seenByName === 'Probe')

  const changed = await recordFeedback(SITE, JOB, 5, 'Sorted the next day, thank you.')
  ok('a customer may correct their answer', changed.ok)
  const afterChange = await feedbackFor(SITE, JOB)
  ok('*** and a CHANGED rating becomes unread again — it is news ***',
    afterChange?.rating === 5 && afterChange?.seenAt === null)

  // ── Summary ───────────────────────────────────────────────────────────────
  const summary = await feedbackSummary(SITE)
  ok('the summary counts asked and answered', summary.asked >= 1 && summary.answered >= 1,
    `asked ${summary.asked}, answered ${summary.answered}`)
  ok('and a response rate out of 100', summary.responseRate > 0 && summary.responseRate <= 100,
    `${summary.responseRate}%`)
  ok('the spread names each star', summary.spread[5] >= 1, JSON.stringify(summary.spread))

  // ── Drift ─────────────────────────────────────────────────────────────────
  await recordFeedback(SITE, JOB, 1, 'Still not right.')
  const drift = await reconcileJobFeedback(SITE)
  ok('*** a poor rating nobody has read is reported ***',
    drift.unseenPoor.some((f) => f.jobId === JOB && f.rating === 1),
    `${drift.unseenPoor.length} reported`)

  await markSeen(SITE, actor, JOB)
  const drift2 = await reconcileJobFeedback(SITE)
  ok('and stops being reported once read',
    !drift2.unseenPoor.some((f) => f.jobId === JOB))

  // A request older than the token's own life is lapsed.
  await siteExecute(SITE,
    `UPDATE job_feedback SET responded_at = NULL, rating = NULL, comment = NULL,
       requested_at = DATE_SUB(NOW(), INTERVAL 90 DAY) WHERE job_card_id = ?`, [JOB])
  const drift3 = await reconcileJobFeedback(SITE)
  ok('an old unanswered request is reported as lapsed',
    drift3.lapsed.some((f) => f.jobId === JOB), `${drift3.lapsed.length} reported`)

  // ── The token ─────────────────────────────────────────────────────────────
  const token = await createFeedbackToken({ siteId: SITE, jobId: JOB })
  const back = await readFeedbackToken(token)
  ok('a token round-trips', back?.siteId === SITE && back?.jobId === JOB)
  ok('rubbish is refused', (await readFeedbackToken('not-a-token')) === null)
  ok('*** a tampered signature is refused — the URL IS the credential ***',
    (await readFeedbackToken(token.slice(0, -3) + 'aaa')) === null)

  // The audience is what stops another token being replayed here.
  const { createCalendarToken } = await import('../src/lib/calendarToken')
  const calendar = await createCalendarToken(SITE, 1)
  ok('*** a CALENDAR token cannot be replayed as a feedback token ***',
    (await readFeedbackToken(calendar)) === null)

  // ── Cleanup ───────────────────────────────────────────────────────────────
  await siteExecute(SITE, `DELETE FROM job_feedback WHERE job_card_id = ?`, [JOB])
  await siteExecute(SITE,
    `UPDATE job_cards SET customer_email = ? WHERE id = ?`,
    [jobBefore?.customer_email ?? null, JOB])
  await siteExecute(SITE,
    `DELETE FROM activity_log WHERE entity = 'job_card' AND action = 'feedback_received'`)
  await setSetting(SITE, 'job_feedback_enabled', wasEnabled)

  const left = await siteQuery<any>(SITE, `SELECT COUNT(*) AS n FROM job_feedback`)
  const restored = await getSetting(SITE, 'job_feedback_enabled')
  ok('the probe leaves nothing behind and puts the switch back',
    Number(left[0].n) === 0 && restored === wasEnabled, `${left[0].n} row(s), switch ${restored}`)
}

main()
  .then(() => {
    console.log(fails ? `\n${fails} failure(s)` : '\nAll feedback checks passed')
    process.exit(fails ? 1 : 0)
  })
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
