/**
 * The SMS channel, end to end against a real database.
 *
 * What matters here and nowhere else:
 *
 *   REACHABILITY IS CHANNEL-AWARE. A phone-only account on a level that texts
 *   must be QUEUED — that account is the reason SMS dunning exists — and an
 *   account no leg can reach is listed skipped, never dropped.
 *
 *   THE TWO LEGS STAND ALONE. A dead email with a live text is a SENT item
 *   whose error still records the bounce; sms_status carries the text leg's
 *   own truth. And the ladder moves ONCE per item, not once per leg.
 *
 *   NO PROVIDER MEANS SKIPPED, NOT FAILED. A level that texts on a system
 *   with no SMS set up must still send its email and say the text was skipped.
 *
 *   LAY-BY REMINDERS THROTTLE AND STAMP ONLY ON SUCCESS — a dead number keeps
 *   being retried rather than silently going quiet until the lay-by expires.
 */

import {
  saveLevel,
  buildRun,
  listItems,
  processRun,
  cancelRun,
} from '../src/lib/site/creditControl'
import { remindDueLaybys } from '../src/lib/site/laybys'
import { postTransaction } from '../src/lib/site/customerLedger'
import { siteExecute, siteQuery, siteQueryOne } from '../src/lib/siteDb'

const SITE = 1
const actor = { userId: 1, userName: 'SMS Test' }

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

function daysAgo(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d.toISOString().slice(0, 10)
}

const stamp = Date.now().toString().slice(-6)
const customerIds: number[] = []
const laybyIds: number[] = []
let levelId = 0

/** Captured sends, in place of a provider. */
function smsCollector(failFor: string[] = []) {
  const sent: { to: string; body: string }[] = []
  return {
    sent,
    sendSms: async (to: string, body: string) => {
      if (failFor.includes(to)) return { ok: false as const, error: 'Number unreachable.' }
      sent.push({ to, body })
      return { ok: true as const }
    },
  }
}

function mailCollector() {
  const sent: { to: string; subject: string; text: string }[] = []
  return {
    sent,
    send: async (input: { to: string; subject: string; text: string }) => {
      sent.push(input)
      return { ok: true as const }
    },
  }
}

async function makeCustomer(name: string, email: string | null, phone: string | null) {
  const res = await siteExecute(
    SITE,
    `INSERT INTO customers (code, name, email, phone, status, payment_terms_days, credit_limit)
     VALUES (?,?,?,?,'active',30,50000)`,
    [`SMS${stamp}${customerIds.length}`, `${name} ${stamp}`, email, phone],
  )
  customerIds.push(res.insertId)
  return res.insertId
}

async function overdueInvoice(customerId: number, amount: number) {
  const posted = await postTransaction(SITE, actor, {
    customerId,
    docType: 'invoice',
    amount,
    docDate: daysAgo(210),
    docNumber: `SMSINV${stamp}${customerId}`,
  })
  if (!posted.ok) throw new Error(`could not post test invoice: ${posted.error}`)
  await siteExecute(SITE, 'UPDATE customer_transactions SET due_date = ? WHERE id = ?', [
    daysAgo(200),
    posted.id,
  ])
}

