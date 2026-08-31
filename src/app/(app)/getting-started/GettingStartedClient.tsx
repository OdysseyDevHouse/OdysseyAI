'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  Badge,
  Button,
  ButtonLink,
  buttonClass,
  Card,
  CardBody,
  CardHeader,
  CategoryTile,
  ConfirmModal,
  Icons,
  MeterBar,
  SegmentedControl,
  useToast,
  type CategoryTone,
} from '@/components/ui'
import { tillLinkProps } from '@/lib/openTill'
import { hideGettingStarted, showGettingStarted } from './actions'

/**
 * The checklist a new shop lands on.
 *
 * Client-side only for the FILTER — "everything" versus "what is left". The
 * steps and their done-ness are computed on the server and handed down, because
 * they are a read of the database and this component must never be able to
 * disagree with it.
 */

/* Name → glyph, exactly as the hubs do it (see hubIcons.tsx): a catalogue is
   imported by a server component, and a Lucide component cannot cross that
   boundary as a prop, so the catalogue carries a name and this maps it back.
   A LOCAL map rather than HUB_ICONS because this screen names glyphs that are
   not in `HubIconName` — widening a shared type for one screen's use makes
   every hub catalogue able to name an icon no hub wants. */
const GLYPHS = {
  Store: Icons.Store,
  LayoutGrid: Icons.LayoutGrid,
  Package: Icons.Package,
  Boxes: Icons.Boxes,
  Users: Icons.Users,
  ShoppingCart: Icons.ShoppingCart,
  ShieldCheck: Icons.ShieldCheck,
  Truck: Icons.Truck,
  Contact: Icons.Contact,
  CreditCard: Icons.CreditCard,
  Warehouse: Icons.Warehouse,
  LayoutDashboard: Icons.LayoutDashboard,
  BarChart: Icons.BarChart,
  Upload: Icons.Upload,
  Stamp: Icons.Stamp,
  Globe: Icons.Globe,
} as const

function Glyph({ name, size = 18 }: { name: string; size?: number }) {
  const Icon = GLYPHS[name as keyof typeof GLYPHS] ?? Icons.Package
  return <Icon size={size} strokeWidth={1.7} />
}

export type ViewStep = {
  key: string
  title: string
  blurb: string
  href: string
  cta: string
  icon: string
  tone: CategoryTone
  minutes: number
  essential: boolean
  newWindow?: boolean
  done: boolean
  count: number
}

export type ViewPointer = {
  title: string
  blurb: string
  href: string
  icon: string
  tone: CategoryTone
}

