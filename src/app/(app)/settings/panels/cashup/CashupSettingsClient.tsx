'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Badge,
  Button,
  Callout,
  CurrencyInput,
  Icons,
  SettingGroup,
  Select,
  SettingRow,
  Switch,
  useToast,
} from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import {
  saveCashupSettingsAction,
  setCashupModeAction,
  switchCurrencyAction,
  setDenominationActiveAction,
  type CashupSettings,
} from './actions'

/**
 * The threshold that turns a difference into a question somebody has to answer.
 *
 * It is not a rounding allowance. Inside it, a shift closes without comment;
 * outside it, the declaration screen makes a reason mandatory. So it is really
 * the answer to "how much may a till be short before we ask about it", and the
 * two failure modes point opposite ways: set it too high and real shortages
 * pass unremarked, too low and every cashier writes "R2 out, don't know" twice
 * a day until nobody reads the reasons at all.
 *
 * Both ends are warned about and neither is refused — the save goes through,
 * the consequence is just said out loud first.
 */
export default function CashupSettingsClient({
  settings: initial,
  mode: initialMode,
  openShiftCount,
  currency,
  denominations,
  currencies,
}: {
  settings: CashupSettings
  mode: 'terminal' | 'user'
  openShiftCount: number
  /** What this shop counts in, and whether the grid below agrees. */
  currency: {
    code: string
    symbol: string
    denominationCode: string | null
    mismatched: boolean
  }
  /** The grid, INCLUDING rows turned off — turning one back on is the point. */
  denominations: {
    id: number
    label: string
    value: number
    isNote: boolean
    isActive: boolean
  }[]
  /** What may be switched to. Names only — the sets live on the server. */
  currencies: { code: string; name: string; symbol: string }[]
}) {
  const router = useRouter()
  const toast = useToast()
  const [pending, startTransition] = useTransition()
  const [saved, setSaved] = useState(initial)
  const [mode, setMode] = useState(initialMode)
  const [tolerance, setTolerance] = useState(Number(initial.varianceTolerance))
  const [requireShift, setRequireShift] = useState(initial.requireShift === '1')

  /*
   * The mode and the currency both save ON CLICK rather than waiting for Save,
   * because both can be REFUSED by something this screen does not control — an
   * open shift. Folding either into the single Save would mean a press that
   * wrote the tolerance and silently rejected the other, which is the ambiguity
   * the guard exists to prevent.
   *
   * `confirming` holds a currency somebody picked but has not yet agreed to.
   * Switching replaces every row in the grid, which is not a thing to do on one
   * click of a dropdown.
   */
  const [confirming, setConfirming] = useState<string | null>(null)

  function confirmCurrency(code: string) {
    setConfirming(null)
    startTransition(async () => {
      const result = await switchCurrencyAction(code)
      if (!result.ok) return toast.error(result.error)
      toast.success(result.message)
      router.refresh()
    })
  }

  function toggleDenomination(id: number, active: boolean) {
    startTransition(async () => {
      const result = await setDenominationActiveAction(id, active)
      if (!result.ok) return toast.error(result.error)
      router.refresh()
    })
  }

  function chooseMode(next: 'terminal' | 'user') {
    if (next === mode) return
    startTransition(async () => {
      const result = await setCashupModeAction(next)
      if (!result.ok) return toast.error(result.error)
      setMode(next)
      toast.success(result.message)
      router.refresh()
    })
  }

  const dirty =
    tolerance !== Number(saved.varianceTolerance) ||
    requireShift !== (saved.requireShift === '1')

  function save() {
    startTransition(async () => {
      const result = await saveCashupSettingsAction({
        requireShift: requireShift ? '1' : '0',
        /* Sent as a plain number, NOT toFixed(2). The column is a VARCHAR and
           every reader runs Number() over it, so '5' and '5.00' are the same
           setting — but writing the padded form back would rewrite a value the
           site already had, and `dirty` compares numbers so a cosmetic
           difference never presents itself as an unsaved change. */
        varianceTolerance: String(tolerance),
      })

      if (!result.ok) {
        toast.error(result.error)
        return
      }
      setSaved(result.settings)
      setTolerance(Number(result.settings.varianceTolerance))
      setRequireShift(result.settings.requireShift === '1')
      toast.success('Cash-up settings saved.')
    })
  }

  return (
    <div className="flex flex-col gap-6">
      {/* First, because it decides whether the two groups below apply at all.
          A shop that does not count a drawer has no variance to tolerate and
          no mode to reconcile by. */}
      <SettingGroup
        title="Shifts"
        description="A shift is the drawer between two moments — opened with a float, closed with a count. Not every shop works that way."
      >
        <SettingRow
          icon={<Icons.Lock size={16} />}
          label="Require an open shift to sell"
          description="The till asks for a float before the first sale and will not trade until somebody opens one. Turn this off for a shop that never counts a drawer."
          htmlFor="require-shift"
        >
          <Switch
            id="require-shift"
            checked={requireShift}
            onChange={setRequireShift}
            ariaLabel="Require an open shift to sell"
          />
        </SettingRow>

        {/* Only while it differs from what is stored, same rule as the variance
            warning below: a permanent banner about a setting already in force
            is furniture, and furniture is what stops the next warning being
            read. */}
        {!requireShift && saved.requireShift === '1' && (
          <div className="flex flex-col gap-4 px-6 py-4">
            <Callout tone="warning" title="Sales will not belong to any cash-up">
              With this off, a sale rung up while no shift is open carries no shift at all — so
              it appears in no cash-up, and no drawer is ever short because of it. That is the
              right answer for a shop settling everything by card, and the wrong one for a shop
              that counts cash.
              <br />
              <br />
              Shifts still work. Anyone may open one from the till menu, and every sale from
              that moment banks into it as usual.
            </Callout>
          </div>
        )}
      </SettingGroup>

      <SettingGroup
        title="Variance"
        description="A cash-up almost never lands exactly on the expected figure. This is the point at which the difference stops being noise and becomes something somebody has to account for."
      >
        <SettingRow
          icon={<Icons.Coins size={16} />}
          label="Variance tolerance"
          description="A drawer out by more than this — over or short — cannot be closed without a written reason. Zero means every cent has to be explained."
          htmlFor="variance-tolerance"
        >
          <CurrencyInput
            id="variance-tolerance"
            className="w-40"
            value={tolerance}
            onChange={(e) => setTolerance(Number(String(e.target.value).replace(',', '.')) || 0)}
          />
        </SettingRow>

        {/* Only while the value differs from what is stored — a permanent
            banner about a setting already in force is furniture, and furniture
            is what stops the next warning being read.

            Wrapped for the gutter, same as the mode panels below: a Callout is
            not a SettingRow and brings no padding of its own. */}
        {dirty && (tolerance === 0 || tolerance >= 100) && (
          <div className="flex flex-col gap-4 px-6 py-4">
            {tolerance === 0 && (
              <Callout tone="brand" title="Every difference will need a reason">
                At zero, a drawer a single cent out cannot be closed until somebody types an
                explanation. Some stores want exactly that; most find the reasons stop being
                read.
              </Callout>
            )}
            {tolerance >= 100 && (
              <Callout tone="warning" title="That is a large tolerance">
                Anything under {formatMoney(tolerance)} will close without comment, so a drawer
                short by {formatMoney(Math.max(tolerance - 0.01, 0))} would pass unremarked
                every single day.
              </Callout>
            )}
          </div>
        )}
      </SettingGroup>


      <SettingGroup
        title="What a cash-up counts"
        description="Sales bank into whichever shift owns them. Each shift records the mode it opened under, so this decides how the NEXT one behaves."
      >
        {/* Two panels rather than a select: the choice is between two ways of
            running a floor, and the difference is in the sentence under each
            title, not in the words "till" and "person".

            The px-6 py-4 matches SettingRow's own gutter: SettingGroup gives
            its children no padding, so anything that is not a SettingRow has
            to bring the same one or it sits flush against the card edge. */}
        <div className="flex flex-col gap-4 px-6 py-4">
          <div className="flex flex-col gap-3 sm:flex-row">
            {(
              [
                {
                  value: 'terminal',
                  title: 'By till',
                  blurb:
                    'One drawer, counted by whoever is on it. Retail, where a cashier stands at a register.',
                  icon: <Icons.Terminal size={16} />,
                },
                {
                  value: 'user',
                  title: 'By person',
                  blurb:
                    'One person and their own float, across whatever tills they work. Hospitality, where waiters share registers.',
                  icon: <Icons.Users size={16} />,
                },
              ] as const
            ).map((option) => {
              const active = mode === option.value
              return (
                /* Not a kit component: a two-panel radio with a title, a blurb
                   and a selected state has no equivalent in the kit, and this
                   is the same markup the cash-up screen used before the
                   control moved here. */
                <button
                  key={option.value}
                  type="button"
                  data-kit-ok
                  disabled={pending || active || openShiftCount > 0}
                  onClick={() => chooseMode(option.value)}
                  className={`flex flex-1 flex-col gap-1 rounded-card border p-3 text-left transition-colors ${
                    active
                      ? 'border-brand bg-brand-soft'
                      : 'border-border hover:border-brand disabled:hover:border-border'
                  } disabled:cursor-not-allowed`}
                >
                  <span className="flex items-center gap-2 text-sm font-medium text-ink">
                    {option.icon}
                    {option.title}
                    {active && <Badge tone="brand">In use</Badge>}
                  </span>
                  <span className="text-xs text-muted">{option.blurb}</span>
                </button>
              )
            })}
          </div>

          {/* Says WHY the panels are dead before somebody clicks one and gets a
              toast. The action refuses regardless — this only spares the trip. */}
          {openShiftCount > 0 && (
            <Callout tone="warning" title="Close every shift before changing this">
              {openShiftCount === 1 ? 'One shift is' : `${openShiftCount} shifts are`} still
              open. A shift is reconciled by the rule it opened under, so switching now would
              leave a half-counted drawer following one rule while the next sale banks by
              another.
            </Callout>
          )}
        </div>
      </SettingGroup>

      {/* Last, because it is the least-touched setting on the screen: a shop
          chooses its currency when it opens and then never again. */}
      <SettingGroup
        title="Money"
        description="What the drawer is counted in. Choosing a currency replaces the notes and coins below with that country's."
      >
        <SettingRow
          icon={<Icons.Coins size={16} />}
          label="Currency"
          description="The notes and coins a cashier counts into. Changing it does not convert any price or figure — it only changes what the grid asks for."
          htmlFor="currency"
        >
          <Select
            id="currency"
            className="w-64"
            value={currency.code}
            disabled={pending || openShiftCount > 0}
            onChange={(e) => {
              const next = e.target.value
              if (next !== currency.code) setConfirming(next)
            }}
          >
            {/* A code this build does not know still has to appear, or the
                control would silently show the wrong currency as selected. */}
            {!currencies.some((c) => c.code === currency.code) && (
              <option value={currency.code}>{currency.code}</option>
            )}
            {currencies.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name} ({c.symbol})
              </option>
            ))}
          </Select>
        </SettingRow>

        <div className="flex flex-col gap-4 px-6 py-4">
          {openShiftCount > 0 && (
            <Callout tone="warning" title="Close every shift before changing this">
              {openShiftCount === 1 ? 'One shift is' : `${openShiftCount} shifts are`} still
              open. A drawer is counted against the grid it was opened with, so swapping the
              notes and coins now would leave a half-counted declaration pointing at rows that
              are no longer on the screen.
            </Callout>
          )}

          {/* The state 240 added the column to make visible: the shop says one
              currency and its grid is still the old one. */}
          {currency.mismatched && !confirming && (
            <Callout tone="warning" title="The grid does not match the currency">
              This store is set to {currency.code}, but the notes and coins below are{' '}
              {currency.denominationCode ?? 'a mix of currencies'}. Choose {currency.code} above
              to replace them.
            </Callout>
          )}

          {confirming && (
            <Callout tone="warning" title="This replaces every note and coin below">
              The grid becomes{' '}
              {currencies.find((c) => c.code === confirming)?.name ?? confirming}. Nothing that
              has already been counted changes — past cash-ups keep the notes and coins they
              were counted with — but from now on the drawer is counted in the new set.
              <div className="flex items-center gap-2 pt-3">
                <Button
                  variant="primary"
                  disabled={pending}
                  onClick={() => confirmCurrency(confirming)}
                >
                  Replace the grid
                </Button>
                <Button variant="ghost" disabled={pending} onClick={() => setConfirming(null)}>
                  Keep what I have
                </Button>
              </div>
            </Callout>
          )}

          {/* The grid itself. Read-only apart from the tick, which is the one
              edit 168 argued for: a demonetised coin should be a checkbox. */}
          <div className="flex flex-col gap-2">
            <p className="text-xs font-medium text-muted">
              What a cashier counts ({denominations.filter((d) => d.isActive).length} of{' '}
              {denominations.length} in use)
            </p>
            <div className="flex flex-wrap gap-2">
              {denominations.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  data-kit-ok
                  disabled={pending}
                  onClick={() => toggleDenomination(d.id, !d.isActive)}
                  title={d.isActive ? 'Counted — click to turn off' : 'Not counted — click to turn on'}
                  className={`rounded-control border px-3 py-1.5 text-sm transition-colors disabled:cursor-not-allowed ${
                    d.isActive
                      ? 'border-brand bg-brand-soft text-ink'
                      : 'border-border text-faint line-through hover:border-brand'
                  }`}
                >
                  {d.label}
                  <span className="ml-2 text-xs text-muted">{d.isNote ? 'note' : 'coin'}</span>
                </button>
              ))}
            </div>
            <p className="text-xs text-muted">
              Turn one off when it is no longer in circulation — it stays on past cash-ups that
              counted it. Notes and coins are counted in separate piles on the cash-up screen.
            </p>
          </div>
        </div>
      </SettingGroup>

      <div className="flex items-center justify-end gap-3">
        {/* Says the save did nothing rather than leaving a live button that
            appears to do something. */}
        {!dirty && <span className="text-xs text-muted">No changes to save.</span>}
        <Button variant="primary" disabled={!dirty || pending} onClick={save}>
          <Icons.Save size={15} />
          {pending ? 'Saving…' : 'Save settings'}
        </Button>
      </div>
    </div>
  )
}
