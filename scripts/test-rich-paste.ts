/**
 * Pasting formatted writing into the page builder.
 *
 *   npm run test:rich-paste
 *
 * ── WHY ITS OWN SUITE ────────────────────────────────────────────────────
 *
 * test-builder.ts needs a database and asserts the MODEL. This asserts the
 * CONVERTER, which needs no database at all — so it is its own suite and runs
 * in a couple of seconds.
 *
 * ── IT RUNS IN A REAL BROWSER, AND THAT IS THE POINT ─────────────────────
 *
 * The walk takes an abstract tree precisely so it COULD be tested against
 * hand-built objects. It is not, because the interesting half of this feature
 * is what `DOMParser` does to real clipboard markup before the walk ever sees
 * it — unclosed tags, Word's `<o:p>`, `&nbsp;`, the lot. Asserting against a
 * tree we built ourselves would prove the walk handles trees we can imagine.
 *
 * Chrome is already a dependency of test-builder-ui.mjs, so this adds nothing.
 *
 * ── THE PAYLOADS ARE REAL ────────────────────────────────────────────────
 *
 * Word, Google Docs and a plain web page all produce markup that looks nothing
 * like the tidy examples a hand-written test would use — a wrapper that means
 * "not bold", weights as numbers, alignment on the paragraph and colour on a
 * span inside it. Testing against invented HTML would prove the walk handles
 * HTML nobody pastes.
 */
import { chromium } from 'playwright'
import { blocksFromPastedTree, blocksFromPastedText } from '../src/lib/richTextPaste'
import { MAX_RICH_BLOCKS, richBlockText, type RichBlock } from '../src/lib/storefrontModel'

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

const textOf = (blocks: RichBlock[]) => blocks.map(richBlockText).join(' | ')

/**
 * A clipboard payload, parsed by Chrome and flattened into plain objects.
 *
 * The walk reads only a handful of node properties — see `PastedNode` — so the
 * tree can cross the browser boundary as JSON. That is what lets the CONVERTER
 * run here in Node, under the debugger and against the real types, while the
 * PARSE happens in a real browser on real markup. Rebuilding the tree in the
 * page and running the walk there would test a copy of the code shipped
 * through `page.evaluate`, which is not the code that runs in the app.
 */
type Snapshot = {
  nodeType: number
  tagName?: string
  textContent?: string | null
  childNodes?: Snapshot[]
  style?: { fontWeight?: string; fontStyle?: string; textAlign?: string }
  href?: string | null
}

/** Re-attach the one method the walk calls, so a snapshot satisfies PastedNode. */
function revive(node: Snapshot): Parameters<typeof blocksFromPastedTree>[0] {
  return {
    ...node,
    childNodes: (node.childNodes ?? []).map(revive),
    getAttribute: (name: string) => (name === 'href' ? (node.href ?? null) : null),
  }
}

