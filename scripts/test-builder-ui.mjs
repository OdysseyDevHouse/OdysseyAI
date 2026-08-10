/**
 * The page builder, driven the way an owner drives it.
 *
 *   npm run test:builder-ui
 *
 * ── WHY THIS EXISTS ALONGSIDE test-builder.ts ────────────────────────────
 *
 * That one asserts the MODEL: normalisation, caps, emptiness, the publish
 * diff. Two hundred and forty-seven assertions, and not one of them touches
 * React — so the undo stack, the autosave debounce, the drag layer and the
 * outline's arrows are the largest untested surface in the builder. All four
 * are state machines, and all four are the kind that break quietly: undo
 * losing a step, autosave firing on a no-op edit, an arrow moving the wrong
 * row. None of that shows up in a screenshot.
 *
 * ── A REAL BROWSER, NOT jsdom ────────────────────────────────────────────
 *
 * Playwright is already a dependency and its Chromium is already downloaded,
 * so there is no new tooling here. That also buys the thing jsdom cannot give:
 * these run against the ACTUAL page, with real server actions writing to a
 * real database — so a test passing means the feature works, not that a mock
 * agreed with another mock.
 *
 * ── IT PUTS THE PAGE BACK ────────────────────────────────────────────────
 *
 * It edits a shop's real front page, so it snapshots the draft first and
 * restores it at the end — the same contract test-builder.ts keeps. A test
 * that leaves an owner's page rearranged is worse than no test.
 *
 * ── AND IT IS NOT IN `npm test` ──────────────────────────────────────────
 *
 * Deliberately. Every other suite talks to the database and nothing else; this
 * one needs `npm run dev` up on :4100 and a real Chrome. Folding it into the
 * chain would make `npm test` fail on a machine that simply had not started
 * the server — a failure that says nothing about the code and teaches everyone
 * to ignore the output. Run it alongside, when a change touches the builder.
 */
import { chromium } from 'playwright'
import { SignJWT } from 'jose'
import mysql from 'mysql2/promise'

const BASE = process.env.TEST_BASE ?? 'http://localhost:4100'
const SITE = 1

