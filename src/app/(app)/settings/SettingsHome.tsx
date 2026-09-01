'use client'

import { useMemo, useState, type ReactElement } from 'react'
import { Card, CardBody, CategoryTile, EmptyState, Icons, ToolbarSearch } from '@/components/ui'
import type { LucideIcon } from '@/components/ui/icons'
import type { SettingsCategory, SettingsIconName } from './catalogue'
import PurchasingPanel from './panels/purchasing/PurchasingPanel'
import HospitalityPanel from './panels/hospitality/HospitalityPanel'
import CashupPanel from './panels/cashup/CashupPanel'
import StockTakesPanel from './panels/stock-takes/StockTakesPanel'
import StockTrackingPanel from './panels/stock-tracking/StockTrackingPanel'
import TillPanel from './panels/till/TillPanel'
import OnlineBookingsPanel from './panels/online-bookings/OnlineBookingsPanel'
import SystemPanel from './panels/system/SystemPanel'
import DecimalsPanel from './panels/decimals/DecimalsPanel'

/**
 * Name → glyph, resolved here rather than in the catalogue because the
 * catalogue is imported by a server component and a Lucide component cannot be
 * serialised across that boundary. Same arrangement as `hubIcons.tsx`.
 */
const GLYPH: Record<SettingsIconName, LucideIcon> = {
  Coins: Icons.Coins,
  Armchair: Icons.Armchair,
  Wallet: Icons.Wallet,
  ClipboardList: Icons.ClipboardList,
  Terminal: Icons.Terminal,
  Barcode: Icons.Barcode,
  Calendar: Icons.Calendar,
  Code: Icons.Code,
  Hash: Icons.Hash,
}

/**
 * Which component fills each tab.
 *
 * Keyed by the catalogue's `key`, so a tab and its panel cannot drift apart:
 * adding a category without a panel here is a missing key on a typed Record and
 * therefore a compile error, not a blank screen somebody finds later.
 *
 * Every panel is a client component that loads its own settings when opened —
 * see the note in PurchasingPanel for why the page does not fetch them all up
 * front.
 */
const PANELS: Record<string, () => ReactElement> = {
  purchasing: PurchasingPanel,
  hospitality: HospitalityPanel,
  cashup: CashupPanel,
  'stock-takes': StockTakesPanel,
  'stock-tracking': StockTrackingPanel,
  till: TillPanel,
  'online-bookings': OnlineBookingsPanel,
  system: SystemPanel,
  decimals: DecimalsPanel,
}

function glyph(name: SettingsIconName, size = 18) {
  const Icon = GLYPH[name]
  return <Icon size={size} strokeWidth={1.7} />
}

/**
 * System settings.
 *
 * A SHELL, not a hub: the rail on the left is a tab control, and the settings
 * themselves render in the panel beside it. Nothing here navigates away, which
 * is what lets somebody change a VAT rate and a receipt footer without two
 * page loads and two lots of finding their place again.
 *
 * Opens on the first tab — a settings screen with nothing selected is a menu,
 * and this one already has its menu permanently on the left.
 *
 * The search filters the RAIL rather than a list of results. On a screen whose
 * navigation is always visible, "find me the tab that holds this" is the only
 * thing a search can usefully mean, and narrowing the rail answers it in place
 * rather than replacing the panel the person is working in.
 */
