/**
 * The stationery designer's pure half.
 *
 *   npm run test:stationery
 *
 * The catalog, the sanitiser, the validator and the renderer need no database
 * and no browser, so this runs in about a second and is the suite to reach for
 * while changing any of them.
 *
 * ── THE SANITISER SECTION IS ADVERSARIAL ON PURPOSE ──────────────────────
 *
 * A designed template is markup a person wrote, saved to the database, and
 * later rendered into a page in this app's own origin. That is a stored-XSS
 * surface, and the only thing standing in front of it is sanitiseTemplate. So
 * those cases are written as attacks rather than as examples: each one is a
 * thing someone would actually try, and a PASS means the attempt died.
 */
import {
  sanitiseTemplate,
  sanitiseCss,
  unsupportedIn,
} from '../src/lib/stationery/sanitise'
import { validateTemplate } from '../src/lib/stationery/validate'
import { renderTemplate, formatValue, escapeHtml } from '../src/lib/stationery/render'
import { getDocType, tokensFor, allTokens } from '../src/lib/stationery/catalog'
import { resolveTemplate } from '../src/lib/stationery/resolve'
import { PURCHASE_ORDER_DEFAULT } from '../src/lib/stationery/defaults/purchaseOrder'

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

const OWNER = { isOwner: true, granted: new Set<string>() }
const JUNIOR = { isOwner: false, granted: new Set<string>(['purchasing.view']) }
const BUYER = { isOwner: false, granted: new Set<string>(['purchasing.view', 'products.cost']) }

/* ── sanitiser: things that must not survive ─────────────────────────────── */

console.log('\n-- sanitiser --')

