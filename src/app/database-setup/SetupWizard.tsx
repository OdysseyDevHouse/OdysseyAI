'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Badge, Button, Card, CardBody, CardHeader, Field, Icons, Input, Select } from '@/components/ui'
import {
  dbSetup,
  type OwnerResult,
  type SafePlan,
  type SetupSite,
} from '@/lib/dbSetupClient'

/**
 * OdysseyAI Database Setup, as a person experiences it.
 *
 * ── ONE COLUMN, ONE QUESTION AT A TIME ──────────────────────────────────────
 *
 * The rest of this app is dense on purpose — a back-office operator scans a
 * thousand products and wants sixteen rows on screen. This is the opposite kind
 * of screen: it is run once, by somebody standing at a machine they may never
 * see again, and every step of it is destructive-ish or slow. So it is roomy,
 * single-column, and asks one thing per card.
 *
 * ── WHAT THIS COMPONENT NEVER HOLDS ─────────────────────────────────────────
 *
 * Any part of the connection. Not the password, and not the host, port,
 * database name or username either — `plan()` answers which SHOP this is and
 * nothing more. The rest stays in the main process for the length of the
 * install.
 *
 * Withheld rather than hidden: a screen cannot leak to a screenshot, a devtools
 * window or a crash report what it was never sent. See
 * electron/dbSetupBridge.js for why the sequence runs the other way up from the
 * obvious one.
 */

type Step =
  | { name: 'signin' }
  | { name: 'sites'; sites: SetupSite[] }
  | { name: 'confirm'; plan: SafePlan }
  | { name: 'installing' }
  | { name: 'owner'; siteName: string }
  | { name: 'done'; siteName: string; ownerName: string | null }

export default function SetupWizard() {
  const [step, setStep] = useState<Step>({ name: 'signin' })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [lines, setLines] = useState<string[]>([])

  /* ── THE BRIDGE IS LOOKED FOR AFTER MOUNTING, NOT DURING RENDER ───────────
   *
   * dbSetup() reads `window`, which does not exist while this is rendered on
   * the server — so calling it in the render body made the SERVER decide "no
   * bridge" and the CLIENT decide "bridge", which is a hydration mismatch. It
   * showed as "Not running as OdysseyAI Database Setup" flashing before the real
   * card, in the packaged app as well as in dev.
   *
   * `undefined` is therefore a third state and not laziness: not-yet-looked.
   * The server and the first client render agree on it, and only then does the
   * effect answer. Same shape as DesktopLicenceGate, for the same reason.
   */
  const [bridge, setBridge] = useState<ReturnType<typeof dbSetup> | undefined>(undefined)
  useEffect(() => {
    setBridge(dbSetup())
  }, [])

  /* Deliberately blank rather than a spinner: this resolves in one tick, and
     something that appears and vanishes reads as a fault. */
  if (bridge === undefined) return null

  /* A browser, not the installer. Said once and plainly rather than letting
     every button fail — `npm run dev` serves this route with no preload. */
  if (!bridge) return <NoBridge />

  return (
    <Wizard
      bridge={bridge}
      step={step}
      setStep={setStep}
      error={error}
      setError={setError}
      busy={busy}
      setBusy={setBusy}
      lines={lines}
      setLines={setLines}
    />
  )
}

function NoBridge() {
  return (
    <Card>
      <CardHeader
        title="Not running as Odyssey Database Setup"
        description="This screen installs a shop's database, and needs the desktop installer to do it."
      />
      <CardBody>
        <p className="text-muted text-sm">
          You are seeing it in a browser. Run the Odyssey Database Setup installer on the machine
          that will host the database.
        </p>
      </CardBody>
    </Card>
  )
}

type WizardProps = {
  bridge: NonNullable<ReturnType<typeof dbSetup>>
  step: Step
  setStep: (s: Step) => void
  error: string | null
  setError: (e: string | null) => void
  busy: boolean
  setBusy: (b: boolean) => void
  lines: string[]
  setLines: (fn: (prev: string[]) => string[]) => void
}

