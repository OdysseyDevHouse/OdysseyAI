import { PageHeader } from '@/components/ui'
import { requireModuleCapability } from '@/lib/auth'
import { listDepartmentVisibility } from '@/lib/site/onlineStore'
import { listPages } from '@/lib/site/storefrontPages'
import { resolveMenu } from '@/lib/site/storefrontMenus'
import MenuClient, { type MenuChoice } from './MenuClient'

export const dynamic = 'force-dynamic'

/**
 * The shop's menu.
 *
 * ── THE GENERATED RAIL IS OFFERED, NOT IMPOSED ───────────────────────────
 *
 * A shop that has never made a menu sees the rail it already has, as a
 * starting point it can adopt in one click. That is the difference between a
 * feature an owner tries and one they abandon: the alternative is an empty
 * editor and a shop whose navigation they have to rebuild from memory before
 * it works again.
 *
 * Nothing is written until they press it. Until then `resolveMenu` returns
 * null and the shop keeps drawing what it always drew.
 */
export default async function MenuPage() {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireModuleCapability('online_store', 'online.edit')

  const [stored, departments, pages] = await Promise.all([
    resolveMenu(siteId, 'main'),
    listDepartmentVisibility(siteId),
    listPages(siteId),
  ])

  /*
   * What an owner can point an item at.
   *
   * Only PUBLISHED departments and pages: offering a target a shopper cannot
   * reach is offering a broken link, and the shop already has screens for
   * deciding what is published.
   */
  const choices: MenuChoice[] = [
    ...departments
      .filter((d) => d.showOnline)
      .map((d) => ({ kind: 'department' as const, id: d.id, label: d.name })),
    ...pages
      .filter((p) => p.isPublished && p.kind === 'standard' && p.slug)
      .map((p) => ({ kind: 'page' as const, id: p.id, label: p.title })),
  ]

  /*
   * The rail as it renders today, ready to adopt.
   *
   * Built from the same two lists the chrome assembles from, in the same order
   * — departments first, then pages — so pressing "Start from what I have"
   * produces the menu the shop is already showing rather than something close
   * to it.
   */
  const generated = [
    ...departments
      .filter((d) => d.showOnline)
      .map((d) => ({
        label: d.name,
        targetKind: 'department' as const,
        targetId: d.id,
        targetUrl: '',
        imageId: null,
        children: [],
      })),
    ...pages
      .filter((p) => p.isPublished && p.showInNav && p.kind === 'standard' && p.slug)
      .map((p) => ({
        label: p.title,
        targetKind: 'page' as const,
        targetId: p.id,
        targetUrl: '',
        imageId: null,
        children: [],
      })),
  ]

  return (
    <>
      <PageHeader title="Menu" subtitle="What your shop links to, and in what order" />
      <MenuClient
        // Null means "never made one", which the client shows as the offer to
        // start from the generated rail — see the note above.
        stored={stored}
        generated={generated}
        choices={choices}
      />
    </>
  )
}
