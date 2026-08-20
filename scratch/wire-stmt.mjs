import fs from 'fs'

const p = 'src/lib/statements/pdf.ts'
let s = fs.readFileSync(p, 'utf8')

const old = `export function renderStatementPdf(
  data: StatementData,
  variant: StatementVariant = 'statement',
): Promise<Buffer> {
  return new Promise((resolve, reject) => {`

const nw = `/**
 * A statement, a supplier account or a remittance — from the site's own design
 * where it has one.
 *
 * ── THE DESIGN REACHES ALL THREE ──────────────────────────────────────────
 *
 * Passing a siteId resolves that site's active statement design and draws it
 * instead of the fixed layout below. One design serves all three variants,
 * because what differs between them arrives as tokens: {doc.heading} names the
 * paper, {totals.dueLabel} names the figure, and the age ladder simply has no
 * rows on a remittance so the table disappears.
 *
 * ── FAILURE FALLS BACK, IT DOES NOT THROW ─────────────────────────────────
 *
 * A statement that will not send because a template row is unreadable is a worse
 * failure than one that sends looking ordinary — and a statement run sends
 * hundreds at a time, so one bad template must not take the run down. Every step
 * of resolving the design is caught, and a miss lands on \`draw\`.
 *
 * Omitting the siteId keeps the old behaviour exactly, which is what makes this
 * safe to adopt one caller at a time.
 */
export async function renderStatementPdf(
  data: StatementData,
  variant: StatementVariant = 'statement',
  siteId?: number,
): Promise<Buffer> {
  if (siteId !== undefined) {
    const designed = await renderDesignedStatement(data, variant, siteId).catch(() => null)
    if (designed) return designed
  }

  return new Promise((resolve, reject) => {`

if (!s.includes(old)) throw new Error('entry point')
s = s.replace(old, nw)

// The designed path, mirroring the invoice's.
s = s.replace(
  `function draw(doc: PDFKit.PDFDocument, data: StatementData, variant: StatementVariant) {`,
  `/**
 * The site's design, drawn — or null to fall back.
 *
 * Null rather than a throw for anything that goes wrong: the caller is sending a
 * customer their statement, and the shipped layout is a perfectly good one. The
 * only thing that must not happen is no statement at all.
 */
async function renderDesignedStatement(
  data: StatementData,
  variant: StatementVariant,
  siteId: number,
): Promise<Buffer | null> {
  const { activeTemplate } = await import('../site/stationeryTemplates')
  const custom = await activeTemplate(siteId, 'statement').catch(() => null)

  /*
   * Only a BLOCK design can be drawn — there is no honest way to render
   * arbitrary HTML with pdfkit, so a site that chose the markup editor keeps the
   * hand-drawn layout. The setup screen says so.
   */
  const { parseSpec } = await import('../stationery/blocks')
  const { STATEMENT_BLOCKS } = await import('../stationery/defaults/statementBlocks')

  const spec =
    custom?.format === 'blocks' && custom.body
      ? parseSpec(custom.body, 'statement')
      : custom
        ? null
        : STATEMENT_BLOCKS

  if (!spec || spec.blocks.length === 0) return null

  const { statementTokens } = await import('../stationery/adapters/statement')
  const { renderSpecPdf } = await import('../stationery/pdf')
  const { readLogo } = await import('../site/documentLogo')

  /*
   * PNG or JPEG only, and under half a megabyte — pdfkit reads no other format
   * and stores a PNG's pixels uncompressed, so a large logo would be attached to
   * every statement in a run of hundreds. See lib/invoices/pdf.ts.
   */
  const MAX_LOGO_BYTES = 512 * 1024
  const found = await readLogo(siteId).catch(() => null)
  const logo =
    found &&
    (found.format === 'png' || found.format === 'jpeg') &&
    found.bytes.length <= MAX_LOGO_BYTES
      ? found
      : null

  const input = statementTokens(data, variant, {
    printedAt: data.generatedAt.toLocaleString('en-ZA', {
      dateStyle: 'short',
      timeStyle: 'short',
    }),
  })

  return renderSpecPdf(spec, 'statement', input, logo?.bytes ?? null)
}

function draw(doc: PDFKit.PDFDocument, data: StatementData, variant: StatementVariant) {`,
)

fs.writeFileSync(p, s)
console.log('statement pdf rewired')