function Wizard({
  bridge,
  step,
  setStep,
  error,
  setError,
  busy,
  setBusy,
  lines,
  setLines,
}: WizardProps) {
  /* Subscribed once for the life of the wizard rather than per step: the
     install keeps running if somebody navigates between cards, and progress
     that arrived while nothing was listening would be lost. */
  useEffect(() => {
    return bridge.onProgress((message) => setLines((prev) => [...prev, message]))
  }, [bridge, setLines])

  const run = useCallback(
    async (fn: () => Promise<void>) => {
      setError(null)
      setBusy(true)
      try {
        await fn()
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(false)
      }
    },
    [setBusy, setError],
  )

  async function signIn(email: string, password: string) {
    await run(async () => {
      const auth = await bridge.signIn(email, password)
      if (!auth.ok) {
        setError(auth.error)
        return
      }
      const list = await bridge.sites()
      if (!list.ok) {
        setError(list.error)
        return
      }
      /* Nobody should be asked a question with one answer. A shop owner has one
         site and a support engineer has several; only the second gets a picker. */
      if (list.sites.length === 1) return choose(list.sites[0].id)
      if (list.sites.length === 0) {
        setError('This account does not have access to any shops.')
        return
      }
      setStep({ name: 'sites', sites: list.sites })
    })
  }

  async function choose(siteId: number) {
    await run(async () => {
      const plan = await bridge.plan(siteId)
      setStep({ name: 'confirm', plan })
    })
  }

  async function install(plan: Extract<SafePlan, { action: 'provision' }>) {
    setStep({ name: 'installing' })
    setLines(() => [])
    await run(async () => {
      const result = await bridge.provision()
      if (!result.ok) {
        setError(result.error)
        /* Back to the confirmation rather than a dead end: everything here is
           CREATE-IF-NOT-EXISTS, so trying again after fixing the cause is safe
           and is usually what the technician wants. */
        setStep({ name: 'confirm', plan })
        return
      }
      if (result.needsOwner) {
        setStep({ name: 'owner', siteName: plan.siteName })
        return
      }
      setStep({ name: 'done', siteName: plan.siteName, ownerName: null })
    })
  }

  async function createOwner(name: string, pin: string, siteName: string) {
    await run(async () => {
      const result: OwnerResult = await bridge.createOwner(name, pin)
      if (!result.ok) {
        setError(result.error)
        return
      }
      setStep({ name: 'done', siteName, ownerName: name })
    })
  }

  switch (step.name) {
    case 'signin':
      return <SignInStep onSubmit={signIn} busy={busy} error={error} />
    case 'sites':
      return <SitesStep sites={step.sites} onChoose={choose} busy={busy} error={error} />
    case 'confirm':
      return (
        <ConfirmStep
          plan={step.plan}
          busy={busy}
          error={error}
          onInstall={install}
          onBack={() => setStep({ name: 'signin' })}
        />
      )
    case 'installing':
      return <InstallingStep lines={lines} />
    case 'owner':
      return (
        <OwnerStep
          siteName={step.siteName}
          busy={busy}
          error={error}
          onSubmit={(name, pin) => createOwner(name, pin, step.siteName)}
        />
      )
    case 'done':
      return <DoneStep siteName={step.siteName} ownerName={step.ownerName} />
  }
}

/* ── 1. Sign in ───────────────────────────────────────────────────────────── */

function SignInStep({
  onSubmit,
  busy,
  error,
}: {
  onSubmit: (email: string, password: string) => void
  busy: boolean
  error: string | null
}) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')

  return (
    <Card>
      <CardHeader
        title="Sign in to find this shop"
        description="Use the Odyssey email and password you were given. It tells this machine which shop it is installing — it does not become a login for the shop."
      />
      <CardBody>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            onSubmit(email, password)
          }}
        >
          <Field label="Email">
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="username"
              autoFocus
              required
              icon={<Icons.Mail size={16} aria-hidden="true" />}
            />
          </Field>
          <Field label="Password" error={error ?? undefined}>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </Field>
          <div className="flex justify-end">
            <Button type="submit" variant="primary" disabled={busy}>
              {busy ? 'Checking…' : 'Continue'}
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  )
}

/* ── 2. Which shop ────────────────────────────────────────────────────────── */

function SitesStep({
  sites,
  onChoose,
  busy,
  error,
}: {
  sites: SetupSite[]
  onChoose: (siteId: number) => void
  busy: boolean
  error: string | null
}) {
  const [siteId, setSiteId] = useState(String(sites[0]?.id ?? ''))

  return (
    <Card>
      <CardHeader
        title="Which shop is this machine for?"
        description="The database installed here will belong to the shop you pick."
      />
      <CardBody>
        <div className="flex flex-col gap-4">
          <Field label="Shop" error={error ?? undefined}>
            <Select value={siteId} onChange={(e) => setSiteId(e.target.value)}>
              {sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.code} — {s.displayName}
                </option>
              ))}
            </Select>
          </Field>
          <div className="flex justify-end">
            <Button variant="primary" disabled={busy} onClick={() => onChoose(Number(siteId))}>
              {busy ? 'Checking…' : 'Continue'}
            </Button>
          </div>
        </div>
      </CardBody>
    </Card>
  )
}

/* ── 3. Confirm ───────────────────────────────────────────────────────────── */

