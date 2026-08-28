'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Button,
  Callout,
  EmptyState,
  Icons,
  SettingGroup,
  SettingRow,
  Switch,
  useToast,
} from '@/components/ui'
import { AREA_EFFECT, AREA_LABELS, type MenuArea } from '@/lib/menuAreas'
import { saveVisibleAreasAction } from './actions'

const ICON: Record<MenuArea, React.ReactNode> = {
  inventory_advanced: <Icons.Boxes size={16} />,
  customers: <Icons.Contact size={16} />,
  online_store: <Icons.ShoppingBag size={16} />,
  loyalty: <Icons.Gem size={16} />,
  job_cards: <Icons.Wrench size={16} />,
  accounting: <Icons.Scale size={16} />,
  staff: <Icons.Users size={16} />,
}

/**
 * One switch per part of the system this shop is entitled to.
 *
 * The labels and the one-line effects live in lib/menuAreas.ts rather than here,
 * because the server half needs the same list to decide what may be written —
 * two copies would be two chances to disagree about what a switch means.
 */
export default function MenuAreasClient({
  offered,
  initialShown,
  degraded,
}: {
  /** Every area this shop may switch, in catalogue order. */
  offered: MenuArea[]
  initialShown: MenuArea[]
  /**
   * The control database could not be read, so entitlements are the fail-open
   * guess of "everything" rather than what this shop bought — see
   * control/modules.ts. Worth saying out loud here of all places: the list would
   * otherwise offer switches for modules the shop does not have, and somebody
   * would switch one on and wonder why nothing appeared.
   */
  degraded: boolean
}) {
  const router = useRouter()
  const toast = useToast()
  const [pending, startTransition] = useTransition()
  const [shown, setShown] = useState<Set<MenuArea>>(() => new Set(initialShown))
  const [saved, setSaved] = useState<Set<MenuArea>>(() => new Set(initialShown))

  /* Compared as sets rather than by a joined string, because the order the
     screen renders is fixed but the order the server returns is not. */
  const dirty = shown.size !== saved.size || [...shown].some((area) => !saved.has(area))
  const hiddenCount = offered.length - shown.size

  function toggle(area: MenuArea, next: boolean) {
    setShown((current) => {
      const updated = new Set(current)
      if (next) updated.add(area)
      else updated.delete(area)
      return updated
    })
  }

  function save() {
    startTransition(async () => {
      const result = await saveVisibleAreasAction([...shown])
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      setSaved(new Set(result.shown))
      setShown(new Set(result.shown))
      toast.success(result.message)
      /* The sidebar is rendered by the layout and every hub filters its own
         tiles on the same answer, so the whole tree has to re-render for the
         change to be visible where it matters. */
      router.refresh()
    })
  }

  if (offered.length === 0) {
    return (
      <EmptyState
        icon={<Icons.LayoutGrid size={24} />}
        title="Nothing to switch off"
        hint="This shop is on the base package, which is every screen the till and the office need. There are no sections to hide."
        action={
          <Button variant="secondary" onClick={() => router.push('/setup/billing')}>
            <Icons.CreditCard size={15} />
            See the plan
          </Button>
        }
      />
    )
  }

  return (
    <div className="flex flex-col gap-6">
      {degraded && (
        <Callout tone="warning" title="This list may not be your real plan">
          The licensing service could not be reached, so every section is being shown. Anything you
          switch off here still takes effect; what you switch on will only appear if the shop
          actually has it.
        </Callout>
      )}

      <SettingGroup
        title="What appears in the menu"
        description="Switch off a part of the system this shop does not use and it leaves the sidebar and the setup screens. Everything is on by default."
      >
        {offered.map((area) => (
          <SettingRow
            key={area}
            icon={ICON[area]}
            label={AREA_LABELS[area]}
            description={AREA_EFFECT[area]}
          >
            <Switch
              checked={shown.has(area)}
              onChange={(next) => toggle(area, next)}
              ariaLabel={`Show ${AREA_LABELS[area]} in the menu`}
            />
          </SettingRow>
        ))}
      </SettingGroup>

      <Callout tone="neutral" title="Hiding is not cancelling, and it is not a permission">
        Nothing here changes what the account is charged — that is Setup → Plan &amp; billing, and a
        module you hide is still one you pay for. It is not a permission either: it applies to
        everyone in the shop, and anyone who has bookmarked a hidden screen can still open it. Who
        may see what is decided under Roles &amp; permissions.
      </Callout>

      <div className="flex items-center justify-end gap-3">
        {!dirty && (
          <span className="text-xs text-muted">
            {hiddenCount === 0
              ? 'Everything is showing.'
              : `${hiddenCount} hidden. No changes to save.`}
          </span>
        )}
        <Button variant="primary" disabled={!dirty || pending} onClick={save}>
          <Icons.Save size={15} />
          {pending ? 'Saving…' : 'Save menu'}
        </Button>
      </div>
    </div>
  )
}
