/**
 * Stationery templates against a real database.
 *
 *   npm run test:stationery-store
 *
 * test-stationery.ts asserts the pure half — catalog, sanitiser, validator,
 * renderer — and needs nothing. This asserts the half that cannot be proved
 * without a database: that a hostile template is cleaned ON THE WAY IN, that
 * exactly one template per document type is active however many are saved, and
 * that a print path reading this table degrades rather than throws.
 *
 * ── IT CLEANS UP AFTER ITSELF ────────────────────────────────────────────
 *
 * Every row it writes carries the marker below and is deleted at the end, pass
 * or fail. A leaked template would be worse than ordinary test litter: an
 * active one changes what a real purchase order looks like.
 */
import {
  saveTemplate,
  setActive,
  listTemplates,
  getTemplate,
  activeTemplateBody,
  activeTemplate,
  resetToDefault,
  deleteTemplate,
  discardDraft,
} from '../src/lib/site/stationeryTemplates'
import { siteExecute, siteQueryOne } from '../src/lib/siteDb'
import { PURCHASE_ORDER_DEFAULT } from '../src/lib/stationery/defaults/purchaseOrder'
import { PURCHASE_ORDER_BLOCKS } from '../src/lib/stationery/defaults/purchaseOrderBlocks'
import { serialiseSpec, type DocumentSpec } from '../src/lib/stationery/blocks'
import { resolveTemplate } from '../src/lib/stationery/resolve'
import type { RowDataPacket } from 'mysql2'

const SITE = Number(process.env.TEST_SITE_ID || 1)
const MARK = 'ZZTEST-STATIONERY'
const ACTOR = { userId: 1, userName: 'Test Runner' }

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

const GOOD =
  '<h1>{site.name}</h1><p>{doc.number}</p><p>{supplier.name}</p>' +
  '<table>{#each lines}<tr><td>{line.description}</td></tr>{/each}</table>'

async function cleanup() {
  await siteExecute(SITE, 'DELETE FROM stationery_templates WHERE name LIKE ?', [`${MARK}%`])
}

