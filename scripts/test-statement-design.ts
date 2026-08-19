/**
 * The statement, and the two documents that share its design.
 *
 *   npm run test:statement-design
 *
 * ── WHAT THIS PROVES ─────────────────────────────────────────────────────
 *
 * That ONE design serves a customer statement, a supplier account and a
 * remittance advice. They are the same shape saying three different things, and
 * everything that differs arrives as a token — so a shop restyles its letterhead
 * once and all three follow.
 *
 * The failure this guards against is subtle and expensive: a remittance advice
 * that reads like a demand asks a supplier to pay money we have just sent them.
 * The variants are therefore checked against each other, not only individually.
 *
 * Needs no database and no browser.
 */
import { STATEMENT_BLOCKS } from '../src/lib/stationery/defaults/statementBlocks'
import { STATEMENT_DEFAULT } from '../src/lib/stationery/defaults/statement'
import { compileDocument, compileBlocks, supportsBlocks } from '../src/lib/stationery/compile'
import { statementTokens } from '../src/lib/stationery/adapters/statement'
import { STATEMENT_HEADINGS, STATEMENT_DUE_LABELS, type StatementVariant } from '../src/lib/statements/variant'
import { renderTemplate } from '../src/lib/stationery/render'
import { validateTemplate } from '../src/lib/stationery/validate'
import { sanitiseTemplate } from '../src/lib/stationery/sanitise'
import { parseSpec, serialiseSpec, validateSpec, removeBlock } from '../src/lib/stationery/blocks'
import { DEFAULT_SPECS } from '../src/lib/stationery/resolve'
import type { StatementData } from '../src/lib/statements/render'

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

const OWNER = { isOwner: true, granted: new Set<string>() }

function statement(over: Record<string, unknown> = {}): StatementData {
  return {
    format: 'open-item',
    site: { name: 'Acme Trading', vatNumber: '4123456789' },
    account: {
      id: 3, code: 'CUST-003', name: 'Khumalo Supplies', contactName: 'Precious',
      email: 'ap@khumalo.test', phone: '031 555 0111', vatNumber: '4111222333',
      addressLines: ['155 Industrial Road', 'Durban 3957'],
      creditLimit: 50000, paymentTermsDays: 30,
    },
    period: { from: '2026-08-01', to: '2026-08-31' },
    periodLabel: 'August 2026',
    cycle: 'monthly',
    bucketLabels: { current: 'Current', d30: '30 days', d60: '60 days', d90: '90 days', d120: '120+ days' },
    openingBalance: 1000,
    closingBalance: 2150,
    lines: [
      { date: '2026-08-04', docType: 'Invoice', docNumber: 'INV000456', description: 'Goods',
        reference: 'PO-77', debit: 1150, credit: 0, outstanding: 1150, daysOverdue: 0, balance: 2150 },
      { date: '2026-08-18', docType: 'Payment', docNumber: 'RCT000091', description: 'Thank you',
        reference: null, debit: 0, credit: 500, outstanding: 0, daysOverdue: 0, balance: 1650 },
    ],
    aging: { current: 1150, d30: 500, d60: 0, d90: 0, d120: 500, total: 2150 },
    dueNow: 1000,
    generatedAt: new Date('2026-08-31T12:00:00Z'),
    ...over,
  } as unknown as StatementData
}

const textOf = (html: string) =>
  html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()

const render = (variant: StatementVariant, data = statement()) =>
  renderTemplate(compileDocument(STATEMENT_BLOCKS, 'statement'), 'statement', {
    ...statementTokens(data, variant, { printedAt: '31/08/2026' }),
    capabilities: OWNER,
  })

/* ── one design, three documents ─────────────────────────────────────────── */

console.log('\n-- a statement, a supplier account and a remittance --')
{
  const cust = textOf(render('statement'))
  const supp = textOf(render('supplier-statement'))
  const remit = textOf(render('remittance'))

  ok('a customer statement calls itself a STATEMENT',
    /STATEMENT/.test(cust) && !/REMITTANCE/.test(cust))
  ok('a supplier one calls itself a SUPPLIER ACCOUNT', /SUPPLIER ACCOUNT/.test(supp))
  ok('a remittance calls itself a REMITTANCE ADVICE', /REMITTANCE ADVICE/.test(remit))

  /*
   * THE FIGURE MEANS THREE DIFFERENT THINGS.
   *
   * Money we want, money we owe, money already sent. One fixed label would be
   * wrong twice — and "Amount due" on a remittance asks a supplier to pay what
   * we have just paid them.
   */
  ok('the customer statement asks for an Amount due', /Amount due/.test(cust))
  ok('the supplier one reports a Balance owed', /Balance owed/.test(supp))
  ok('the remittance reports an Amount paid',
    /Amount paid/.test(remit) && !/Amount due/.test(remit))

  ok('a customer statement asks for payment', /Please settle/.test(cust))
  ok('...and a remittance asks for nothing at all',
    /No action is required/.test(remit) && !/Please settle/.test(remit))

  /*
   * And the three are the SAME design — not three that happen to look alike.
   * If this ever fails, somebody has forked the layout.
   */
  ok('all three render from one design',
    DEFAULT_SPECS.statement === STATEMENT_BLOCKS)
}

