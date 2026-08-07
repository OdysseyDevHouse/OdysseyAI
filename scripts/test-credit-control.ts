/**
 * Credit control, against a real database.
 *
 * The pure rules are covered by test-credit-model.ts. This proves the parts
 * that only break once state persists across runs:
 *
 *   THE LADDER ACTUALLY CLIMBS. Build a run, send it, build another — the
 *   second must escalate or skip, never repeat. This is the whole point of the
 *   module and the one thing a stateless test cannot show.
 *
 *   NOTHING IS SENT UNTIL A HUMAN RELEASES IT. A draft run touches no account,
 *   moves no level, and sends no email. A final demand going out because a
 *   screen was left open is not recoverable.
 *
 *   A PROMISE STOPS THE CHASE, AND BREAKS ON ITS OWN. The customer said Friday;
 *   the run must leave them alone until Friday, then notice.
 *
 *   THE LEDGER IS NEVER TOUCHED. Chasing money does not change what is owed.
 *   Every balance is checked before and after.
 */

import {
  listLevels,
  saveLevel,
  buildRun,
  getRun,
  listItems,
  processRun,
  excludeItem,
  cancelRun,
  listPositions,
  overdueDocuments,
  createPromise,
  listPromises,
  resolvePromise,
  sweepPromises,
  logContact,
  listContacts,
  pauseChasing,
  resumeChasing,
  holdAccount,
  releaseAccount,
  resetLevel,
  creditSummary,
  accountCredit,
} from '../src/lib/site/creditControl'
import { postTransaction } from '../src/lib/site/customerLedger'
import { siteExecute, siteQuery, siteQueryOne } from '../src/lib/siteDb'
import { toNum } from '../src/lib/decimals'

const SITE = 1
const actor = { userId: 1, userName: 'Credit Test' }
const releaser = { userId: 2, userName: 'Second Person' }

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

function daysAhead(n: number): string {
  return daysAgo(-n)
}

const stamp = Date.now().toString().slice(-6)
const customerIds: number[] = []

/** A sent email, captured instead of delivered. */
type Sent = { to: string; subject: string; text: string }

function collector() {
  const sent: Sent[] = []
  return {
    sent,
    send: async (input: Sent) => {
      sent.push(input)
      return { ok: true as const }
    },
  }
}

async function makeCustomer(name: string, email: string | null): Promise<number> {
  const res = await siteExecute(
    SITE,
    `INSERT INTO customers (code, name, email, status, payment_terms_days, credit_limit)
     VALUES (?,?,?,'active',30,50000)`,
    [`CC${stamp}${customerIds.length}`, `${name} ${stamp}`, email],
  )
  customerIds.push(res.insertId)
  return res.insertId
}

async function invoice(customerId: number, amount: number, daysOld: number, dueDaysAgo: number) {
  const posted = await postTransaction(SITE, actor, {
    customerId,
    docType: 'invoice',
    amount,
    docDate: daysAgo(daysOld),
    docNumber: `CCINV${stamp}${customerId}`,
  })
  if (!posted.ok) throw new Error(`could not post test invoice: ${posted.error}`)
  // Due date drives everything here, so it is set explicitly rather than left
  // to terms — a test that depends on the site's terms setting is a test that
  // breaks when someone changes it.
  await siteExecute(SITE, 'UPDATE customer_transactions SET due_date = ? WHERE id = ?', [
    daysAgo(dueDaysAgo),
    posted.id,
  ])
  return posted.id
}

async function balanceOf(customerId: number): Promise<number> {
  const row = await siteQueryOne<{ balance: unknown }>(
    SITE,
    'SELECT balance FROM customers WHERE id = ?',
    [customerId],
  )
  return toNum(row?.balance)
}

async function levelOf(customerId: number): Promise<number> {
  const row = await siteQueryOne<{ dunning_level: unknown }>(
    SITE,
    'SELECT dunning_level FROM customer_credit_status WHERE customer_id = ?',
    [customerId],
  )
  return Number(row?.dunning_level ?? 0)
}