export default function GettingStartedClient({
  firstName,
  shopName,
  steps,
  pointers,
  essentialDone,
  essentialTotal,
  canDismiss,
  currentlyHidden,
}: {
  firstName: string
  shopName: string
  steps: ViewStep[]
  pointers: ViewPointer[]
  essentialDone: number
  essentialTotal: number
  /** Whether to offer the dismiss at all — `setup.edit`, re-checked in the action. */
  canDismiss: boolean
  /** The shop has hidden this and is here via `?show=1`. */
  currentlyHidden: boolean
}) {
  const [filter, setFilter] = useState<'all' | 'todo'>('all')
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const toast = useToast()
  const router = useRouter()

  async function apply(hide: boolean) {
    setBusy(true)
    try {
      const result = hide ? await hideGettingStarted() : await showGettingStarted()
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(result.message)
      setConfirming(false)
      /* Hiding sends them away — the screen they are on has just been put away,
         and leaving them looking at it would be the button appearing not to
         work. Un-hiding stays put and refreshes, so the row returns to the menu
         beside them. */
      if (hide) router.push('/dashboard')
      else router.refresh()
    } finally {
      setBusy(false)
    }
  }

  const ready = essentialDone === essentialTotal && essentialTotal > 0
  const remaining = steps.filter((s) => !s.done)
  /* The minutes left, from the steps THIS person still has to do — not the
     catalogue's total. A figure that ignores what is already done is a figure
     that never moves, and one nobody believes twice. */
  const minutesLeft = remaining.filter((s) => s.essential).reduce((n, s) => n + s.minutes, 0)

  const shown = filter === 'todo' ? remaining : steps
  const essential = shown.filter((s) => s.essential)
  const optional = shown.filter((s) => !s.essential)

  /* A step's number is its place in the CATALOGUE, not its index in whatever is
     currently on screen. Numbering the rendered rows meant "To do" renumbered
     the list from 1 and the remaining step changed number as others were
     ticked — so the one thing the number is for, telling somebody where they
     are in a fixed sequence, was the thing it could not do. */
  const numberOf = new Map(steps.filter((s) => s.essential).map((s, i) => [s.key, i + 1]))

  /*
   * ONE primary button on the page, on the step to do next.
   *
   * Every outstanding step used to carry a filled button, which put five of
   * them on screen at once — and five primaries is none, per the craft guide.
   * Worse, it made a list with an ORDER look like five equal choices, when the
   * whole argument for the order is that step four wants what step three made.
   *
   * The next essential step gets the filled button; every other outstanding one
   * keeps the same action as a quiet button. Nothing is hidden or disabled —
   * somebody who wants step six first still presses it — but the eye is told
   * where to go, which is what the screen is for.
   */
  const nextKey = steps.find((s) => s.essential && !s.done)?.key

  return (
    <div className="flex flex-col gap-5">
      {/* ── The banner: where they are, and the one number that says it ──── */}
      <Card>
        <CardBody className="flex flex-col gap-4">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <Icons.Sparkles size={18} className="shrink-0 text-brand" />
                <h2 className="text-base font-semibold text-ink">
                  {ready ? `${shopName} is ready to trade` : `Welcome, ${firstName}`}
                </h2>
              </div>
              <p className="mt-1 max-w-2xl text-sm text-muted">
                {ready
                  ? 'Every essential step is done. What is left below is worth doing, but you can serve a customer today.'
                  : `Six short steps and ${shopName} can ring up its first sale. Work down the list — each one only asks for something the step before it made.`}
              </p>
            </div>

            {!ready && minutesLeft > 0 && (
              <div className="flex shrink-0 items-center gap-2 rounded-pill bg-surface-2 px-3 py-1.5">
                <Icons.Clock size={14} className="text-muted" />
                <span className="text-sm text-ink-2">
                  About <span className="numeric font-medium text-ink">{minutesLeft}</span> min left
                </span>
              </div>
            )}
          </div>

          <div>
            <div className="mb-1.5 flex items-baseline justify-between gap-3">
              <span className="text-xs font-medium tracking-wide text-muted uppercase">
                Ready to trade
              </span>
              <span className="numeric text-sm text-ink-2">
                {essentialDone} of {essentialTotal}
              </span>
            </div>
            <MeterBar
              height={10}
              segments={[
                { label: 'Done', value: essentialDone, tone: ready ? 'success' : 'brand' },
                { label: 'To do', value: essentialTotal - essentialDone, tone: 'neutral' },
              ]}
            />
          </div>
        </CardBody>
      </Card>

      {/* ── The checklist ─────────────────────────────────────────────────── */}
      <Card>
        <CardHeader
          icon={<Icons.Check size={18} />}
          title="Set up your shop"
          description="In the order that works — each step only needs what the one before it made."
          action={
            <SegmentedControl
              value={filter}
              onChange={(v) => setFilter(v as 'all' | 'todo')}
              options={[
                { value: 'all', label: 'All steps' },
                { value: 'todo', label: `To do (${remaining.length})` },
              ]}
            />
          }
        />

        {shown.length === 0 ? (
          <CardBody>
            <div className="flex flex-col items-center px-6 py-12 text-center">
              <div className="mb-3 flex size-12 items-center justify-center rounded-pill bg-success-soft text-success-ink">
                <Icons.Check size={24} strokeWidth={2} />
              </div>
              <p className="text-sm font-semibold text-ink">Everything on the list is done</p>
              <p className="mt-1 max-w-md text-sm text-muted">
                {shopName} is set up. The dashboard is where to go from here — it shows how the shop
                is trading each day.
              </p>
              <div className="mt-4">
                <ButtonLink href="/dashboard" variant="primary">
                  Open the dashboard
                </ButtonLink>
              </div>
            </div>
          </CardBody>
        ) : (
          <div>
            {essential.map((s) => (
              <StepRow
                key={s.key}
                step={s}
                number={numberOf.get(s.key)}
                isNext={s.key === nextKey}
              />
            ))}

            {optional.length > 0 && (
              <>
                <div className="flex items-center gap-3 border-b border-border bg-surface-2 px-5 py-2.5">
                  <span className="text-xs font-medium tracking-wide text-muted uppercase">
                    Worth doing next
                  </span>
                  <span className="text-xs text-faint">
                    Not needed to start selling
                  </span>
                </div>
                {optional.map((s) => (
                  <StepRow key={s.key} step={s} />
                ))}
              </>
            )}
          </div>
        )}
      </Card>

      {/* ── The pointers ──────────────────────────────────────────────────── */}
      {pointers.length > 0 && (
        <Card>
          <CardHeader
            icon={<Icons.Lightbulb size={18} />}
            title="Once you are trading"
            description="The screens worth knowing about — these have nothing to tick off."
          />
          <CardBody>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {pointers.map((p) => (
                <Link
                  key={p.href}
                  href={p.href}
                  /* Not a kit component: this is a whole tile that is a link, and
                     the kit's CategoryTile is the glyph inside it rather than the
                     card around it. Same tokens throughout. */
                  data-kit-ok
                  className="flex items-start gap-3 rounded-card border border-border bg-surface p-4 transition hover:border-border-strong hover:bg-surface-2"
                >
                  <CategoryTile icon={<Glyph name={p.icon} />} tone={p.tone} />
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-ink">{p.title}</p>
                    <p className="mt-0.5 text-sm text-muted">{p.blurb}</p>
                  </div>
                </Link>
              ))}
            </div>
          </CardBody>
        </Card>
      )}

      {/* ── Finished with this screen ──────────────────────────────────────
          Last on the page on purpose: it is what somebody wants AFTER reading
          the rest, and putting a way out at the top invites dismissing a
          checklist before seeing what is on it. */}
      {canDismiss && (
        <Card>
          <CardBody className="flex flex-wrap items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="text-sm font-medium text-ink">
                {currentlyHidden
                  ? 'This screen is hidden'
                  : 'Finished setting up?'}
              </p>
              <p className="mt-0.5 max-w-2xl text-sm text-muted">
                {currentlyHidden
                  ? 'Getting started is not in the menu, and signing in goes straight to the dashboard. You are seeing it now because you followed a direct link.'
                  : 'Hide Getting started for everyone at this store. It leaves the menu and sign-in goes straight to the dashboard — nothing you have set up changes, and you can bring it back whenever you like.'}
              </p>
            </div>
            <Button
              variant={currentlyHidden ? 'primary' : 'secondary'}
              onClick={() => (currentlyHidden ? apply(false) : setConfirming(true))}
              disabled={busy}
            >
              {currentlyHidden ? 'Show it again' : "Don't show this again"}
            </Button>
          </CardBody>
        </Card>
      )}

      <ConfirmModal
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={() => apply(true)}
        busy={busy}
        /* 'primary' rather than 'danger': nothing is destroyed and the act is
           reversible from the message below. A red button here would claim a
           consequence the setting does not have. */
        tone="primary"
        title="Hide Getting started?"
        confirmLabel="Hide it"
        message={
          <>
            <p>
              It will leave the menu for everyone at {shopName}, and signing in will go
              straight to the dashboard.
            </p>
            <p className="mt-2 text-muted">
              Nothing you have set up is changed or lost. To bring it back later, open{' '}
              <span className="whitespace-nowrap">/getting-started?show=1</span> and press
              “Show it again”.
            </p>
          </>
        }
      />
    </div>
  )
}