async function main() {
  const browser = await chromium.launch({ channel: 'chrome' })
  const page = await browser.newPage()

  /*
   * Parse a fragment in Chrome exactly as `parsePastedHtml` does.
   *
   * The page body is written as a STRING and evaluated, rather than passed as
   * a function: tsx compiles this file with esbuild, which rewrites nested
   * functions to reference a `__name` helper that does not exist inside the
   * browser. A string crosses untouched.
   */
  const SNAPSHOT_JS = `((markup) => {
    const doc = new DOMParser().parseFromString(markup, 'text/html')
    const snap = (n) => ({
      nodeType: n.nodeType,
      tagName: n.tagName,
      // Only text nodes need their text; an element's would duplicate every
      // descendant's words on the way down.
      textContent: n.nodeType === 3 ? n.textContent : null,
      childNodes: Array.prototype.slice.call(n.childNodes).map(snap),
      style: n.style
        ? { fontWeight: n.style.fontWeight, fontStyle: n.style.fontStyle, textAlign: n.style.textAlign }
        : undefined,
      href: n.getAttribute ? n.getAttribute('href') : null,
    })
    return snap(doc.body)
  })`

  const parse = async (html: string) =>
    revive((await page.evaluate(`${SNAPSHOT_JS}(${JSON.stringify(html)})`)) as Snapshot)

  console.log('— Google Docs —')

  /*
   * Captured from a real Google Docs copy. The two traps are both here:
   *
   *   1. Everything is wrapped in <b style="font-weight:normal">. Reading <b>
   *      as bold would bold the whole document.
   *   2. Real bold is font-weight:700 on a <span>, which no tag check sees.
   */
  const gdocs = await parse(
    `<meta charset="utf-8"><b style="font-weight:normal" id="docs-internal-guid-x">` +
      `<h2 dir="ltr" style="line-height:1.38;text-align:center;"><span style="font-size:16pt;color:#1155cc;"><span>Holiday hours</span></span></h2>` +
      `<p dir="ltr" style="line-height:1.38;"><span style="font-weight:400;">Call us on </span>` +
      `<span style="font-weight:700;">021 555 0000</span><span style="font-weight:400;"> or </span>` +
      `<a href="https://example.com"><span style="font-weight:400;">email us</span></a></p>` +
      `<ul><li dir="ltr"><span style="font-weight:400;">Closed 25th</span></li>` +
      `<li dir="ltr"><span style="font-weight:400;">Half day 24th</span></li></ul></b>`,
  )
  const docs = blocksFromPastedTree(gdocs).blocks

  ok('a Docs paste produces one block per paragraph', docs.length === 4, textOf(docs))
  ok('the heading survives as a heading', docs[0]?.type === 'h2', docs[0]?.type)
  ok('and keeps its centring', docs[0]?.align === 'center', String(docs[0]?.align))
  ok(
    'the wrapper <b> does NOT bold the document',
    docs[0]?.spans.every((s) => !s.bold),
    JSON.stringify(docs[0]?.spans),
  )
  ok(
    'a weight of 700 IS bold',
    docs[1]?.spans.some((s) => s.bold && s.text.includes('021 555 0000')),
    JSON.stringify(docs[1]?.spans),
  )
  ok(
    'and the words around it are not',
    docs[1]?.spans.some((s) => !s.bold && s.text.includes('Call us on')),
  )
  ok('the spacing between spans survives', richBlockText(docs[1]) === 'Call us on 021 555 0000 or email us', richBlockText(docs[1]))
  /*
   * `startsWith` rather than equality: reading href off a parsed <a> gives the
   * browser's RESOLVED url, so "https://example.com" comes back with the
   * trailing slash it always had. That is the real value a paste produces and
   * the one that gets stored, so it is the one asserted.
   */
  ok(
    'the link is kept',
    docs[1]?.spans.some((s) => (s.href ?? '').startsWith('https://example.com')),
    JSON.stringify(docs[1]?.spans.map((s) => s.href)),
  )
  ok('list items become list blocks', docs[2]?.type === 'ul' && docs[3]?.type === 'ul')
  ok('and there is one block per item', richBlockText(docs[2]) === 'Closed 25th')

  console.log('\n— Microsoft Word —')

  /*
   * Word emits <o:p>, mso-* styles and class names, and marks bold with <b>
   * rather than a weight. It also wraps paragraphs in <div class=WordSection1>.
   */
  const word = await parse(
    `<div class=WordSection1>` +
      `<p class=MsoNormal style='text-align:center'><b><span style='font-size:14.0pt'>Our story</span></b><o:p></o:p></p>` +
      `<p class=MsoNormal>We have been baking since <b>1994</b>.<o:p></o:p></p>` +
      `<p class=MsoListParagraph style='mso-list:l0 level1 lfo1'><span style='mso-list:Ignore'>·<span style='font:7.0pt "Times New Roman"'>&nbsp;&nbsp;</span></span>Sourdough</p>` +
      `</div>`,
  )
  const w = blocksFromPastedTree(word).blocks

  ok('a Word paste keeps its paragraphs', w.length >= 3, textOf(w))
  ok('Word bold via <b> is bold', w[0]?.spans.some((s) => s.bold && s.text.includes('Our story')), JSON.stringify(w[0]?.spans))
  ok('and centring on the paragraph survives', w[0]?.align === 'center', String(w[0]?.align))
  ok('bold mid-sentence is bold', w[1]?.spans.some((s) => s.bold && s.text.includes('1994')))
  ok('and the rest of the sentence is not', w[1]?.spans.some((s) => !s.bold && s.text.includes('We have been baking')))
  ok('<o:p> contributes nothing visible', !textOf(w).includes('o:p'))

  console.log('\n— An ordinary web page —')

  const web = await parse(
    `<article><h1>Delivery</h1><p>We deliver on <em>Tuesdays</em> and <strong>Fridays</strong>.</p>` +
      `<ol><li>Order by 5pm</li><li>We call to confirm</li></ol>` +
      `<p style="text-align:right"><a href="/delivery">Read more</a></p></article>`,
  )
  const web1 = blocksFromPastedTree(web).blocks

  ok('h1 becomes the big heading', web1[0]?.type === 'h2', web1[0]?.type)
  ok('<em> is italic', web1[1]?.spans.some((s) => s.italic && s.text.includes('Tuesdays')))
  ok('<strong> is bold', web1[1]?.spans.some((s) => s.bold && s.text.includes('Fridays')))
  ok('a numbered list stays numbered', web1[2]?.type === 'ol', web1[2]?.type)
  ok('right alignment survives', web1[4]?.align === 'right', String(web1[4]?.align))
  ok('an in-shop link is kept', web1[4]?.spans.some((s) => s.href === '/delivery'), JSON.stringify(web1[4]?.spans))

  console.log('\n— Nothing pasted can produce markup —')

  /*
   * The property that makes this safe to have at all. A converter has no
   * allowlist to get wrong: an element it does not understand contributes its
   * TEXT, and a script contributes nothing.
   */
  const hostile = await parse(
    `<p onclick="alert(1)">Hello <script>alert(1)</script><style>body{display:none}</style>` +
      `<img src=x onerror="alert(1)"> world</p>` +
      `<p><a href="javascript:alert(1)">click me</a></p>` +
      `<p><a href="https://ok.example">fine</a></p>`,
  )
  const h = blocksFromPastedTree(hostile).blocks
  const allSpans = h.flatMap((b) => b.spans)

  ok('script content is dropped entirely', !textOf(h).includes('alert'), textOf(h))
  ok('style content is dropped entirely', !textOf(h).includes('display:none'))
  ok('the surrounding words survive', richBlockText(h[0]).includes('Hello') && richBlockText(h[0]).includes('world'))
  ok('a javascript: link never survives', allSpans.every((s) => !(s.href ?? '').toLowerCase().includes('javascript')), JSON.stringify(allSpans.map((s) => s.href)))
  ok('a real link alongside it does', allSpans.some((s) => (s.href ?? '').startsWith('https://ok.example')))
  ok(
    'no span carries anything but text and flags',
    allSpans.every((s) => Object.keys(s).every((k) => ['text', 'bold', 'italic', 'href', 'colour'].includes(k))),
  )

  console.log('\n— Colour is deliberately not carried —')
  const coloured = blocksFromPastedTree(
    await parse(`<p><span style="color:#1155cc">Blue words</span></p>`),
  ).blocks
  ok(
    'a pasted colour value does not become a colour',
    coloured[0]?.spans.every((s) => (s.colour ?? 'default') === 'default'),
    JSON.stringify(coloured[0]?.spans),
  )

  console.log('\n— Long pastes say what was left out —')

  const long = await parse(Array.from({ length: 90 }, (_, i) => `<p>Line ${i + 1}</p>`).join(''))
  const capped = blocksFromPastedTree(long)
  ok('the block cap holds', capped.blocks.length === MAX_RICH_BLOCKS, `${capped.blocks.length}`)
  ok('and what did not fit is COUNTED, not silently dropped', capped.dropped === 90 - MAX_RICH_BLOCKS, `${capped.dropped}`)

  console.log('\n— Plain text —')

  const plain = blocksFromPastedText('One\n\nTwo\r\nThree   \n')
  ok('each line becomes a paragraph', plain.blocks.length === 3, textOf(plain.blocks))
  ok('blank lines are not paragraphs', textOf(plain.blocks) === 'One | Two | Three')
  ok('nothing is dropped when it fits', plain.dropped === 0)

  console.log('\n— Whitespace —')

  const spaced = blocksFromPastedTree(
    await parse(`<p>\n   Lots   of\n   space   </p><p></p><p>   </p><p>after</p>`),
  ).blocks
  ok('runs of whitespace collapse', richBlockText(spaced[0]) === 'Lots of space', JSON.stringify(richBlockText(spaced[0])))
  ok('empty paragraphs are not blocks', spaced.length === 2, textOf(spaced))

  const br = blocksFromPastedTree(await parse(`<p>first<br>second</p>`)).blocks
  ok('a <br> starts a new block', br.length === 2, textOf(br))

  await browser.close()

  console.log(`\n${fails === 0 ? 'All rich-paste checks passed.' : `${fails} FAILED.`}`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
