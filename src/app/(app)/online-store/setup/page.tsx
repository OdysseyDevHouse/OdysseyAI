import { requireModuleCapability } from '@/lib/auth'
import { has } from '@/lib/control/modules'
import { can } from '@/lib/site/permissions'
import {
  getOnlineSettings,
  getPublishCounts,
  listDeliveryZones,
} from '@/lib/site/onlineStore'
import { groupForSite, membersOfGroup } from '@/lib/storeGroups'
import { branchPinsFor } from '@/lib/control/storeBranches'
import { createPublicStoreToken } from '@/lib/publicStoreToken'
import { PageHeader, PageBody } from '@/components/ui'
import SetupForm from './SetupForm'
import GroupStorefront from './GroupStorefront'

/**
 * Online store — Setup.
 *
 * What the shop sells online, how customers get their order, and the link to
 * share. The store is CLOSED until every check on this screen passes, which is
 * what keeps a half-configured storefront from ever being public.
 *
 * A chain also decides HERE whether its branches run one shop between them, on
 * the reasoning that this is the screen somebody opens to ask what their shop is
 * to a shopper. Setup → Linked stores is where the group is built — which stores
 * are in it, who owns the product file — and that is a different question,
 * settled once and usually by a different person.
 */

export const dynamic = 'force-dynamic'

export default async function OnlineStoreSetupPage() {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId, capabilities, modules } = await requireModuleCapability(
    'online_store',
    'online.edit',
  )

  /*
   * The group card is asked for separately, and softly.
   *
   * `online.edit` gets somebody this page; it does not get them the group. One
   * storefront for ten branches is a group-level decision, so it keeps the guard
   * it had on Linked stores — `multi_branch` plus `setup.edit` — and a manager
   * who may configure their own branch's shop simply does not see the card. The
   * actions check the same pair again, because hiding a card is not a boundary.
   */
  const mayEditGroup = has(modules, 'multi_branch') && can(capabilities, 'setup.edit')

  const [settings, counts, zones, token, group] = await Promise.all([
    getOnlineSettings(siteId),
    getPublishCounts(siteId),
    listDeliveryZones(siteId),
    // Deterministic, so the link printed on a slip last month still resolves.
    createPublicStoreToken(siteId),
    mayEditGroup ? groupForSite(siteId) : null,
  ])

  const members = group ? await membersOfGroup(group.id) : []
  // One control-database query for every branch's pin, rather than opening each
  // store's own database — the whole reason cp2_store_branches exists.
  const pins = members.length ? await branchPinsFor(members.map((m) => m.siteId)) : []
  const primary = members.find((m) => m.siteId === group?.primarySiteId) ?? null

  return (
    <>
      <PageHeader
        title="Online store"
        subtitle="Let customers order from you online, for collection or delivery"
      />
      <PageBody>
        <SetupForm
          settings={settings}
          counts={counts}
          zones={zones}
          storePath={`/store/${token}`}
          /* Above the Save button, not after it: everything else on this screen
             saves on that one button and this card saves a row at a time. */
          groupCard={
            group ? (
              <GroupStorefront
                enabled={group.onlineGroupMode}
                primaryName={primary?.displayName ?? null}
                branches={pins.map((p) => ({
                  siteId: p.siteId,
                  displayName: p.displayName,
                  latitude: p.latitude,
                  longitude: p.longitude,
                  acceptsOnline: p.acceptsOnline,
                  // Serialised here: a Date crossing into a client component
                  // arrives as a string anyway, so the boundary is made
                  // explicit rather than left to chance.
                  syncedAt: p.syncedAt ? p.syncedAt.toISOString() : null,
                }))}
                members={members}
              />
            ) : null
          }
        />
      </PageBody>
    </>
  )
}