/**
 * One step.
 *
 * A row rather than a tile: the blurb is the part that makes an unfamiliar step
 * choosable, and a grid of tiles either truncates it or turns the page into a
 * wall of paragraphs. Rows also give the numbers a column to line up in, which
 * is what makes the list read as an ORDER rather than a menu.
 */
function StepRow({
  step,
  number,
  isNext = false,
}: {
  step: ViewStep
  number?: number
  /** The one step to do next — the only filled button on the page. */
  isNext?: boolean
}) {
  /* Done → "Open", quietly. The step to do next → its own words, loudly.
     Anything else outstanding → its own words, quietly. A done step keeps a way
     back in because "add a product" is not a thing you do once. */
  const variant = isNext ? 'primary' : 'secondary'
  const label = step.done ? 'Open' : step.cta

  return (
    <div className="flex items-start gap-4 border-b border-border px-5 py-4 last:border-b-0">
      {/* The marker: a tick once done, the step's number while it is not. The
          two occupy the same box so the rows never shift as things complete. */}
      <span
        aria-hidden
        className={`mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-pill text-xs font-semibold ${
          step.done
            ? 'bg-success-soft text-success-ink'
            : number
              ? 'bg-brand-soft text-brand'
              : 'bg-surface-2 text-muted'
        }`}
      >
        {step.done ? <Icons.Check size={15} strokeWidth={2.5} /> : (number ?? <Icons.Minus size={14} />)}
      </span>

      <CategoryTile icon={<Glyph name={step.icon} />} tone={step.tone} />

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className={`text-sm font-medium ${step.done ? 'text-ink-2' : 'text-ink'}`}>
            {step.title}
          </p>
          {step.done && (
            <Badge tone="success">
              {step.count > 0 ? `${step.count >= 20 ? '20+' : step.count} added` : 'Done'}
            </Badge>
          )}
          {!step.done && (
            <span className="numeric text-xs text-faint">{step.minutes} min</span>
          )}
        </div>
        <p className="mt-0.5 text-sm text-muted">{step.blurb}</p>
      </div>

      <div className="shrink-0 pt-0.5">
        {step.newWindow ? (
          <Link
            href={step.href}
            {...tillLinkProps}
            /* The till opens BESIDE the back office rather than replacing it —
               see lib/openTill.ts — and ButtonLink passes no `target`. So this
               borrows the exact button skin instead of restyling one, which is
               what PrimaryLink does for the same reason. */
            className={buttonClass({ variant })}
          >
            {label}
          </Link>
        ) : (
          <ButtonLink href={step.href} variant={variant}>
            {label}
          </ButtonLink>
        )}
      </div>
    </div>
  )
}