function ConfirmStep({
  plan,
  busy,
  error,
  onInstall,
  onBack,
}: {
  plan: SafePlan
  busy: boolean
  error: string | null
  onInstall: (plan: Extract<SafePlan, { action: 'provision' }>) => void
  onBack: () => void
}) {
  /* A cloud site is not an error and must not read like one. There is genuinely
     nothing to install, and saying so plainly beats installing a database that
     nothing will ever connect to. */
  if (plan.action === 'nothing') {
    return (
      <Card>
        <CardHeader title="Nothing to install here" description={plan.siteName} />
        <CardBody>
          <p className="text-muted text-sm">{plan.reason}</p>
        </CardBody>
      </Card>
    )
  }

  if (plan.action === 'refuse') {
    return (
      <Card>
        <CardHeader title="This cannot go ahead" />
        <CardBody>
          <div className="flex flex-col gap-4">
            <p className="text-danger-ink text-sm">{plan.reason}</p>
            <div>
              <Button variant="secondary" onClick={onBack}>
                Start again
              </Button>
            </div>
          </div>
        </CardBody>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader
        title={plan.alreadyInstalled ? 'Update this machine’s database' : 'Install the database'}
        description={
          plan.alreadyInstalled
            ? 'A database is already installed here. Its settings will be brought in line with the control panel — nothing is erased.'
            : 'This will install a database server on this machine and create the shop’s database in it.'
        }
      />
      <CardBody>
        <div className="flex flex-col gap-5">
          <dl className="flex flex-col gap-2.5 text-sm">
            <Row label="Shop">
              {plan.siteCode} — {plan.siteName}
            </Row>
            <Row label="Kind">
              <Badge tone={plan.connectionType === 'hybrid' ? 'warning' : 'brand'}>
                {plan.connectionType === 'hybrid' ? 'Hybrid — in-store box' : 'Local — this machine'}
              </Badge>
            </Row>
            {/* Where the database goes, what it is called and who connects to it
                are all decided by the control panel and none of them are this
                screen's business. They are not hidden here — they are never sent
                to it. See SafePlan in lib/dbSetupClient.ts. */}
          </dl>

          {error && <p className="text-danger-ink text-sm">{error}</p>}

          <div className="flex justify-between gap-3">
            <Button variant="secondary" onClick={onBack} disabled={busy}>
              Back
            </Button>
            <Button variant="primary" onClick={() => onInstall(plan)} disabled={busy}>
              {plan.alreadyInstalled ? 'Update settings' : 'Install'}
            </Button>
          </div>
        </div>
      </CardBody>
    </Card>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-muted">{label}</dt>
      <dd className="text-ink text-right">{children}</dd>
    </div>
  )
}

/* ── 4. Installing ────────────────────────────────────────────────────────── */

function InstallingStep({ lines }: { lines: string[] }) {
  const endRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [lines])

  return (
    <Card>
      <CardHeader
        title="Installing"
        description="This takes a few minutes. Leave the machine on and do not close this window."
      />
      <CardBody>
        {/* Real lines rather than a spinner: applying 254 migrations is long
            enough that a technician needs to see it moving, and a failure names
            the file it stopped on. */}
        <div className="bg-surface-2 border-border rounded-card max-h-72 overflow-y-auto border p-4">
          <ol className="flex flex-col gap-1.5">
            {lines.length === 0 && <li className="text-muted text-sm">Starting…</li>}
            {lines.map((line, i) => (
              <li key={i} className="text-ink-2 font-mono text-xs">
                {line}
              </li>
            ))}
          </ol>
          <div ref={endRef} />
        </div>
      </CardBody>
    </Card>
  )
}

/* ── 5. The store owner ───────────────────────────────────────────────────── */

function OwnerStep({
  siteName,
  busy,
  error,
  onSubmit,
}: {
  siteName: string
  busy: boolean
  error: string | null
  onSubmit: (name: string, pin: string) => void
}) {
  const [name, setName] = useState('')
  const [pin, setPin] = useState('')

  return (
    <Card>
      <CardHeader
        title="Create the store owner"
        description={`The database for ${siteName} is installed and empty. This first login is how the shop gets in — they add everybody else themselves.`}
      />
      <CardBody>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            onSubmit(name, pin)
          }}
        >
          <Field label="Name" hint="What they will type to sign in.">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              required
              maxLength={120}
              icon={<Icons.User size={16} aria-hidden="true" />}
            />
          </Field>
          <Field
            label="PIN"
            hint="4 or 6 digits. Not a repeated digit or a run — the owner can change it later."
            error={error ?? undefined}
            className="max-w-[12rem]"
          >
            <Input
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
              inputMode="numeric"
              autoComplete="off"
              required
              maxLength={6}
            />
          </Field>
          <div className="flex justify-end">
            <Button type="submit" variant="primary" disabled={busy}>
              {busy ? 'Creating…' : 'Create and finish'}
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  )
}

/* ── 6. Done ──────────────────────────────────────────────────────────────── */

function DoneStep({ siteName, ownerName }: { siteName: string; ownerName: string | null }) {
  return (
    <Card>
      <CardHeader title="Setup is complete" description={siteName} />
      <CardBody>
        <div className="flex flex-col gap-4 text-sm">
          <p className="text-muted">
            The database is installed on this machine and holds the shop&rsquo;s tables.
          </p>
          {ownerName ? (
            <p className="text-ink">
              Install Odyssey Back Office on this machine and sign in as{' '}
              <span className="text-ink font-medium">{ownerName}</span> with the PIN you just set.
            </p>
          ) : (
            <p className="text-ink">
              This shop already had users. Install Odyssey Back Office on this machine and sign in
              with an existing name and PIN.
            </p>
          )}
          <p className="text-muted">You can close this window.</p>
        </div>
      </CardBody>
    </Card>
  )
}
