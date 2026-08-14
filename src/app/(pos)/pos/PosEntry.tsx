'use client'

import { useCallback, useEffect, useState } from 'react'
import { offlineSession, type OfflineSession } from '@/lib/posOffline/signInOffline'
import { deviceId } from '@/lib/deviceId'
import { checkDeviceAction, type DeviceState } from './deviceActions'
import PosGate from './PosGate'
import PosNotLicensed from './PosNotLicensed'
import PosShell from './PosShell'
import type { Special } from '@/lib/specialsEngine'
import type { PendingSchedule } from '@/lib/priceSchedules'
import type { TenderType } from '@/lib/site/tenderTypes'
import type { Terminal } from '@/lib/site/terminals'
import type { QuickKeyRow } from '@/lib/quickKeys'
import type { PosTable } from '@/lib/site/posTables'
import type { FloorRoom, FloorFeature } from '@/lib/site/posFloor'
import type { VisitType } from '@/lib/site/visitTypes'
import type { ServiceTier } from '@/lib/tipMath'
import type { Department } from './types'
import type { PickableReason } from '@/components/ui'

/**
 * Gate or till, decided on the CLIENT when the server could not decide it.
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────
 *
 * The server answers "who is standing at this till" from the till cookie, and that
 * is the right answer whenever it can give one. But that cookie lasts 8 hours while
 * the browser session lasts 12, so it is the FIRST to lapse: a till opened at 07:00
 * has no operator by 15:00, and one left overnight has none at all. The server then
 * renders the PIN gate — correctly — and if the network is also gone, nothing can
 * mint a new cookie.
 *
 * So this component holds the one fact the server has no access to: somebody signed
 * in against this device's own PBKDF2 verifiers, and the session is in IndexedDB.
 *
 * ── WHY THE SHELL IS RENDERED HERE RATHER THAN PASSED IN ──────────────────
 *
 * Because the operator's NAME and CAPABILITIES are part of it, and offline they come
 * from the local session rather than from the server. Passing a pre-rendered shell
 * down would mean the server had already chosen an operator — which is exactly what
 * it cannot do. So the page hands over the shop-level data it CAN resolve (products,
 * tenders, terminals, specials) and the operator is filled in from whichever session
 * turns out to exist.
 */