let fails = 0
const ok = (label, cond, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

/** A session cookie the app accepts, signed as lib/session.ts signs it. */
async function sessionCookie() {
  const secret = process.env.SESSION_SECRET
  if (!secret) throw new Error('SESSION_SECRET is not set — run with --env-file=.env')
  const token = await new SignJWT({
    userId: 1,
    email: 'tiaan@point-of-sale.co.za',
    name: 'Builder UI test',
    siteId: SITE,
    mustChangePassword: false,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(secret))
  return { name: 'odyssey_session', value: token, url: BASE }
}

async function db() {
  return mysql.createConnection({
    host: process.env.SITE_DB_HOST_OVERRIDE || 'localhost',
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: 'ody10000_master',
  })
}

/* ── The page's own vocabulary ────────────────────────────────────────────── */

/**
 * How many sections the canvas is drawing.
 *
 * Counted by the per-section drag handle rather than by anything structural:
 * it is one per section by construction, and it is the control the test
 * itself would use to reorder — so if this count is wrong, the thing the
 * owner reaches for is wrong too.
 */
const sectionCount = (page) => page.locator('[aria-label^="Drag "]').count()

/** The names in the outline, in order — what a reorder is measured against. */
const outlineNames = (page) =>
  page.locator('ol li button[aria-current]').evaluateAll((els) =>
    els.map((e) => e.querySelector('span span')?.textContent?.trim() ?? ''),
  )

async function main() {
  const conn = await db()

  // Snapshot the front page's draft, and put it back at the end whatever
  // happens — see the header.
  const [[before]] = await conn.query(
    `SELECT layout_draft FROM storefront_pages WHERE kind = 'home'`,
  )

  const browser = await chromium.launch({ channel: 'chrome' })
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
  await context.addCookies([await sessionCookie()])
  const page = await context.newPage()

  // A hydration mismatch or a thrown effect is exactly the class of bug these
  // tests exist to catch, and it would otherwise pass silently as "the button
  // did nothing".
  /*
   * Thrown errors and React's own complaints — a hydration mismatch or a
   * failed effect is exactly the class of bug these tests exist to catch, and
   * would otherwise pass silently as "the button did nothing".
   *
   * A bare "Failed to load resource" is deliberately NOT counted. The dev
   * server 404s things like a missing favicon on every page in the app, so
   * treating that as a failure would make this test fail for reasons that have
   * nothing to do with the builder — and a test that cries wolf is one nobody
   * reads the output of.
   */
  const problems = []
  const noteProblem = (text) => {
    if (/Failed to load resource/i.test(text)) return
    problems.push(text.slice(0, 160))
  }
  page.on('pageerror', (e) => noteProblem(String(e)))
  page.on('console', (m) => {
    if (m.type() === 'error') noteProblem(m.text())
  })

  try {
    // A KNOWN page to work from, so counts are absolute rather than relative
    // to whatever the shop happens to have.
    /*
     * SIX sections, not three.
     *
     * The outline only appears from OUTLINE_FROM up — below that the canvas is
     * the outline and a second list of the same names is noise. A three-section
     * page would test the reorder arrows against a panel that is deliberately
     * not there.
     */
    await conn.query(
      `UPDATE storefront_pages SET layout_draft = ? WHERE kind = 'home'`,
      [
        JSON.stringify(
          ['ALPHA', 'BRAVO', 'CHARLIE', 'DELTA', 'ECHO', 'FOXTROT'].map((title, i) => ({
            id: `s${i}`,
            kind: 'text',
            title,
            text: title.toLowerCase(),
            enabled: true,
          })),
        ),
      ],
    )
    const START = 6

    await page.goto(`${BASE}/online-store/builder`, { waitUntil: 'networkidle' })

    console.log('\n— The page loads and hydrates —')
    ok('every section is drawn', (await sectionCount(page)) === START, String(await sectionCount(page)))
    ok('the page threw nothing on load', problems.length === 0, problems[0] ?? '')

    console.log('\n— Removing, and undoing it —')
    await page.locator('[aria-label="Remove ALPHA"]').click()
    ok('a removed section goes', (await sectionCount(page)) === START - 1)
    ok('and it is the right one', !(await outlineNames(page)).includes('ALPHA'))

    // Ctrl+Z on the document, which is where the handler binds — the focus at
    // the time is usually nothing at all.
    await page.keyboard.press('Control+z')
    ok('undo puts it back', (await sectionCount(page)) === START)
    ok('and it is the same one', (await outlineNames(page)).includes('ALPHA'))

    await page.keyboard.press('Control+Shift+z')
    ok('redo takes it away again', (await sectionCount(page)) === START - 1)
    await page.keyboard.press('Control+z')
    ok('and undo brings it back once more', (await sectionCount(page)) === START)

    console.log('\n— Undo does not eat a keystroke —')
    /*
     * The one undo behaviour that is easy to get wrong and impossible to spot
     * in a screenshot: inside a text field, Ctrl+Z must mean "undo my typing"
     * and NOT "remove a whole section". Hijacking it is precisely the surprise
     * undo exists to prevent.
     */
    // A SECTION by name, not the first "Edit" on the page — the masthead and
    // footer carry one too, and they open Appearance rather than a section.
    await page.locator('[aria-label="Edit BRAVO"]').click()
    // Scoped to the VISIBLE one: the schedule and save-section dialogs are in
    // the DOM while closed, so an unscoped label match finds their fields first.
    const heading = page.getByLabel('Heading').and(page.locator(':visible')).first()
    await heading.fill('EDITED')
    await heading.press('Control+z')
    ok('Ctrl+Z in a field does not remove a section', (await sectionCount(page)) === START)

    console.log('\n— The outline reorders —')
    const namesBefore = await outlineNames(page)
    ok('the outline lists every section', namesBefore.length === START, namesBefore.join('|'))

    // Move the LAST one up. Chosen deliberately: an off-by-one in the splice
    // shows here and not when moving the first or middle row.
    await page.locator(`[aria-label="Move ${namesBefore[2]} up"]`).click()
    const namesAfter = await outlineNames(page)
    ok(
      'moving one up swaps it with the row above',
      namesAfter[1] === namesBefore[2] && namesAfter[2] === namesBefore[1],
      namesAfter.join('|'),
    )
    ok('and nothing is lost', namesAfter.length === START)

    await page.keyboard.press('Control+z')
    ok('a reorder is undoable too', (await outlineNames(page)).join('|') === namesBefore.join('|'))

    console.log('\n— The draft autosaves —')
    /*
     * The debounce is 1200ms, so this waits for the SERVER rather than for a
     * timer: polling the row is what proves the write actually happened, where
     * a fixed sleep would only prove the test waited.
     */
    await page.locator('[aria-label="Edit CHARLIE"]').click()
    await page.getByLabel('Heading').and(page.locator(':visible')).first().fill('AUTOSAVED')

    let saved = false
    for (let i = 0; i < 30 && !saved; i++) {
      await page.waitForTimeout(300)
      const [[row]] = await conn.query(
        `SELECT layout_draft FROM storefront_pages WHERE kind = 'home'`,
      )
      saved = String(row?.layout_draft ?? '').includes('AUTOSAVED')
    }
    ok('an edit reaches the database by itself', saved)

    console.log('\n— Adding a section —')
    const countBefore = await sectionCount(page)
    await page.getByRole('button', { name: 'Add a section' }).first().click()
    await page.getByRole('menuitem', { name: 'A paragraph' }).first().click()
    ok('a new section appears', (await sectionCount(page)) === countBefore + 1)

    console.log('\n— Nothing threw along the way —')
    ok('no page errors', problems.length === 0, problems.slice(0, 2).join(' | '))
  } finally {
    await browser.close()
    // Put the page back exactly as it was, whatever happened above.
    await conn.query(`UPDATE storefront_pages SET layout_draft = ? WHERE kind = 'home'`, [
      before?.layout_draft ?? null,
    ])
    await conn.end()
  }

  console.log(`\n${fails === 0 ? 'All builder UI checks passed.' : `${fails} FAILED.`}`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