export default function SettingsHome({
  tabs,
  initialTab,
}: {
  /**
   * The tabs THIS person may see, already filtered by module and capability on
   * the server. Passed in rather than imported, so a tab for a module the shop
   * has not bought is never sent to the browser at all.
   */
  tabs: SettingsCategory[]
  /**
   * Which tab to open, from `?tab=`. Already checked against `tabs` by the
   * page, so an unknown or unpermitted value never reaches here — it arrives
   * undefined and the first tab opens.
   */
  initialTab?: string
}) {
  const [active, setActive] = useState<string>(initialTab ?? tabs[0]!.key)
  const [search, setSearch] = useState('')
  const query = search.trim().toLowerCase()

  const found = useMemo(() => {
    if (!query) return tabs
    return tabs.filter(
      (c) =>
        c.label.toLowerCase().includes(query) ||
        c.blurb.toLowerCase().includes(query) ||
        c.description.toLowerCase().includes(query) ||
        c.keywords.includes(query),
    )
  }, [query, tabs])

  const current = tabs.find((c) => c.key === active) ?? tabs[0]!

  return (
    <div className="flex flex-col gap-5 lg:flex-row">
      <aside className="flex w-full shrink-0 flex-col gap-4 lg:w-64">
        {/* Above the rail, not inside it: the search decides WHICH TAB, so it
            belongs over the whole list rather than in the panel it filters. */}
        <ToolbarSearch
          value={search}
          onChange={setSearch}
          placeholder="Search settings..."
          className="w-full"
        />

        <Card>
          <div className="px-4 py-3.5">
            <h2 className="text-xs font-semibold tracking-wide text-muted uppercase">
              Settings Categories
            </h2>
          </div>
          {/* A tablist, so arrow keys and screen readers treat this as the tab
              control it is rather than as a row of unrelated buttons. */}
          <div role="tablist" aria-orientation="vertical" className="flex flex-col gap-0.5 border-t border-border p-2">
            {found.map((category) => (
              <RailTab
                key={category.key}
                category={category}
                selected={category.key === active}
                onSelect={() => setActive(category.key)}
              />
            ))}
            {found.length === 0 && (
              <p className="px-2.5 py-6 text-center text-xs text-muted">
                No category matches “{search.trim()}”.
              </p>
            )}
          </div>
        </Card>
      </aside>

      <div
        role="tabpanel"
        id="settings-panel"
        aria-labelledby={`settings-tab-${current.key}`}
        className="min-w-0 flex-1"
      >
        <SettingsPanel category={current} />
      </div>
    </div>
  )
}

/**
 * One row of the rail.
 *
 * A <button> rather than a <Link>, because this switches a panel rather than
 * navigating — the previous version's links were what made this a launcher.
 */
function RailTab({
  category,
  selected,
  onSelect,
}: {
  category: SettingsCategory
  selected: boolean
  onSelect: () => void
}) {
  return (
    /* Not a kit component: a two-line tab with a leading glyph and a selected
       edge. <Tabs> is a horizontal strip of single-line labels and could not
       carry the blurb, which is what makes an unfamiliar category choosable. */
    <button
      type="button"
      role="tab"
      id={`settings-tab-${category.key}`}
      aria-selected={selected}
      aria-controls="settings-panel"
      onClick={onSelect}
      data-kit-ok
      className={`group flex items-center gap-2.5 rounded-control border-l-2 px-2.5 py-2 text-left transition ${
        selected
          ? 'border-l-brand bg-brand-soft'
          : 'border-l-transparent hover:bg-surface-2'
      }`}
    >
      <span
        className={`shrink-0 transition ${selected ? 'text-brand' : 'text-muted group-hover:text-brand'}`}
      >
        {glyph(category.icon, 17)}
      </span>
      <span className="min-w-0">
        <span
          className={`block truncate text-sm font-medium transition ${
            selected ? 'text-brand' : 'text-ink-2 group-hover:text-ink'
          }`}
        >
          {category.label}
        </span>
        <span className="block truncate text-xs text-muted">{category.blurb}</span>
      </span>
    </button>
  )
}

/**
 * The open panel: a heading naming the category, then its settings.
 *
 * The heading is drawn HERE rather than by each panel, so panels written on
 * different days cannot each invent their own title block. A panel renders
 * only the settings themselves.
 */
function SettingsPanel({ category }: { category: SettingsCategory }) {
  const Panel = PANELS[category.key]

  return (
    <div className="flex flex-col gap-4">
      {/* Not a Card. The panel's own heading is chrome for what follows, and
          giving it the same border and shadow as the setting groups below made
          it read as the first of them rather than as the title over them. */}
      <div className="flex items-center gap-3">
        <CategoryTile icon={glyph(category.icon, 20)} tone={category.tone} size="md" />
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-ink">{category.label}</h2>
          <p className="mt-0.5 text-sm text-muted">{category.description}</p>
        </div>
      </div>

      {/* Unreachable while every category has a panel — PANELS is checked
          against the catalogue by the settings-tabs test. Kept so that a tab
          added without one says so instead of rendering nothing at all. */}
      {Panel ? (
        <Panel />
      ) : (
        <Card>
          <CardBody>
            <EmptyState
              icon={glyph(category.icon, 26)}
              title={`${category.label} has no panel yet`}
              hint="This tab is listed but its settings have not been built. That is a bug, not a state you should be able to reach."
            />
          </CardBody>
        </Card>
      )}
    </div>
  )
}