export default function PosEntry({
  siteId,
  siteName,
  siteVatNumber = null,
  serverOperator,
  terminals,
  departments,
  priceStructureId,
  tenders,
  voidReasons,
  returnReasons,
  cashRounding,
  savedCount,
  specials,
  pendingPrices,
  quickKeys,
  quickKeyProductNames,
  quickKeyDepartmentNames,
  hospitality,
  initialTables,
  floorRooms,
  floorFeatures,
  visitTypes = [],
  serviceTiers,
  tipsTablesOnly,
}: {
  siteId: number
  siteName: string
  /** For the till-printed slip's header. Forwarded to PosShell. */
  siteVatNumber?: string | null
  /**
   * The operator the SERVER resolved, or null when the till cookie has lapsed.
   *
   * Carries the capability booleans as well as the name, because they are read from
   * that person's ROLE — a manager who hands the till to a junior must not leave
   * their own override rights on the screen.
   */
  serverOperator: {
    userId: number
    name: string
    canOverrideDiscount: boolean
    canOverridePrice: boolean
    canVoid: boolean
  } | null
  terminals: Terminal[]
  departments: Department[]
  priceStructureId: number | null
  tenders: TenderType[]
  /** The void and return reason lists, relayed unchanged to the shell. */
  voidReasons: PickableReason[]
  returnReasons: PickableReason[]
  cashRounding: number
  savedCount: number
  specials: Special[]
  /** Approved price changes, moments unevaluated — the till decides on its clock. */
  pendingPrices: PendingSchedule[]
  quickKeys: QuickKeyRow[]
  quickKeyProductNames: Record<number, string>
  quickKeyDepartmentNames: Record<number, string>
  hospitality: boolean
  initialTables: PosTable[]
  /** The drawn floor. Relayed unchanged — this component owns sign-in, not the floor. */
  floorRooms: FloorRoom[]
  floorFeatures: FloorFeature[]
  /** Active visit types, for the table gate's filter. */
  visitTypes?: VisitType[]
  /** Tips config. Relayed unchanged — this component owns sign-in, not pricing. */
  serviceTiers: ServiceTier[]
  tipsTablesOnly: boolean
}) {
  /*
   * `undefined` means "not looked yet", which is NOT the same as "nobody is signed
   * in". Rendering the gate during that gap would flash a PIN pad at a cashier who
   * is already signed in, on every load.
   */
  const [session, setSession] = useState<OfflineSession | null | undefined>(undefined)

  useEffect(() => {
    if (serverOperator) return
    let cancelled = false
    void offlineSession(siteId).then((found) => {
      if (!cancelled) setSession(found)
    })
    return () => {
      cancelled = true
    }
  }, [siteId, serverOperator])

  /* ── This machine's licence ───────────────────────────────────────────────
     `undefined` while unasked, for the same reason `session` uses it: rendering
     a refusal during the gap would flash "not licensed" at a shop that is
     perfectly licensed, on every single load. */
  const [licence, setLicence] = useState<DeviceState | undefined>(undefined)
  const [serial, setSerial] = useState<string | null>(null)
  /* Bumped to re-ask, for the case that actually happens: a supervisor links
     this machine in the back office on another screen, then comes back and taps
     "Check again" rather than reloading. */
  const [licenceNonce, setLicenceNonce] = useState(0)
  const recheckLicence = useCallback(() => setLicenceNonce((n) => n + 1), [])

  useEffect(() => {
    let cancelled = false
    const id = deviceId()
    setSerial(id)

    /*
     * NO IDENTIFIER AT ALL — private browsing, or storage blocked.
     *
     * Allowed through rather than refused. `deviceId()` already returns null in
     * that case by design, and a shop whose kiosk browser forbids localStorage
     * would otherwise be unable to trade at all. The sale path treats an absent
     * serial the same way, so this is one decision made consistently rather than
     * two that could disagree.
     */
    if (!id) {
      setLicence({ status: 'licensed', terminalId: null, name: '', trialEndsOn: null })
      return
    }

    void checkDeviceAction(id)
      .then((state) => {
        if (!cancelled) setLicence(state)
      })
      .catch(() => {
        /* The control database is unreachable. Trade on — the same trade
           `requireLicensedDevice` makes server-side, and for the same reason: a
           shop stopped by a licence server hiccup is a far worse failure than a
           few minutes of unverified trading. */
        if (!cancelled) {
          setLicence({ status: 'licensed', terminalId: null, name: '', trialEndsOn: null })
        }
      })

    return () => {
      cancelled = true
    }
  }, [siteId, licenceNonce])

  /* The server's answer wins whenever it has one: it knows about a PIN changed five
     minutes ago on another machine, where the local verifiers are only as fresh as
     the last catalog refresh. */
  const operator = serverOperator
    ? serverOperator
    : session
      ? {
          userId: session.userId,
          name: session.name,
          /*
           * Capabilities from the stored session, resolved server-side from the
           * operator's role when the catalog was built. These decide what the SCREEN
           * offers; every server action re-checks for itself, and `postOfflineSale`
           * re-derives them from the role again at sync. A till that decided its own
           * permissions would be a till somebody could grant themselves a void on.
           */
          canOverrideDiscount: session.capabilities.includes('sales.discount_override'),
          canOverridePrice: session.capabilities.includes('sales.price_override'),
          canVoid: session.capabilities.includes('sales.void'),
        }
      : null

  // Still reading IndexedDB. Blank rather than a spinner: it resolves in
  // milliseconds, and a spinner that flashes on every load is worse than nothing.
  if (!operator && session === undefined && !serverOperator) return null

  if (!operator) {
    return <PosGate siteId={siteId} siteName={siteName} onOfflineSignIn={setSession} />
  }

  /* ── IS THIS MACHINE LICENSED? ────────────────────────────────────────────
     After sign-in, not before. The check needs `sales.till`, and a cashier who
     cannot sign in learns nothing useful from a licensing message. `undefined`
     is "not asked yet" — see the state above for why that is not `null`. */
  if (licence === undefined) return null

  if (licence.status === 'blocked') {
    return (
      <PosNotLicensed message={licence.message} serial={serial} onRetry={recheckLicence} />
    )
  }

  return (
    <PosShell
      siteId={siteId}
      siteName={siteName}
      siteVatNumber={siteVatNumber}
      operatorName={operator.name}
      operatorUserId={operator.userId}
      terminals={terminals}
      departments={departments}
      priceStructureId={priceStructureId}
      tenders={tenders}
      voidReasons={voidReasons}
      returnReasons={returnReasons}
      cashRounding={cashRounding}
      savedCount={savedCount}
      canOverrideDiscount={operator.canOverrideDiscount}
      canOverridePrice={operator.canOverridePrice}
      canVoid={operator.canVoid}
      specials={specials}
      pendingPrices={pendingPrices}
      quickKeys={quickKeys}
      quickKeyProductNames={quickKeyProductNames}
      quickKeyDepartmentNames={quickKeyDepartmentNames}
      hospitality={hospitality}
      initialTables={initialTables}
      floorRooms={floorRooms}
      floorFeatures={floorFeatures}
      visitTypes={visitTypes}
      serviceTiers={serviceTiers}
      tipsTablesOnly={tipsTablesOnly}
    />
  )
}