async function main() {
  console.log('\n── The ladder is configured ────────────────────────────────\n')

  const levels = await listLevels(SITE, true)
  ok('the migration seeded a three-step ladder', levels.length >= 3, `${levels.length} levels`)
  ok('step 1 is the gentlest', levels[0]?.minDaysOverdue === 7)
  ok('*** only the last step blocks the account ***',
      levels.filter((l) => l.blocksAccount).length === 1 &&
      levels[levels.length - 1].blocksAccount === true)

  const badStep = await saveLevel(SITE, actor, null, {
    step: 1, name: 'Clash', minDaysOverdue: 5, minAmount: 0,
    subject: 's', body: 'b', blocksAccount: false, requiresCall: false, isActive: true,
  })
  ok('two levels cannot share a step', !badStep.ok)

  const noName = await saveLevel(SITE, actor, null, {
    step: 9, name: '  ', minDaysOverdue: 5, minAmount: 0,
    subject: 's', body: 'b', blocksAccount: false, requiresCall: false, isActive: true,
  })
  ok('a level needs a name', !noName.ok)

  console.log('\n── A draft run sends nothing ───────────────────────────────\n')

  const slow = await makeCustomer('Slow Payer', `slow${stamp}@example.test`)
  await invoice(slow, 8000, 60, 45)

  const balanceBefore = await balanceOf(slow)

  const built = await buildRun(SITE, actor, { customerIds: [slow] })
  ok('a run builds', built.ok, built.ok ? `#${built.runId}` : built.error)
  if (!built.ok) throw new Error('cannot continue without a run')

  const run1 = await getRun(SITE, built.runId)
  ok('*** it is a draft, not sent ***', run1?.status === 'draft')
  ok('*** the account has not moved up the ladder ***', (await levelOf(slow)) === 0)
  ok('*** no contact was logged ***', (await listContacts(SITE, slow)).length === 0)
  ok('the ledger is untouched', (await balanceOf(slow)) === balanceBefore)

  const items1 = await listItems(SITE, built.runId)
  const slowItem = items1.find((i) => i.customerId === slow)
  ok('45 days overdue reaches level 2, not level 1', slowItem?.levelStep === 2,
      `got step ${slowItem?.levelStep}`)
  ok('the letter claims what is actually owed', slowItem?.overdueAmount === 8000,
      String(slowItem?.overdueAmount))

  console.log('\n── Releasing it does the work ──────────────────────────────\n')

  const mail1 = collector()
  const result1 = await processRun(SITE, built.runId, releaser, {
    companyName: 'Test Co',
    send: mail1.send,
  })
  ok('one email was sent', result1.sent === 1, JSON.stringify(result1))
  ok('*** the account climbed to level 2 ***', (await levelOf(slow)) === 2)
  ok('*** the ledger is STILL untouched ***', (await balanceOf(slow)) === balanceBefore)

  const letter = mail1.sent[0]
  ok('the letter names the customer', letter?.text.includes(`Slow Payer ${stamp}`))
  ok('*** no placeholder survived into the letter ***',
      !letter?.text.includes('{') && !letter?.subject.includes('{'),
      letter?.subject)
  ok('the letter itemises the debt', letter?.text.includes('8'))

  const contacts = await listContacts(SITE, slow)
  ok('*** the send was logged as a contact ***', contacts.length === 1 && contacts[0].kind === 'email')

  console.log('\n── The ladder climbs, and never repeats ────────────────────\n')

  // Immediately: too soon, whatever the ladder says.
  const tooSoon = await buildRun(SITE, actor, { customerIds: [slow] })
  ok('a second run builds', tooSoon.ok)
  if (tooSoon.ok) {
    const item = (await listItems(SITE, tooSoon.runId)).find((i) => i.customerId === slow)
    ok('*** the same account is not chased again the same day ***', item?.status === 'skipped')
    ok('…and it says why', (item?.error ?? '').toLowerCase().includes('recently'), item?.error ?? '')
    await cancelRun(SITE, actor, tooSoon.runId)
  }

  // Pretend the letter went out three weeks ago and the debt aged past 60.
  await siteExecute(SITE, 'UPDATE customer_credit_status SET last_dunned_at = ? WHERE customer_id = ?', [
    daysAgo(21), slow,
  ])
  await siteExecute(
    SITE,
    `UPDATE customer_transactions SET due_date = ? WHERE customer_id = ? AND amount_outstanding > 0`,
    [daysAgo(70), slow],
  )

  const escalated = await buildRun(SITE, actor, { customerIds: [slow] })
  ok('a later run builds', escalated.ok)
  if (escalated.ok) {
    const item = (await listItems(SITE, escalated.runId)).find((i) => i.customerId === slow)
    ok('*** it escalates to step 3 rather than repeating step 2 ***', item?.levelStep === 3,
        `got step ${item?.levelStep}`)

    const mail2 = collector()
    await processRun(SITE, escalated.runId, releaser, { companyName: 'Test Co', send: mail2.send })
    ok('the final demand went out', mail2.sent.length === 1)
    ok('*** reaching the final level put the account on hold ***',
        (await siteQueryOne<{ status: unknown }>(SITE, 'SELECT status FROM customers WHERE id = ?', [slow]))
          ?.status === 'on_hold')

    const held = await siteQueryOne<{ hold_reason: unknown }>(
      SITE, 'SELECT hold_reason FROM customer_credit_status WHERE customer_id = ?', [slow])
    ok('…and recorded why', String(held?.hold_reason ?? '').length > 0, String(held?.hold_reason))
  }

  // Top of the ladder: nothing left to escalate to.
  await siteExecute(SITE, 'UPDATE customer_credit_status SET last_dunned_at = ? WHERE customer_id = ?', [
    daysAgo(60), slow,
  ])
  const exhausted = await buildRun(SITE, actor, { customerIds: [slow] })
  if (exhausted.ok) {
    const item = (await listItems(SITE, exhausted.runId)).find((i) => i.customerId === slow)
    ok('*** an account at the top of the ladder is not chased forever ***', item?.status === 'skipped')
    ok('…and the reason is the ladder, not an error',
        (item?.error ?? '').toLowerCase().includes('final'), item?.error ?? '')
    await cancelRun(SITE, actor, exhausted.runId)
  }

  console.log('\n── Clearing arrears resets the ladder ──────────────────────\n')

  // The important half: paying the account off must reset it WITHOUT anyone
  // calling resetLevel by hand. An account stuck at the top rung would be sent
  // a final demand the next time it slipped a single day.
  const settler = await makeCustomer('Settler', `settle${stamp}@example.test`)
  await invoice(settler, 4000, 80, 70)
  const settlerRun = await buildRun(SITE, actor, { customerIds: [settler] })
  if (settlerRun.ok) {
    const mail = collector()
    await processRun(SITE, settlerRun.runId, releaser, { companyName: 'Test Co', send: mail.send })
  }
  ok('the account climbed the ladder', (await levelOf(settler)) > 0, `level ${await levelOf(settler)}`)

  await postTransaction(SITE, actor, {
    customerId: settler, docType: 'payment', amount: 4000, docDate: daysAgo(0),
    docNumber: `CCSET${stamp}`, autoAllocate: true,
  })
  ok('*** paying the account off resets the ladder by itself ***',
      (await levelOf(settler)) === 0, `level ${await levelOf(settler)}`)

  // And a PART payment must not — the debt is still overdue.
  const partial = await makeCustomer('Partial', `part${stamp}@example.test`)
  await invoice(partial, 10000, 80, 70)
  const partialRun = await buildRun(SITE, actor, { customerIds: [partial] })
  if (partialRun.ok) {
    const mail = collector()
    await processRun(SITE, partialRun.runId, releaser, { companyName: 'Test Co', send: mail.send })
  }
  const beforePart = await levelOf(partial)
  await postTransaction(SITE, actor, {
    customerId: partial, docType: 'payment', amount: 1000, docDate: daysAgo(0),
    docNumber: `CCPART${stamp}`, autoAllocate: true,
  })
  ok('*** a part payment does NOT reset the ladder ***',
      (await levelOf(partial)) === beforePart && beforePart > 0,
      `was ${beforePart}, now ${await levelOf(partial)}`)

  await resetLevel(SITE, slow)
  ok('a settled account starts again at the friendly reminder', (await levelOf(slow)) === 0)

  console.log('\n── A promise stops the chase ───────────────────────────────\n')

  const promiser = await makeCustomer('Promiser', `promise${stamp}@example.test`)
  await invoice(promiser, 12000, 60, 40)

  const chaseable = await buildRun(SITE, actor, { customerIds: [promiser] })
  ok('without a promise the account is chaseable', chaseable.ok)
  if (chaseable.ok) {
    const item = (await listItems(SITE, chaseable.runId)).find((i) => i.customerId === promiser)
    ok('…and is queued to be chased', item?.status === 'queued')
    await cancelRun(SITE, actor, chaseable.runId)
  }

  const promise = await createPromise(SITE, actor, {
    customerId: promiser,
    promisedDate: daysAhead(5),
    promisedAmount: 12000,
    promisedBy: 'Accounts department',
  })
  ok('a promise is recorded', promise.ok, promise.ok ? '' : promise.error)

  const dup = await createPromise(SITE, actor, {
    customerId: promiser, promisedDate: daysAhead(9), promisedAmount: 500,
  })
  ok('*** an account cannot hold two open promises ***', !dup.ok)

  const shielded = await buildRun(SITE, actor, { customerIds: [promiser] })
  if (shielded.ok) {
    const item = (await listItems(SITE, shielded.runId)).find((i) => i.customerId === promiser)
    ok('*** an open promise stops the chase ***', item?.status === 'skipped')
    ok('…and says a promise is why',
        (item?.error ?? '').toLowerCase().includes('promise'), item?.error ?? '')
    await cancelRun(SITE, actor, shielded.runId)
  }

  const stored = (await listPromises(SITE, { customerId: promiser }))[0]
  ok('the balance at the time was captured', stored?.balanceAtPromise === 12000,
      String(stored?.balanceAtPromise))
  ok('making a promise logs a contact',
      (await listContacts(SITE, promiser)).some((c) => c.outcome === 'promised'))

  console.log('\n── A promise breaks on its own ─────────────────────────────\n')

  // Move the promise into the past, beyond grace.
  await siteExecute(SITE, 'UPDATE payment_promises SET promised_date = ? WHERE customer_id = ?', [
    daysAgo(10), promiser,
  ])

  const live = (await listPromises(SITE, { customerId: promiser }))[0]
  ok('*** an unpaid promise past its date reads as broken ***', live?.state === 'broken', live?.state)

  const swept = await sweepPromises(SITE, actor)
  ok('the sweep marks it', swept >= 1, `${swept} swept`)
  ok('*** it is recorded as broken, not quietly forgotten ***',
      (await listPromises(SITE, { customerId: promiser }))[0]?.status === 'broken')

  const afterBreak = await accountCredit(SITE, promiser)
  ok('the broken promise counts against the account', afterBreak?.position.promisesBroken === 1)
  ok('*** a broken promise makes the account poor or worse ***',
      afterBreak?.position.risk === 'poor' || afterBreak?.position.risk === 'bad',
      afterBreak?.position.risk)

  // And with the promise gone, chasing resumes.
  const resumed = await buildRun(SITE, actor, { customerIds: [promiser] })
  if (resumed.ok) {
    const item = (await listItems(SITE, resumed.runId)).find((i) => i.customerId === promiser)
    ok('*** a broken promise no longer shields the account ***', item?.status === 'queued',
        item?.error ?? '')
    await cancelRun(SITE, actor, resumed.runId)
  }

  console.log('\n── A kept promise is a kept promise ────────────────────────\n')

  const good = await makeCustomer('Good Payer', `good${stamp}@example.test`)
  await invoice(good, 3000, 50, 35)
  const kept = await createPromise(SITE, actor, {
    customerId: good, promisedDate: daysAhead(3), promisedAmount: 3000,
  })
  if (kept.ok) {
    await resolvePromise(SITE, actor, kept.id, 'kept', 3000)
    const credit = await accountCredit(SITE, good)
    ok('a kept promise is counted', credit?.position.promisesKept === 1)
    ok('reliability reads 100% on one kept promise', credit?.reliability.rate === 100)
    ok('…and says it is one promise, not a long record', credit?.reliability.decided === 1)
  }

  console.log('\n── Pausing, holding and releasing ──────────────────────────\n')

  const disputed = await makeCustomer('Disputer', `disp${stamp}@example.test`)
  await invoice(disputed, 6000, 60, 45)

  const badPause = await pauseChasing(SITE, actor, disputed, daysAgo(5), 'Backdated')
  ok('a pause cannot be set in the past', !badPause.ok)
  const noReason = await pauseChasing(SITE, actor, disputed, daysAhead(30), '  ')
  ok('a pause needs a reason', !noReason.ok)

  await pauseChasing(SITE, actor, disputed, daysAhead(30), 'Invoice under query')
  const paused = await buildRun(SITE, actor, { customerIds: [disputed] })
  if (paused.ok) {
    const item = (await listItems(SITE, paused.runId)).find((i) => i.customerId === disputed)
    ok('*** a paused account is not chased ***', item?.status === 'skipped')
    ok('…and the pause is the stated reason',
        (item?.error ?? '').toLowerCase().includes('paused'), item?.error ?? '')
    await cancelRun(SITE, actor, paused.runId)
  }

  await resumeChasing(SITE, actor, disputed)
  const unpaused = await buildRun(SITE, actor, { customerIds: [disputed] })
  if (unpaused.ok) {
    const item = (await listItems(SITE, unpaused.runId)).find((i) => i.customerId === disputed)
    ok('resuming makes it chaseable again', item?.status === 'queued')
    await cancelRun(SITE, actor, unpaused.runId)
  }

  // A logged dispute shields the account without anyone setting a pause.
  await logContact(SITE, actor, {
    customerId: disputed, kind: 'call', outcome: 'disputed',
    summary: 'Says the delivery was short',
  })
  const afterDispute = await buildRun(SITE, actor, { customerIds: [disputed] })
  if (afterDispute.ok) {
    const item = (await listItems(SITE, afterDispute.runId)).find((i) => i.customerId === disputed)
    ok('*** a disputed account is not chased for money ***', item?.status === 'skipped')
    ok('…and the dispute is the reason',
        (item?.error ?? '').toLowerCase().includes('disput'), item?.error ?? '')
    await cancelRun(SITE, actor, afterDispute.runId)
  }

  // A later contact supersedes the dispute — it should not shield forever.
  await logContact(SITE, actor, {
    customerId: disputed, kind: 'call', outcome: 'no_answer', summary: 'Resolved, chasing again',
  })
  const afterResolve = await buildRun(SITE, actor, { customerIds: [disputed] })
  if (afterResolve.ok) {
    const item = (await listItems(SITE, afterResolve.runId)).find((i) => i.customerId === disputed)
    ok('*** a resolved dispute stops shielding the account ***', item?.status === 'queued',
        item?.error ?? '')
    await cancelRun(SITE, actor, afterResolve.runId)
  }

  console.log('\n── Holds are explained, and reversible ─────────────────────\n')

  const heldCust = await makeCustomer('Held', `held${stamp}@example.test`)
  await invoice(heldCust, 4000, 100, 90)
  await holdAccount(SITE, actor, heldCust, 'Ignored three demands')
  const heldRow = await siteQueryOne<{ status: unknown }>(
    SITE, 'SELECT status FROM customers WHERE id = ?', [heldCust])
  ok('holding an account suspends its credit', heldRow?.status === 'on_hold')

  await holdAccount(SITE, actor, heldCust, 'A later, different reason')
  const stillFirst = await siteQueryOne<{ hold_reason: unknown }>(
    SITE, 'SELECT hold_reason FROM customer_credit_status WHERE customer_id = ?', [heldCust])
  ok('*** a second hold does not overwrite the original reason ***',
      String(stillFirst?.hold_reason).includes('three demands'), String(stillFirst?.hold_reason))

  await releaseAccount(SITE, actor, heldCust, 'Paid in full')
  const released = await siteQueryOne<{ status: unknown }>(
    SITE, 'SELECT status FROM customers WHERE id = ?', [heldCust])
  ok('releasing restores the account', released?.status === 'active')

  console.log('\n── Review: excluding a line ────────────────────────────────\n')

  const spared = await makeCustomer('Spared', `spared${stamp}@example.test`)
  await invoice(spared, 9000, 60, 45)
  const reviewRun = await buildRun(SITE, actor, { customerIds: [spared] })
  if (reviewRun.ok) {
    const item = (await listItems(SITE, reviewRun.runId))[0]
    const excluded = await excludeItem(SITE, actor, item.id, 'Owner asked us to hold off')
    ok('a line can be removed during review', excluded.ok)

    const after = (await listItems(SITE, reviewRun.runId))[0]
    ok('*** it is excluded, not deleted — the decision is on record ***', after.status === 'excluded')
    ok('…with the reason given', (after.error ?? '').includes('Owner asked'))

    const mail = collector()
    await processRun(SITE, reviewRun.runId, releaser, { companyName: 'Test Co', send: mail.send })
    ok('*** an excluded line is not emailed ***', mail.sent.length === 0)
    ok('*** and its account never moved up the ladder ***', (await levelOf(spared)) === 0)
  }

  console.log('\n── A cancelled run stays as evidence ───────────────────────\n')

  const doomed = await buildRun(SITE, actor, { customerIds: [spared] })
  if (doomed.ok) {
    await cancelRun(SITE, actor, doomed.runId)
    const after = await getRun(SITE, doomed.runId)
    ok('a cancelled run is kept, not deleted', after !== null && after.status === 'cancelled')

    const mail = collector()
    const nothing = await processRun(SITE, doomed.runId, releaser, {
      companyName: 'Test Co', send: mail.send,
    })
    ok('*** a cancelled run cannot be sent ***', nothing.sent === 0 && mail.sent.length === 0)
  }

  console.log('\n── Accounts with no email are listed, not dropped ──────────\n')

  const noEmail = await makeCustomer('No Email', null)
  await invoice(noEmail, 7000, 60, 45)
  const emailRun = await buildRun(SITE, actor, { customerIds: [noEmail] })
  if (emailRun.ok) {
    const item = (await listItems(SITE, emailRun.runId)).find((i) => i.customerId === noEmail)
    ok('*** an account with no email still appears on the run ***', item !== undefined)
    ok('…skipped, with the reason', item?.status === 'skipped' &&
        (item?.error ?? '').toLowerCase().includes('email'), item?.error ?? '')
    await cancelRun(SITE, actor, emailRun.runId)
  }

  console.log('\n── Nothing overdue is nothing to do ────────────────────────\n')

  const current = await makeCustomer('Current', `curr${stamp}@example.test`)
  await invoice(current, 5000, 5, -25) // due in 25 days
  const nothingDue = await buildRun(SITE, actor, { customerIds: [current] })
  if (nothingDue.ok) {
    const item = (await listItems(SITE, nothingDue.runId)).find((i) => i.customerId === current)
    ok('*** an account within terms is never chased ***', item?.status === 'skipped')
    await cancelRun(SITE, actor, nothingDue.runId)
  }

  const positions = await listPositions(SITE, { onlyOverdue: true })
  const currentPos = positions.find((p) => p.customerId === current)
  ok('*** and does not appear as overdue at all ***', currentPos === undefined)

  console.log('\n── The overdue figure excludes credits ─────────────────────\n')

  const inCredit = await makeCustomer('In Credit', `cred${stamp}@example.test`)
  await invoice(inCredit, 2000, 60, 45)
  await postTransaction(SITE, actor, {
    customerId: inCredit, docType: 'payment', amount: 5000, docDate: daysAgo(1),
    docNumber: `CCPAY${stamp}`, autoAllocate: true,
  })
  const creditPositions = await listPositions(SITE, {})
  const creditPos = creditPositions.find((p) => p.customerId === inCredit)
  ok('*** an account in credit shows nothing overdue ***', creditPos?.overdueAmount === 0,
      String(creditPos?.overdueAmount))

  console.log('\n── Summary and account view ────────────────────────────────\n')

  const summary = await creditSummary(SITE)
  ok('the summary totals something', summary.overdueTotal > 0, String(summary.overdueTotal))
  ok('overdue accounts are counted', summary.overdueAccounts > 0)
  ok('the risk bands add up to the accounts',
      Object.values(summary.byRisk).reduce((n, b) => n + b.count, 0) === summary.overdueAccounts)

  const docs = await overdueDocuments(SITE, slow)
  ok('the documents behind a balance are listed', docs.length > 0)
  ok('and each carries its age', docs.every((d) => d.daysOverdue >= 0))

  const view = await accountCredit(SITE, slow)
  ok('an account view assembles', view !== null)
  ok('…with its contact history', (view?.contacts.length ?? 0) > 0)

  console.log('\n── Cleanup ────────────────────────────────────────────────\n')

  for (const id of customerIds) {
    await siteExecute(SITE, 'DELETE FROM credit_contacts WHERE customer_id = ?', [id])
    await siteExecute(SITE, 'DELETE FROM payment_promises WHERE customer_id = ?', [id])
    await siteExecute(SITE, 'DELETE FROM dunning_run_items WHERE customer_id = ?', [id])
    await siteExecute(SITE, 'DELETE FROM customer_credit_status WHERE customer_id = ?', [id])
    // Allocations hang off the transactions, not the customer.
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
  // Runs whose every item is gone.
  await siteExecute(
    SITE,
    `DELETE FROM dunning_runs WHERE id NOT IN (SELECT DISTINCT run_id FROM dunning_run_items)
       AND user_name = 'Credit Test'`,
  )
  await siteExecute(SITE, `DELETE FROM activity_log WHERE user_name IN ('Credit Test','Second Person')`)
  const left = await siteQuery(SITE, 'SELECT id FROM customers WHERE code LIKE ?', [`CC${stamp}%`])
  ok('test data cleaned up', left.length === 0, `${left.length} left`)

  console.log(fails === 0 ? '\nAll credit control rules hold.\n' : `\n${fails} FAILURE(S)\n`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
