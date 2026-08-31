import { redirect } from 'next/navigation'
import { requireSiteUser } from '@/lib/auth'
import { can } from '@/lib/site/permissions'
import { menuHolder } from '@/lib/site/menuVisibility'
import { PageHeader, PageBody } from '@/components/ui'
import HubView from '@/components/HubView'
import { accountingGroupsFor } from './catalogue'

export const dynamic = 'force-dynamic'

/**
 * The accounting centre.
 *
 * /accounting had no landing page at all — the sidebar group was the only way
 * in, and it was thirteen rows of names that said nothing about what any of
 * them decided. This is the same move Setup made: everything in one place,
 * grouped by the job it does, searchable by what it answers rather than what it
 * is called.
 *
 * Gated on the weakest capability any tile requires, so anyone who can see one
 * screen gets in and the catalogue drops the rest. Filtering happens HERE rather
 * than in the browser, so a screen somebody may not open is never sent to them.
 *
 * `?q=` seeds the search: the sidebar hands its term over when a screen below
 * this one matches, so that search carries on here instead of starting again.
 */
export default async function AccountingPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>
}) {
  const { site, capabilities, modules } = await requireSiteUser()
  const allow = (c: string) => can(capabilities, c as Parameters<typeof can>[1])

  /* Held AND not switched off under Setup → Menu & modules. A shop whose
     bookkeeper runs the ledger elsewhere hides Accounting and is left with the
     cashbook, expenses and the VAT return — which are base-package tiles and
     carry no module, so the hub keeps working rather than emptying. */
  const holds = await menuHolder(site.id, modules)

  // A hidden menu entry is not a boundary — this URL is typeable.
  const groups = accountingGroupsFor(allow, holds)
  if (groups.length === 0) redirect('/not-allowed')

  const { q } = await searchParams

  return (
    <>
      <PageHeader
        title="Accounting"
        subtitle="What the business made, what it is owed, and where the cash went"
      />
      <PageBody>
        <HubView
          groups={groups}
          noun="accounts"
          emptyHint="Your role does not include access to any accounting screen. An owner can grant this under Roles & permissions."
          initialSearch={q ?? ''}
        />
      </PageBody>
    </>
  )
}