{
  const out = sanitiseTemplate('<p>hi</p><script>alert(1)</script>')
  ok('script element is removed with its content', !/alert/.test(out) && !/script/i.test(out), out)
}
{
  const out = sanitiseTemplate('<img src="/uploads/a.png" onerror="alert(1)">')
  ok('on* handler is stripped, image survives', !/onerror/i.test(out) && /src="\/uploads/.test(out), out)
}
{
  const out = sanitiseTemplate('<div ONCLICK="x()">a</div>')
  ok('uppercase handler is stripped too', !/onclick/i.test(out), out)
}
{
  const out = sanitiseTemplate('<img src="https://evil.example/track.gif">')
  ok('off-site image src is refused', !/evil\.example/.test(out), out)
}
{
  const out = sanitiseTemplate('<img src="//evil.example/x.gif">')
  ok('protocol-relative image src is refused', !/evil\.example/.test(out), out)
}
{
  const out = sanitiseTemplate('<img src="data:image/svg+xml;base64,PHN2Zz4=">')
  ok('data: image src is refused (SVG is a script container)', !/data:/.test(out), out)
}
{
  const out = sanitiseTemplate('<img src="/uploads/../../etc/passwd">')
  ok('traversal in image src is refused', !/passwd/.test(out), out)
}
{
  const out = sanitiseTemplate('<div style="background:url(https://evil.example/x)">a</div>')
  ok('url() in a style attribute is stripped', !/evil\.example/.test(out), out)
}
{
  const out = sanitiseTemplate('<style>@import url("https://evil.example/x.css"); p{color:#000}</style><p>a</p>')
  ok('@import in a style block is stripped', !/evil\.example/.test(out) && !/@import/i.test(out), out)
  ok('...but the rest of the CSS survives', /color:#000/.test(out), out)
}
{
  const out = sanitiseTemplate('<iframe src="/x"></iframe><p>a</p>')
  ok('iframe is removed', !/iframe/i.test(out), out)
}
{
  const out = sanitiseTemplate('<form action="/x"><input name="pw"></form>')
  ok('form and input are removed', !/form|input/i.test(out), out)
}
{
  const out = sanitiseTemplate('<link rel="stylesheet" href="https://evil.example/x.css">')
  ok('link element is removed', !/evil\.example/.test(out) && !/link/i.test(out), out)
}
{
  const out = sanitiseTemplate('<div style="/* x */ behavior:url(#default#time2)">a</div>')
  ok('behavior: is stripped', !/behavior/i.test(out), out)
}
{
  const out = sanitiseTemplate('<p>a</p></div></body>')
  ok('stray closing tags cannot break out', !/<\/body>/i.test(out), out)
}
{
  const out = sanitiseTemplate('<svg><script>alert(1)</script></svg>')
  ok('svg is removed entirely', !/svg|alert/i.test(out), out)
}

/* ── sanitiser: things that must survive, or the feature is useless ──────── */
{
  const tpl = '<table class="lines"><thead><tr><th colspan="2">Item</th></tr></thead>' +
    '<tbody><tr><td style="text-align:right">x</td></tr></tbody></table>'
  const out = sanitiseTemplate(tpl)
  ok('tables survive', /<table/.test(out) && /<th colspan="2"/.test(out), out)
  ok('style attribute survives', /text-align:right/.test(out), out)
  ok('class attribute survives', /class="lines"/.test(out), out)
}
{
  const out = sanitiseTemplate('<p>Total: {totals.totalIncl}</p>{#each lines}<i>{line.qty}</i>{/each}')
  ok('tokens pass through untouched', /\{totals\.totalIncl\}/.test(out) && /\{#each lines\}/.test(out), out)
}
{
  ok('unsupportedIn reports what will be dropped', unsupportedIn('<p><marquee>x</marquee></p>').includes('marquee'))
  ok('unsupportedIn does not report style', !unsupportedIn('<style>p{}</style>').includes('style'))
}
{
  ok('sanitiseCss keeps ordinary declarations', sanitiseCss('color: #16191d; font-size: 11pt').includes('font-size'))
}

/* ── validator ───────────────────────────────────────────────────────────── */

console.log('\n-- validator --')

const GOOD_PO =
  '<h1>{site.name}</h1><p>{doc.number}</p><p>{supplier.name}</p>' +
  '<table>{#each lines}<tr><td>{line.description}</td><td>{line.qty}</td></tr>{/each}</table>'

{
  const r = validateTemplate('purchase_order', GOOD_PO)
  ok('a complete purchase order validates', r.ok, JSON.stringify(r.errors))
}
{
  const r = validateTemplate('purchase_order', '<h1>{site.name}</h1><p>{supplier.name}</p>')
  ok('missing document number is blocked', !r.ok && r.errors.some((e) => e.kind === 'missing-required' && e.token === 'doc.number'), JSON.stringify(r.errors))
}
{
  const r = validateTemplate('purchase_order', GOOD_PO + '{doc.nonsense}')
  ok('an unknown token is reported', r.errors.some((e) => e.kind === 'unknown-token'), JSON.stringify(r.errors))
}
{
  const r = validateTemplate('purchase_order', '<p>{line.qty}</p>' + GOOD_PO)
  ok('a line token outside its loop is reported', r.errors.some((e) => e.kind === 'misplaced-token'), JSON.stringify(r.errors))
}
{
  const r = validateTemplate('purchase_order', GOOD_PO.replace('{/each}', ''))
  ok('an unclosed section is reported', r.errors.some((e) => e.kind === 'unclosed-section'), JSON.stringify(r.errors))
}
{
  const r = validateTemplate('purchase_order', GOOD_PO + '{#each widgets}x{/each}')
  ok('an unknown section is reported', r.errors.some((e) => e.kind === 'unknown-section'), JSON.stringify(r.errors))
}
{
  const r = validateTemplate('no_such_doc', GOOD_PO)
  ok('an unknown document type is rejected', !r.ok)
}
{
  // The whole point of the permission model: the author's own rights must not
  // decide what everyone else's paperwork shows.
  const r = validateTemplate('purchase_order', GOOD_PO.replace('{line.qty}', '{line.unitCostExcl}'))
  ok('a cost token is valid regardless of who is editing', r.ok, JSON.stringify(r.errors))
}

/* ── renderer ────────────────────────────────────────────────────────────── */

console.log('\n-- renderer --')

const values = {
  'site.name': 'Acme Trading',
  'doc.number': 'PO000123',
  'supplier.name': 'Bolt Supply Co',
  'totals.totalIncl': 1234.5,
  'site.address': 'Unit 4\nIndustrial Park',
}
const rows = [
  { 'line.description': 'Widget', 'line.qty': 3, 'line.unitCostExcl': 19.99 },
  { 'line.description': 'Gadget', 'line.qty': 1.5, 'line.unitCostExcl': 4 },
]

{
  const out = renderTemplate('<p>{site.name} {doc.number}</p>', 'purchase_order', {
    values, sections: {}, capabilities: OWNER,
  })
  ok('document tokens substitute', out === '<p>Acme Trading PO000123</p>', out)
}
{
  const out = renderTemplate('{#each lines}<td>{line.description}</td>{/each}', 'purchase_order', {
    values, sections: { lines: rows }, capabilities: OWNER,
  })
  ok('a section repeats per row', out === '<td>Widget</td><td>Gadget</td>', out)
}
{
  const out = renderTemplate('{#each lines}<td>{site.name}</td>{/each}', 'purchase_order', {
    values, sections: { lines: rows }, capabilities: OWNER,
  })
  ok('a row can use document tokens', out === '<td>Acme Trading</td><td>Acme Trading</td>', out)
}
{
  const out = renderTemplate('{#each lines}<td>{line.unitCostExcl}</td>{/each}', 'purchase_order', {
    values, sections: { lines: rows }, capabilities: BUYER,
  })
  ok('a buyer sees unit cost', out.includes('R19.99'), out)
}
{
  const out = renderTemplate('{#each lines}<td>{line.unitCostExcl}</td>{/each}', 'purchase_order', {
    values, sections: { lines: rows }, capabilities: JUNIOR,
  })
  ok('a junior gets the SAME template with cost blank, not an error', out === '<td></td><td></td>', out)
}
{
  const out = renderTemplate('<p>{totals.totalIncl}</p>', 'purchase_order', {
    values, sections: {}, capabilities: OWNER,
  })
  ok('money is formatted, never raw', out === '<p>R1 234.50</p>', out)
}
{
  const out = renderTemplate('{#each lines}<td>{line.qty}</td>{/each}', 'purchase_order', {
    values, sections: { lines: rows }, capabilities: OWNER,
  })
  ok('quantity keeps weighed decimals and drops whole-unit ones', out === '<td>3</td><td>1.5</td>', out)
}
{
  const out = renderTemplate('{#each lines}<td>x</td>{/each}', 'purchase_order', {
    values, sections: { lines: [] }, capabilities: OWNER,
  })
  ok('a section over zero rows renders nothing', out === '', out)
}
{
  const out = renderTemplate('<p>{doc.nonsense}</p>', 'purchase_order', {
    values, sections: {}, capabilities: OWNER,
  })
  ok('an unknown token prints empty, not braces', out === '<p></p>', out)
}
{
  const out = renderTemplate('<p>{doc.reference}</p>', 'purchase_order', {
    values: {}, sections: {}, capabilities: OWNER,
  })
  ok('an absent value is blank, not "undefined" or "0"', out === '<p></p>', out)
}
{
  // The second half of the trust model: the template was clean, the DATA is not.
  const hostile = { 'supplier.name': '<img src=x onerror=alert(1)>' }
  const out = renderTemplate('<p>{supplier.name}</p>', 'purchase_order', {
    values: hostile, sections: {}, capabilities: OWNER,
  })
  ok('hostile DATA is escaped, not rendered', !/<img/.test(out) && out.includes('&lt;img'), out)
}
{
  const out = renderTemplate('<p>{site.address}</p>', 'purchase_order', {
    values, sections: {}, capabilities: OWNER,
  })
  ok('multiline keeps its breaks', out === '<p>Unit 4<br>Industrial Park</p>', out)
}
{
  const out = renderTemplate('<p>{site.address}</p>', 'purchase_order', {
    values: { 'site.address': 'a\n<script>x</script>' }, sections: {}, capabilities: OWNER,
  })
  ok('multiline escapes before breaking lines', !/<script/.test(out), out)
}
{
  ok('escapeHtml covers quotes', escapeHtml(`"'`) === '&quot;&#39;')
  ok('percent of zero is blank, not "0%"', formatValue(0, 'percent') === '')
}

/* ── the one unescaped format ────────────────────────────────────────────── */
{
  // `markup` exists for exactly one token, whose value the SERVER composes.
  // These prove it cannot become a general-purpose hole.
  const realLogo = '<img src="/api/document-logo?v=abc-123.png" alt="" style="max-height:56px;width:auto">'
  ok('the composed logo tag survives', formatValue(realLogo, 'markup') === realLogo)

  ok('a script tag in a markup value is refused',
    formatValue('<script>alert(1)</script>', 'markup') === '')
  ok('an off-site image in a markup value is refused',
    formatValue('<img src="https://evil.example/x.gif">', 'markup') === '')
  ok('an onerror on the right-looking src is refused',
    formatValue('<img src="/api/document-logo?v=a.png" onerror="alert(1)">', 'markup') === '')
  ok('a second tag appended to a valid one is refused',
    formatValue(realLogo + '<script>x</script>', 'markup') === '')
  ok('plain user text in a markup value is refused',
    formatValue('Acme Trading', 'markup') === '')

  // And end to end: a hostile value on the real token prints nothing.
  const out = renderTemplate('<header>{site.logo}</header>', 'purchase_order', {
    values: { 'site.logo': '<img src=x onerror=alert(1)>' },
    sections: {},
    capabilities: OWNER,
  })
  ok('a hostile site.logo renders empty, not raw', out === '<header></header>', out)
}

/* ── catalog ─────────────────────────────────────────────────────────────── */

console.log('\n-- catalog --')
{
  const po = getDocType('purchase_order')!
  ok('purchase order exists in the catalog', !!po)
  const junior = tokensFor(po, JUNIOR).map((t) => t.key)
  const buyer = tokensFor(po, BUYER).map((t) => t.key)
  ok('a junior is not offered cost tokens', !junior.includes('line.unitCostExcl'))
  ok('a buyer is offered cost tokens', buyer.includes('line.unitCostExcl'))
  ok('an owner is offered everything', tokensFor(po, OWNER).length === allTokens(po).length)
  ok('no received/landed-cost token is exposed to a supplier document',
    !allTokens(po).some((t) => /received|landed|arrived|outstanding/i.test(t.key)))
  ok('every token key is unique', new Set(allTokens(po).map((t) => t.key)).size === allTokens(po).length)
}

/* ── the shipped default ─────────────────────────────────────────────────── */

console.log('\n-- shipped default --')
{
  const r = validateTemplate('purchase_order', PURCHASE_ORDER_DEFAULT)
  ok('the default purchase order validates', r.ok, JSON.stringify(r.errors))

  /*
   * The default must survive its own sanitiser with nothing load-bearing lost.
   * A default needing a privileged path would mean the language cannot express
   * the document it ships, and every custom template would inherit that limit.
   *
   * NOT asserted byte-for-byte: the sanitiser strips CSS comments on purpose
   * (a comment can hide a payload from a reader that a parser still sees), and
   * this template is commented. What matters is that every RULE survives.
   */
  const cleaned = sanitiseTemplate(PURCHASE_ORDER_DEFAULT)
  ok('the default keeps its markup through the sanitiser',
    cleaned.includes('<article') && cleaned.includes('{#each lines}') && cleaned.includes('{/each}'),
    cleaned.slice(0, 80))
  ok('the default keeps its :has() rules through the sanitiser',
    cleaned.includes('.po-row:has(dd:empty)') && cleaned.includes('.po-block:has(> p.po-value:empty)'),
    cleaned.slice(0, 160))
  ok('every token in the default is one the catalog knows',
    !validateTemplate('purchase_order', cleaned).errors.some((e) => e.kind === 'unknown-token'))

  ok('resolve falls back to the default when a site has none',
    resolveTemplate('purchase_order', null).source === 'default')
  ok('resolve uses a valid custom template',
    resolveTemplate('purchase_order', GOOD_PO).source === 'custom')

  // A template missing a legally/commercially required field must not print.
  const noNumber = '<h1>{site.name}</h1><p>{supplier.name}</p>'
  const fell = resolveTemplate('purchase_order', noNumber)
  ok('resolve refuses a template missing a required field', fell.source === 'default')
  ok('...and says why, so the setup screen can show it', !!fell.rejected, fell.rejected)

  // A stale-but-harmless token must NOT cost someone their whole design.
  const stale = GOOD_PO + '<p>{doc.somethingRemoved}</p>'
  ok('resolve keeps a design that merely names an unknown token',
    resolveTemplate('purchase_order', stale).source === 'custom')
}

console.log(`\n${fails === 0 ? 'All stationery checks passed.' : `${fails} FAILED`}`)
process.exit(fails === 0 ? 0 : 1)
