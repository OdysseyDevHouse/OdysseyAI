import { requireCapability, requireSite } from '@/lib/auth'
import { PageHeader, PageBody } from '@/components/ui'
import { listTemplates } from '@/lib/site/stationeryTemplates'
import { DOC_TYPES, getDocType, tokensFor } from '@/lib/stationery/catalog'
import { DEFAULT_TEMPLATES, DEFAULT_SPECS } from '@/lib/stationery/resolve'
import { serialiseSpec } from '@/lib/stationery/blocks'
import { supportsBlocks } from '@/lib/stationery/compile'
import { logoFileName } from '@/lib/site/documentLogo'
import StationeryClient from './StationeryClient'

export const dynamic = 'force-dynamic'

/**
 * Stationery — how this shop's printed documents are laid out.
 *
 * Sits beside Setup → Printing, which owns the other half of the same subject:
 * printing owns the MACHINE (which thermal printer, how many columns) and this
 * owns the DOCUMENT (what is on the page).
 *
 * ── WHY THE TOKEN LIST IS COMPUTED HERE ───────────────────────────────────
 *
 * `tokensFor` filters the catalog by the CALLER's capabilities, so a designer
 * without products.cost is never offered a cost token. Doing it on the server
 * means the browser never receives the names of fields this person may not
 * read — the list is not merely hidden, it is absent.
 */
export default async function StationerySetupPage() {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId, capabilities } = await requireCapability('setup.stationery')
  const site = await requireSite()

  const [templates, logoFile] = await Promise.all([listTemplates(siteId), logoFileName(siteId)])

  /*
   * The shipped default travels with the page so "Start from the standard
   * layout" needs no round trip, and so a shop can read what it is forking
   * before it forks it.
   */
  const docs = DOC_TYPES.map((d) => {
    const def = getDocType(d.key)!
    return {
      key: d.key,
      label: d.label,
      medium: d.medium,
      defaultBody: DEFAULT_TEMPLATES[d.key] ?? '',
      // Only where a block default exists; a document the visual editor cannot
      // express must not offer it, or a shop would switch and lose part of
      // their paperwork.
      defaultSpec:
        supportsBlocks(d.key) && DEFAULT_SPECS[d.key]
          ? serialiseSpec(DEFAULT_SPECS[d.key])
          : undefined,
      tokens: tokensFor(def, capabilities).map((t) => ({
        key: t.key,
        label: t.label,
        hint: t.hint ?? '',
        section: def.sections.find((s) => s.tokens.some((x) => x.key === t.key))?.key ?? null,
      })),
      sections: def.sections.map((s) => ({ key: s.key, label: s.label })),
    }
  })

  return (
    <>
      <PageHeader
        title="Stationery"
        subtitle="How your printed documents are laid out — your letterhead, your columns, your wording."
      />
      <PageBody>
        <StationeryClient
          siteName={site.displayName}
          logoFile={logoFile}
          docs={docs}
          templates={templates.map((t) => ({
            id: t.id,
            docType: t.docType,
            name: t.name,
            body: t.body,
            draftBody: t.draftBody,
            isActive: t.isActive,
            format: t.format,
          }))}
        />
      </PageBody>
    </>
  )
}