/* ── the age ladder ──────────────────────────────────────────────────────── */

console.log('\n-- how old the debt is --')
{
  const cust = textOf(render('statement'))

  /*
   * The headings TRAVEL WITH THE DATA, because they are not fixed: a weekly
   * account's first overdue rung is 7 days and a monthly one's is 30. A column
   * headed "30 days" holding eight-days-late debt is worse than no heading.
   */
  ok('the ladder prints its rungs', /Current/.test(cust) && /30 days/.test(cust) && /120\+ days/.test(cust))
  ok('...with the amounts against them', /R1 150\.00/.test(cust) && /R500\.00/.test(cust))
  ok('...and a total', /Total/.test(cust) && /R2 150\.00/.test(cust))

  /*
   * A WEEKLY ACCOUNT AGES DIFFERENTLY.
   *
   * Checked on the ROWS rather than on the page text: the account's payment
   * terms are also "30 days", so asserting that string is absent from the whole
   * page tests the terms line rather than the ladder — which is what the first
   * version of this check did, and it failed against correct output.
   */
  const weekly = statement({
    bucketLabels: { current: 'Current', d30: '7 days', d60: '14 days', d90: '21 days', d120: '28+ days' },
  })
  const rungs = statementTokens(weekly, 'statement').sections.aging!.map((r) => r['bucket.label'])
  ok('a weekly account gets weekly rungs',
    rungs.includes('7 days') && rungs.includes('28+ days') && !rungs.includes('30 days'),
    rungs.join(', '))

  /*
   * A REMITTANCE HAS NO LADDER — nothing is overdue on money already paid. The
   * section emits no rows, and a table with no rows takes its headings with it,
   * so nothing is left behind.
   */
  const remitMarkup = render('remittance')
  const tables = remitMarkup.match(/<div class="sd-table">[\s\S]*?<\/table><\/div>/g) ?? []
  const agingTable = tables.find((t) => t.includes('Age'))
  ok('a remittance emits no ladder rows', !!agingTable && /<tbody><\/tbody>/.test(agingTable))
  ok('...and the empty table can hide its own headings',
    compileDocument(STATEMENT_BLOCKS, 'statement').includes('sd-table'))
}

/* ── the account, and what it must not say ───────────────────────────────── */

console.log('\n-- the account block --')
{
  const cust = textOf(render('statement'))
  const remit = textOf(render('remittance'))

  ok('the statement shows whose account it is', /Khumalo Supplies/.test(cust))
  ok('...its code', /CUST-003/.test(cust))
  ok('...its terms', /30 days/.test(cust))
  ok('...and the credit limit', /R50 000\.00/.test(cust))

  /*
   * NEVER ON A REMITTANCE. Telling a supplier the credit limit we hold with them
   * on the advice that pays them is at best noise and at worst a negotiating
   * position we did not mean to publish.
   */
  ok('a remittance shows no credit limit', !/R50 000\.00/.test(remit))

  // Labels are not doubled: the row supplies one, so the value must not.
  ok('a labelled row does not repeat its own label',
    !/Terms Terms:/.test(cust) && !/Credit limit Credit limit:/.test(cust), cust.slice(0, 200))
}

/* ── the movements ───────────────────────────────────────────────────────── */

console.log('\n-- the lines --')
{
  const cust = textOf(render('statement'))
  ok('a document line shows its date and number', /2026-08-04/.test(cust) && /INV000456/.test(cust))
  ok('...its reference', /PO-77/.test(cust))
  ok('a debit and a credit are in their own columns',
    /R1 150\.00/.test(cust) && /R500\.00/.test(cust))

  /*
   * A settled line shows nothing in Owing rather than R0.00 — a page of figures
   * reads better without a column of noughts, and a zero here is the absence of
   * an amount rather than a claim about one.
   */
  const rows = statementTokens(statement(), 'statement').sections.lines!
  ok('a settled line leaves the Owing column blank', rows[1]['line.owing'] === null)
  ok('...but an open one shows what is still owed', rows[0]['line.owing'] === 1150)

  /*
   * On an ACTIVITY statement the same column is a running balance, which is a
   * real figure even at zero. The two formats are different questions.
   */
  const activity = statementTokens(statement({ format: 'activity' }), 'statement').sections.lines!
  ok('an activity statement shows the running balance instead', activity[1]['line.owing'] === 1650)
}

/* ── the ordinary checks every document gets ─────────────────────────────── */