async function main() {
  await cleanup()

  /* ── save: the sanitiser runs on the way in ───────────────────────────── */

  const hostile =
    GOOD + '<script>alert(1)</script><img src="https://evil.example/x.gif" onerror="alert(2)">'
  const saved = await saveTemplate(
    SITE,
    { docType: 'purchase_order', name: `${MARK} hostile`, body: hostile },
    ACTOR,
  )
  ok('a template with a script in it still saves', saved.ok, JSON.stringify(saved))

  if (saved.ok) {
    const row = await getTemplate(SITE, saved.id)
    // Matched as a TAG, not as the substring "script" — {line.description}
    // legitimately contains it, and a naive /script/ here reported a working
    // sanitiser as broken.
    ok('...but the script is not what got stored',
      !!row && !/<\s*script/i.test(row.body) && !/alert\s*\(/i.test(row.body))
    ok('...nor the off-site image', !!row && !/evil\.example/.test(row!.body))
    ok('...nor the event handler', !!row && !/onerror/i.test(row!.body))
    ok('...and the legitimate markup survived', !!row && row!.body.includes('{#each lines}'))
  }

  /* ── save: validation blocks a document that would be wrong ───────────── */

  const noNumber = await saveTemplate(
    SITE,
    { docType: 'purchase_order', name: `${MARK} bad`, body: '<h1>{site.name}</h1>' },
    ACTOR,
  )
  ok('a template missing a required field is refused', !noNumber.ok, JSON.stringify(noNumber))
  ok('...with a message naming what is missing',
    !noNumber.ok && /document number/i.test(noNumber.error), !noNumber.ok ? noNumber.error : '')

  const emptied = await saveTemplate(
    SITE,
    // Everything here is stripped, so the result is an empty template.
    { docType: 'purchase_order', name: `${MARK} empty`, body: '<script>x</script>' },
    ACTOR,
  )
  ok('a template that sanitises to nothing is refused', !emptied.ok, JSON.stringify(emptied))

  const badType = await saveTemplate(
    SITE,
    { docType: 'not_a_document', name: `${MARK} type`, body: GOOD },
    ACTOR,
  )
  ok('an unknown document type is refused', !badType.ok)

  /* ── the print path ───────────────────────────────────────────────────── */

  ok('with nothing active, the print path gets null',
    (await activeTemplateBody(SITE, 'purchase_order')) === null)

  const a = await saveTemplate(
    SITE, { docType: 'purchase_order', name: `${MARK} A`, body: GOOD }, ACTOR,
  )
  const b = await saveTemplate(
    SITE, { docType: 'purchase_order', name: `${MARK} B`, body: PURCHASE_ORDER_DEFAULT }, ACTOR,
  )
  ok('two templates save for one document type', a.ok && b.ok)

  if (a.ok && b.ok) {
    await setActive(SITE, a.id)
    const afterA = await activeTemplateBody(SITE, 'purchase_order')
    ok('the active template is what the print path reads', afterA === (await getTemplate(SITE, a.id))!.body)

    // The invariant that matters: activating one deactivates the rest.
    await setActive(SITE, b.id)
    const actives = (await listTemplates(SITE, 'purchase_order')).filter((t) => t.isActive)
    ok('exactly one template is active after switching', actives.length === 1, `${actives.length}`)
    ok('...and it is the one just activated', actives[0]?.id === b.id)

    /* ── draft and publish ─────────────────────────────────────────────── */

    const draft = GOOD + '<p>{doc.reference}</p>'
    await saveTemplate(
      SITE, { docType: 'purchase_order', name: `${MARK} A`, body: draft, asDraft: true }, ACTOR, a.id,
    )
    const withDraft = await getTemplate(SITE, a.id)
    ok('a draft is stored without changing what prints',
      withDraft?.draftBody?.includes('{doc.reference}') === true &&
      withDraft?.body.includes('{doc.reference}') === false)

    await discardDraft(SITE, a.id)
    ok('discarding a draft leaves the published body alone',
      (await getTemplate(SITE, a.id))?.draftBody === null)

    await saveTemplate(
      SITE, { docType: 'purchase_order', name: `${MARK} A`, body: draft }, ACTOR, a.id,
    )
    const published = await getTemplate(SITE, a.id)
    ok('publishing replaces the body and clears the draft',
      published?.body.includes('{doc.reference}') === true && published?.draftBody === null)

    /* ── reset ─────────────────────────────────────────────────────────── */

    await resetToDefault(SITE, 'purchase_order')
    ok('reset to default stops any custom template printing',
      (await activeTemplateBody(SITE, 'purchase_order')) === null)
    ok('...but does not destroy the work',
      (await listTemplates(SITE, 'purchase_order')).length >= 2)

    /* ── an unlawful template cannot be switched on ────────────────────── */

    // Written straight past saveTemplate, to simulate a row stored before a
    // field became required — the exact case resolve.ts exists for.
    await siteExecute(
      SITE,
      `INSERT INTO stationery_templates (doc_type, name, format, body, is_active)
       VALUES ('purchase_order', ?, 'html', ?, 0)`,
      [`${MARK} stale`, '<h1>{site.name}</h1>'],
    )
    const stale = await siteQueryOne<RowDataPacket>(
      SITE, 'SELECT id FROM stationery_templates WHERE name = ?', [`${MARK} stale`],
    )
    const staleId = Number((stale as Record<string, unknown>).id)
    const activated = await setActive(SITE, staleId)
    ok('a stored template missing a required field cannot be activated', !activated.ok,
      JSON.stringify(activated))

    await deleteTemplate(SITE, a.id)
    ok('a template can be deleted', (await getTemplate(SITE, a.id)) === null)

    /* ── a block design, end to end ─────────────────────────────────────── */

    /*
     * The visual designer stores JSON where the HTML editor stores markup, so
     * every step between save and paper has to know the difference. This is the
     * whole path: saved, stored as a spec, activated, read back with its format,
     * and compiled to the markup the print route renders.
     */
    const designed: DocumentSpec = {
      version: 1,
      blocks: PURCHASE_ORDER_BLOCKS.blocks.map((bl) =>
        bl.kind === 'lineTable'
          ? {
              ...bl,
              columns: bl
                .columns!.filter((c) => c.token !== 'line.unitCostExcl')
                .map((c) => (c.token === 'line.totalExcl' ? { ...c, heading: 'Amount' } : c)),
            }
          : bl,
      ),
    }

    const blocksSaved = await saveTemplate(
      SITE,
      {
        docType: 'purchase_order',
        name: `${MARK} blocks`,
        body: serialiseSpec(designed),
        format: 'blocks',
      },
      ACTOR,
    )
    ok('a block design saves', blocksSaved.ok, JSON.stringify(blocksSaved))

    if (blocksSaved.ok) {
      const stored = await getTemplate(SITE, blocksSaved.id)
      ok('...stored as a spec, not mangled through the markup sanitiser',
        stored?.format === 'blocks' && stored.body.startsWith('{'))

      const activated = await setActive(SITE, blocksSaved.id)
      ok('...and can be made the one that prints', activated.ok, JSON.stringify(activated))

      const active = await activeTemplate(SITE, 'purchase_order')
      ok('the print path reads its format back', active?.format === 'blocks')

      const resolved = resolveTemplate('purchase_order', active?.body ?? null, active?.format)
      ok('...and resolves it as the site’s own design',
        resolved.source === 'custom', resolved.rejected ?? '')
      ok('...compiled to markup, not served as JSON', resolved.body.includes('<article'))
      ok('the column removed in the designer is not in what prints',
        !resolved.body.includes('line.unitCostExcl'))
      ok('the renamed heading is', resolved.body.includes('Amount'))

      // A body that is not a readable spec must fall back rather than print
      // JSON at a supplier — written past saveTemplate to simulate a row from
      // a later version this build cannot read.
      const broken = resolveTemplate('purchase_order', '{"version":1,"blocks":"not-an-array"}', 'blocks')
      ok('an unreadable spec falls back to the shipped design', broken.source === 'default')
    }
  }
}

main()
  .catch((e) => {
    fails++
    console.error('**FAIL**  threw:', e?.message ?? e)
  })
  .finally(async () => {
    await cleanup().catch(() => {})
    const left = await siteQueryOne<RowDataPacket>(
      SITE, 'SELECT COUNT(*) AS n FROM stationery_templates WHERE name LIKE ?', [`${MARK}%`],
    ).catch(() => null)
    const n = left ? Number((left as Record<string, unknown>).n) : -1
    ok('the suite left no rows behind', n === 0, `${n}`)
    console.log(`\n${fails === 0 ? 'All stationery-store checks passed.' : `${fails} FAILED`}`)
    process.exit(fails === 0 ? 0 : 1)
  })