async function main() {
  console.log('\n── A texting level is validated like one ───────────────────\n')

  const noBody = await saveLevel(SITE, actor, null, {
    step: 90, name: 'Text only', minDaysOverdue: 150, minAmount: 0,
    subject: '', body: '', channel: 'sms', smsBody: '  ',
    blocksAccount: false, requiresCall: false, isActive: true,
  })
  ok('a level that texts needs an SMS message', !noBody.ok)

  const tooLong = await saveLevel(SITE, actor, null, {
    step: 90, name: 'Long', minDaysOverdue: 150, minAmount: 0,
    subject: 's', body: 'b', channel: 'both', smsBody: 'x'.repeat(321),
    blocksAccount: false, requiresCall: false, isActive: true,
  })
  ok('an SMS message is capped at 320 characters', !tooLong.ok)

  const smsOnlyNoSubject = await saveLevel(SITE, actor, null, {
    step: 90, name: 'Text only', minDaysOverdue: 150, minAmount: 0,
    subject: '', body: '', channel: 'sms', smsBody: 'Please pay {overdue}.',
    blocksAccount: false, requiresCall: false, isActive: true,
  })
  ok('*** an SMS-only level needs no email subject or body ***', smsOnlyNoSubject.ok,
      smsOnlyNoSubject.ok ? '' : smsOnlyNoSubject.error)
  if (!smsOnlyNoSubject.ok) throw new Error('cannot continue without the test level')
  levelId = smsOnlyNoSubject.id

  // Flip it to 'both' for the run tests — the email leg matters below.
  const both = await saveLevel(SITE, actor, levelId, {
    step: 90, name: `SMS Test Level ${stamp}`, minDaysOverdue: 150, minAmount: 0,
    subject: 'Overdue: {overdue}', body: 'Dear {customer}, {overdue} is overdue.',
    channel: 'both', smsBody: 'Hi {customer}, {overdue} is overdue at {company}. Please pay.',
    blocksAccount: false, requiresCall: false, isActive: true,
  })
  ok('the level updates to send both legs', both.ok, both.ok ? '' : both.error)

  console.log('\n── Reachability is channel-aware at build time ─────────────\n')

  const reachBoth = await makeCustomer('Reach Both', `both${stamp}@example.test`, '082 111 2233')
  const phoneOnly = await makeCustomer('Phone Only', null, '0721234567')
  const emailOnly = await makeCustomer('Email Only', `only${stamp}@example.test`, null)
  const unreachable = await makeCustomer('Unreachable', null, 'not a number')
  const deadNumber = await makeCustomer('Dead Number', null, '0839998877')

  for (const id of [reachBoth, phoneOnly, emailOnly, unreachable, deadNumber]) {
    await overdueInvoice(id, 5000)
  }

  const built = await buildRun(SITE, actor, {
    customerIds: [reachBoth, phoneOnly, emailOnly, unreachable, deadNumber],
  })
  ok('the run builds', built.ok, built.ok ? `#${built.runId}` : built.error)
  if (!built.ok) throw new Error('cannot continue without a run')

  const items = await listItems(SITE, built.runId)
  const itemFor = (id: number) => items.find((i) => i.customerId === id)

  ok('all five accounts hit the texting level', items.every((i) => i.levelStep === 90 || i.status === 'skipped'),
      items.map((i) => `${i.customerName}:${i.levelStep}`).join(', '))
  ok('*** a phone-only account on a texting level is QUEUED ***',
      itemFor(phoneOnly)?.status === 'queued', itemFor(phoneOnly)?.error ?? '')
  ok('an email-only account on a both level is queued too',
      itemFor(emailOnly)?.status === 'queued')
  ok('*** the snapshot holds the NORMALISED number ***',
      itemFor(phoneOnly)?.phone === '+27721234567', itemFor(phoneOnly)?.phone ?? 'null')
  ok('a junk phone snapshots as null', itemFor(unreachable)?.phone === null)
  ok('*** an account no leg can reach is listed skipped, not dropped ***',
      itemFor(unreachable)?.status === 'skipped')
  ok('…and the reason names both missing channels',
      (itemFor(unreachable)?.error ?? '').includes('email') &&
      (itemFor(unreachable)?.error ?? '').toLowerCase().includes('mobile'),
      itemFor(unreachable)?.error ?? '')

  console.log('\n── The two legs stand on their own feet ────────────────────\n')

  const mail = mailCollector()
  const sms = smsCollector(['+27839998877']) // the dead number refuses
  const result = await processRun(SITE, built.runId, actor, {
    companyName: 'Test Shop',
    send: mail.send,
    sendSms: sms.sendSms,
  })

  // reachBoth: email+sms. phoneOnly: sms only (email leg has no address).
  // emailOnly: email, sms leg skipped (no number). deadNumber: sms fails, no email → failed.
  ok('three items landed', result.sent === 3, JSON.stringify(result))
  ok('one item failed outright', result.failed === 1)

  const after = await listItems(SITE, built.runId)
  const a = (id: number) => after.find((i) => i.customerId === id)

  ok('both-legs item is sent with sms_status sent',
      a(reachBoth)?.status === 'sent' && a(reachBoth)?.smsStatus === 'sent')
  ok('*** the phone-only item is SENT on the text alone ***',
      a(phoneOnly)?.status === 'sent' && a(phoneOnly)?.smsStatus === 'sent')
  ok('…and its error still records the email leg had no address',
      (a(phoneOnly)?.error ?? '').toLowerCase().includes('email'), a(phoneOnly)?.error ?? '')
  ok('the email-only item is sent with its text leg skipped',
      a(emailOnly)?.status === 'sent' && a(emailOnly)?.smsStatus === 'skipped')
  ok('…for the stated reason', (a(emailOnly)?.smsError ?? '').toLowerCase().includes('mobile'),
      a(emailOnly)?.smsError ?? '')
  ok('*** the dead number is FAILED, with the provider error ***',
      a(deadNumber)?.status === 'failed' && a(deadNumber)?.smsStatus === 'failed' &&
      (a(deadNumber)?.smsError ?? '').includes('unreachable'),
      `${a(deadNumber)?.status}/${a(deadNumber)?.smsStatus}`)

  ok('two emails went out', mail.sent.length === 2, String(mail.sent.length))
  ok('two texts went out', sms.sent.length === 2, String(sms.sent.length))
  const text = sms.sent.find((s) => s.to === '+27721234567')
  ok('*** the text filled its tokens ***',
      !!text && text.body.includes('Phone Only') && text.body.includes('Test Shop') &&
      !text.body.includes('{'),
      text?.body ?? 'no text captured')

  // The ladder moved once per landed item, whatever the legs did.
  const levels = await siteQuery<{ customer_id: number; dunning_level: number }>(
    SITE,
    `SELECT customer_id, dunning_level FROM customer_credit_status
      WHERE customer_id IN (?,?,?)`,
    [reachBoth, phoneOnly, emailOnly],
  )
  ok('*** every landed item moved the ladder exactly to the level ***',
      levels.length === 3 && levels.every((l) => Number(l.dunning_level) === 90),
      levels.map((l) => `${l.customer_id}:${l.dunning_level}`).join(', '))

  console.log('\n── No provider means skipped, not failed ───────────────────\n')

  const noProviderCust = await makeCustomer('No Provider', `noprov${stamp}@example.test`, '0741112233')
  await overdueInvoice(noProviderCust, 5000)
  const built2 = await buildRun(SITE, actor, { customerIds: [noProviderCust] })
  if (built2.ok) {
    const mail2 = mailCollector()
    // No sendSms in deps — the system has no provider configured.
    const r2 = await processRun(SITE, built2.runId, actor, {
      companyName: 'Test Shop',
      send: mail2.send,
    })
    const item = (await listItems(SITE, built2.runId)).find((i) => i.customerId === noProviderCust)
    ok('*** the email still goes out ***', r2.sent === 1 && mail2.sent.length === 1)
    ok('*** the text leg is skipped, not failed ***', item?.smsStatus === 'skipped',
        item?.smsStatus)
    ok('…and says SMS is not set up', (item?.smsError ?? '').includes('not set up'),
        item?.smsError ?? '')
  } else {
    ok('second run builds', false, built2.error)
  }

  console.log('\n── Lay-by reminders: throttled, stamped only on success ────\n')

  await siteExecute(
    SITE,
    `UPDATE settings SET setting_value = '7' WHERE setting_key = 'layby_reminder_days'`,
  ).catch(() => undefined)

  const laybyGood = await makeCustomer('Layby Good', null, '0761234567')
  const laybyDead = await makeCustomer('Layby Dead', null, '0769998877')
  const laybyNoPhone = await makeCustomer('Layby Silent', null, null)

  for (const [cust, name] of [
    [laybyGood, 'good'],
    [laybyDead, 'dead'],
    [laybyNoPhone, 'nophone'],
  ] as const) {
    const res = await siteExecute(
      SITE,
      `INSERT INTO laybys (customer_id, status, due_date, total_incl, paid_total, user_name)
       VALUES (?, 'open', ?, 1000, 250, ?)`,
      [cust, daysAgo(-3), `SMS Test ${name}`],
    )
    laybyIds.push(res.insertId)
  }

  const remind1 = smsCollector(['+27769998877'])
  const round1 = await remindDueLaybys(SITE, actor, remind1)
  const mine1 = remind1.sent.filter((s) => ['+27761234567', '+27769998877'].includes(s.to))
  ok('the good number was texted', mine1.some((s) => s.to === '+27761234567'))
  ok('one reminder sent among our fixtures', mine1.length === 1, `${round1.sent} sent overall`)
  ok('the no-phone lay-by is reported skipped',
      round1.skipped.some((s) => s.reason.toLowerCase().includes('mobile')))
  ok('the reminder fills its tokens', !mine1[0]?.body.includes('{'), mine1[0]?.body ?? '')

  const stamps = await siteQuery<{ id: number; reminded_at: unknown }>(
    SITE,
    `SELECT id, reminded_at FROM laybys WHERE id IN (?,?,?)`,
    laybyIds,
  )
  const stampFor = (i: number) => stamps.find((s) => Number(s.id) === laybyIds[i])?.reminded_at
  ok('*** the sent lay-by is stamped ***', stampFor(0) !== null)
  ok('*** the failed send is NOT stamped — it will be retried ***', stampFor(1) === null)
  ok('the unreachable one is not stamped either', stampFor(2) === null)

  const remind2 = smsCollector()
  await remindDueLaybys(SITE, actor, remind2)
  ok('*** a lay-by reminded this week is left alone ***',
      !remind2.sent.some((s) => s.to === '+27761234567'))
  ok('…while the failed one is retried', remind2.sent.some((s) => s.to === '+27769998877'))

  console.log('\n── Cleanup ────────────────────────────────────────────────\n')

  for (const id of laybyIds) {
    await siteExecute(SITE, 'DELETE FROM laybys WHERE id = ?', [id])
  }
  for (const id of customerIds) {
    await siteExecute(SITE, 'DELETE FROM credit_contacts WHERE customer_id = ?', [id])
    await siteExecute(SITE, 'DELETE FROM dunning_run_items WHERE customer_id = ?', [id])
    await siteExecute(SITE, 'DELETE FROM customer_credit_status WHERE customer_id = ?', [id])
    await siteExecute(
      SITE,
      `DELETE FROM customer_allocations
        WHERE debit_txn_id IN (SELECT id FROM customer_transactions WHERE customer_id = ?)
           OR credit_txn_id IN (SELECT id FROM customer_transactions WHERE customer_id = ?)`,
      [id, id],
    )
    await siteExecute(SITE, 'DELETE FROM customer_transactions WHERE customer_id = ?', [id])
    await siteExecute(SITE, 'DELETE FROM customers WHERE id = ?', [id])
  }
  await siteExecute(
    SITE,
    `DELETE FROM dunning_runs WHERE id NOT IN (SELECT DISTINCT run_id FROM dunning_run_items)
       AND user_name = 'SMS Test'`,
  )
  if (levelId) {
    await siteExecute(SITE, 'DELETE FROM dunning_levels WHERE id = ?', [levelId])
  }
  await siteExecute(SITE, `DELETE FROM activity_log WHERE user_name = 'SMS Test'`)

  const leftCustomers = await siteQuery(SITE, 'SELECT id FROM customers WHERE code LIKE ?', [
    `SMS${stamp}%`,
  ])
  const leftLevels = await siteQuery(SITE, 'SELECT id FROM dunning_levels WHERE step = 90')
  ok('test data cleaned up', leftCustomers.length === 0 && leftLevels.length === 0,
      `${leftCustomers.length} customers, ${leftLevels.length} levels left`)

  console.log(fails === 0 ? '\nAll SMS channel rules hold.\n' : `\n${fails} FAILURE(S)\n`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