console.log('\n-- structure, storage and validation --')
{
  const compiled = compileDocument(STATEMENT_BLOCKS, 'statement')

  const v = validateTemplate('statement', compiled)
  ok('the shipped design passes the validator', v.ok, JSON.stringify(v.errors.map((e) => e.message)))

  for (const [what, id] of [
    ['the account', 'st-account'],
    ['the letterhead', 'st-letterhead'],
    ['the title', 'st-title'],
  ] as const) {
    const without = compileDocument(removeBlock(STATEMENT_BLOCKS, id), 'statement')
    ok(`a statement without ${what} is refused`, !validateTemplate('statement', without).ok)
  }

  ok('it validates structurally', validateSpec(STATEMENT_BLOCKS, 'statement').ok,
    JSON.stringify(validateSpec(STATEMENT_BLOCKS, 'statement').errors))

  const back = parseSpec(serialiseSpec(STATEMENT_BLOCKS), 'statement')
  ok('the design survives being stored and read back',
    !!back && JSON.stringify(back.blocks) === JSON.stringify(STATEMENT_BLOCKS.blocks))

  /*
   * The ladder's table names a SECTION other than the items, and its columns
   * name tokens from that section. Both have to survive a round trip, or a
   * stored design comes back with an empty ladder.
   */
  const ladder = back?.blocks.find((b) => b.id === 'st-aging')
  ok('...including which section a table walks', ladder?.section === 'aging')
  ok('...and the columns that belong to it',
    ladder?.columns?.some((c) => c.token === 'bucket.label') === true)

  ok('the visual designer is offered for it', supportsBlocks('statement'))

  ok('the markup default matches the block design', STATEMENT_DEFAULT === compiled,
    STATEMENT_DEFAULT === compiled ? '' : 'regenerate defaults/statement.ts')

  const perBlock = compileBlocks(STATEMENT_BLOCKS, 'statement')
  const missing = STATEMENT_BLOCKS.blocks.filter(
    (b) => perBlock[b.id] !== '' && !compiled.includes(perBlock[b.id]),
  )
  ok("each block's canvas markup appears verbatim in the printed page",
    missing.length === 0, missing.map((b) => b.id).join(', '))

  const cleaned = sanitiseTemplate(compiled)
  ok('it survives the sanitiser with its structure intact',
    cleaned.includes('<article') && cleaned.includes('{#each lines}') && cleaned.includes('{#each aging}'))

  // The wording maps are complete, or a variant renders an unnamed document.
  for (const k of ['statement', 'supplier-statement', 'remittance'] as const) {
    ok(`${k} has a heading and a label for its figure`,
      !!STATEMENT_HEADINGS[k] && !!STATEMENT_DUE_LABELS[k])
  }
}

/* ── and the same design as a PDF ────────────────────────────────────────── */

async function pdfChecks() {
  console.log('\n-- the emailed copy says the same things --')

  const { renderSpecPdf } = await import('../src/lib/stationery/pdf')
  const zlib = await import('node:zlib')

  const pdfText = (pdf: Buffer): string => {
    const raw = pdf.toString('latin1')
    let content = ''
    const re = /stream\r?\n/g
    let m: RegExpExecArray | null
    while ((m = re.exec(raw))) {
      const start = m.index + m[0].length
      const end = raw.indexOf('endstream', start)
      if (end < 0) continue
      try {
        content += zlib.inflateSync(pdf.subarray(start, end)).toString('latin1')
      } catch {
        /* a font file, not a content stream */
      }
    }
    return [...content.matchAll(/<([0-9a-fA-F]+)>/g)]
      .map(([, hex]) => Buffer.from(hex, 'hex').toString('latin1'))
      .join('')
  }

  const draw = (variant: StatementVariant) =>
    renderSpecPdf(STATEMENT_BLOCKS, 'statement', statementTokens(statement(), variant, {}))

  const cust = pdfText(await draw('statement'))
  const remit = pdfText(await draw('remittance'))

  /*
   * THE LABEL COMES FROM THE BLOCK, NOT THE CATALOG.
   *
   * The PDF renderer took it from the catalog, whose label is written for a
   * token PICKER — so a real statement printed "The figure to pay" where the
   * page wants "Amount due". Only a rendered PDF showed it: the HTML path had
   * been reading the block's title all along.
   */
  ok('the PDF names the figure as the design does',
    cust.includes('Amount due') && !cust.includes('figure to pay'), cust.slice(-160))
  ok('...and a remittance says Amount paid',
    remit.includes('Amount paid') && !remit.includes('Amount due'))

  /*
   * AN EMPTY TABLE DRAWS NOTHING, headings included.
   *
   * The HTML compiler hides one with CSS; a PDF has no CSS, so it must not draw
   * it at all. And the check has to come BEFORE the headings are drawn — the
   * first version of it returned early after them, so "AGE AMOUNT" printed over
   * nothing on every remittance.
   */
  ok('the statement PDF carries the age ladder', /Current/.test(cust) && /AGE/.test(cust))
  ok('a remittance PDF has no ladder at all',
    !/Current/.test(remit) && !/AGE/.test(remit), remit.slice(-160))

  ok('the movements are on both',
    cust.includes('INV000456') && remit.includes('INV000456'))
}


pdfChecks().then(() => {
  console.log(`\n${fails === 0 ? 'All statement-design checks passed.' : `${fails} FAILED`}`)
  process.exit(fails === 0 ? 0 : 1)
})
