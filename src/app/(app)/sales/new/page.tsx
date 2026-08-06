import { redirect } from 'next/navigation'
import { requireSiteUser } from '@/lib/auth'
import { listTerminals } from '@/lib/site/terminals'
import { listTenderTypes } from '@/lib/site/tenderTypes'
import { listSaved } from '@/lib/site/salesDocuments'
import { listPriceStructures } from '@/lib/site/lookups'
import { getNumericSetting } from '@/lib/site/settings'
import { can, capabilitiesForRole } from '@/lib/site/permissions'
import { getUser } from '@/lib/site/users'
import { getTillSession } from '@/lib/tillSession'
import { PageHeader } from '@/components/ui'
import TillScreen from './TillScreen'
import TillGate from './TillGate'

export const dynamic = 'force-dynamic'

export default async function NewSalePage() {
  const { site, capabilities } = await requireSiteUser()
  if (!can(capabilities, 'sales.till')) redirect('/not-allowed')

  // Who is at the keyboard, which is a different question from whose browser
  // session this is — see lib/tillSession.ts. Until somebody enters a PIN the
  // basket is not shown at all, so no sale can be rung up unattributed.
  const till = await getTillSession(site.id)
  if (!till) {
    return (
      <div className="flex h-full flex-col">
        <PageHeader title="New sale" subtitle={site.displayName} />
        <TillGate siteName={site.displayName} />
      </div>
    )
  }

  // The OPERATOR's permissions, not the browser session's. A manager signed in
  // to the back office who hands the till to a junior must not leave their own
  // discount rights behind on the screen.
  const operator = await getUser(site.id, till.userId)
  const operatorCapabilities = operator
    ? await capabilitiesForRole(site.id, operator.roleId)
    : capabilities

  const [terminals, tenders, saved, structures, cashRounding] = await Promise.all([
    listTerminals(site.id, false),
    listTenderTypes(site.id),
    listSaved(site.id),
    listPriceStructures(site.id),
    getNumericSetting(site.id, 'sales_cash_rounding'),
  ])

  // The default structure is the shelf price; fall back to the first if none is
  // flagged, which is what listProducts already assumes.
  const priceStructure = structures.find((s) => s.isDefault) ?? structures[0] ?? null

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="New sale" subtitle={`${site.displayName} · ${till.name}`} />
      <TillScreen
        terminals={terminals}
        tenders={tenders}
        priceStructureId={priceStructure?.id ?? null}
        savedCount={saved.length}
        cashRounding={cashRounding}
        canOverrideDiscount={can(operatorCapabilities, 'sales.discount_override')}
        operatorName={till.name}
      />
    </div>
  )
}
