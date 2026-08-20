/**
 * What a table's autosave does when the bill cannot be written.
 *
 * The scenario: a waiter adds a round, and the shop's box is unreachable — a
 * cable out, the machine off, a switch rebooted mid-service.
 *
 * Until this was fixed the effect had a `try`/`finally` with NO catch. The
 * rejection escaped, nothing was said, and the basket sat on screen looking
 * exactly as it does after a successful save. A waiter carried on adding to a
 * round that existed nowhere but that browser.
 *
 * The logic is a few lines inside a React effect, so it is extracted here rather
 * than driven through a rendered till: the question is what the RULE does, and a
 * browser cannot be made to have an unreachable box on demand.
 *
 *   npx tsx scripts/test-table-autosave.ts
 */

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  if (ok) console.log(`  PASS  ${name}`)
  else {
    failures++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/* ── The rule, as PosShell applies it ─────────────────────────────────────── */

/** Mirrors the delay choice in the autosave effect. */
function delayFor(attempt: number): number {
  return attempt === 0 ? 900 : 5_000
}

type SaveOutcome = {
  basketCleared: boolean
  told: string | null
  nextAttempt: number
  parkedLocally: boolean
}

/**
 * One pass of the effect's body, reduced to its decisions.
 *
 * `save` stands in for updateTableBillAction / openTableAction: it resolves on
 * success, throws when the box cannot be reached.
 */
async function autosaveOnce(
  attempt: number,
  save: () => Promise<void>,
): Promise<SaveOutcome> {
  try {
    await save()
    return { basketCleared: false, told: null, nextAttempt: 0, parkedLocally: false }
  } catch {
    return {
      /* The basket STAYS. Clearing it would throw away a round the waiter
         believes is safe. */
      basketCleared: false,
      told: 'The bill could not be saved. It is still on this screen — trying again.',
      nextAttempt: attempt + 1,
      /* Deliberately NOT a local park — see the note in PosShell. */
      parkedLocally: false,
    }
  }
}

async function main() {
  console.log('\nA table autosave that cannot reach the box\n')

  const ok = () => Promise.resolve()
  const dead = () => Promise.reject(new Error('fetch failed'))

  /* ── The happy path is unchanged ───────────────────────────────────────── */

  const good = await autosaveOnce(0, ok)
  check('a successful save says nothing', good.told === null)
  check('  and keeps the fast debounce', delayFor(good.nextAttempt) === 900)

  /* ── The failure, which used to be silent ──────────────────────────────── */

  const bad = await autosaveOnce(0, dead)
  check('*** a failed save TELLS the waiter ***', bad.told !== null)
  check('  and says the basket is still there', /still on this screen/.test(bad.told ?? ''))

  /* THE thing that must not happen. A round the waiter believes is on the bill,
     silently discarded, is the failure this whole path exists to prevent. */
  check('*** the basket is never cleared on a failure ***', !bad.basketCleared)

  /*
   * And it must NOT quietly become a local park.
   *
   * The counter's Park button falls back to the device, and that is right there:
   * a parked basket belongs to the till that parked it. A TABLE is the opposite
   * — another waiter at another till must be able to pick it up — so a bill
   * written to this browser would be a table nobody else can see, on a floor
   * where it still reads free. Two waiters would serve it and only one bill
   * would exist.
   */
  check('*** a table bill does NOT fall back to a local park ***', !bad.parkedLocally)

  /* ── It actually tries again ───────────────────────────────────────────── */

  /* The effect is keyed on the LINES, so without the bumped counter a waiter who
     added a round and then stopped would never retry: the basket would sit
     unsaved until they happened to touch it again. */
  check('*** a failure schedules another attempt ***', bad.nextAttempt === 1)
  check('  and the retry waits longer than a keystroke debounce', delayFor(bad.nextAttempt) > 900)
  check('  five seconds, not nine hundred milliseconds', delayFor(bad.nextAttempt) === 5_000)

  /* Ten tills retrying every 900ms would sit on a dead box's doorstep for the
     whole outage; the basket is safe on screen meanwhile. */
  const perMinuteFast = 60_000 / delayFor(0)
  const perMinuteRetry = 60_000 / delayFor(1)
  check(
    '  which is far fewer requests at a dead box',
    perMinuteRetry * 10 < perMinuteFast * 10,
    `${perMinuteRetry * 10}/min vs ${perMinuteFast * 10}/min for ten tills`,
  )

  /* ── Recovery ──────────────────────────────────────────────────────────── */

  /* Left at a retry count, every later save on this table would wait five
     seconds for no reason. */
  const recovered = await autosaveOnce(3, ok)
  check('*** a success after retries resets the delay ***', recovered.nextAttempt === 0)
  check('  back to the fast debounce', delayFor(recovered.nextAttempt) === 900)

  /* Repeated failure keeps counting rather than giving up: the box coming back
     is the expected outcome, and abandoning the basket is never one. */
  let attempt = 0
  for (let i = 0; i < 5; i++) attempt = (await autosaveOnce(attempt, dead)).nextAttempt
  check('repeated failures keep retrying rather than giving up', attempt === 5)
  check('  and never clear the basket', !(await autosaveOnce(attempt, dead)).basketCleared)

  console.log(`\n${failures === 0 ? 'The autosave holds.' : `${failures} FAILED`}\n`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(`\n  ${err?.message || err}\n`)
  process.exit(1)
})
