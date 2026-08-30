'use client'

import { useRef, useState, useTransition } from 'react'
import {
  Button,
  Callout,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  Field,
  Input,
  Icons,
  useToast,
} from '@/components/ui'
import {
  saveStoreDetailsAction,
  saveTaxLabelAction,
  uploadLogoAction,
  clearLogoAction,
} from './actions'

/**
 * My store information — what this shop calls itself, and how it is reached.
 *
 * ── TWO HALVES WITH DIFFERENT RULES, AND THE SCREEN SAYS SO ─────────────────
 *
 * The DETAILS live in the control database; the LOGO lives on this machine's
 * own disk. That is why a local store can change one and not the other, and the
 * screen states it in a sentence at the top rather than leaving somebody to
 * discover it as a form that will not submit.
 *
 * On a locked store the fields render as VALUES, not as disabled inputs. A
 * greyed-out form reads as broken, or as a permission somebody should go and
 * ask for; a plain list of facts reads as a list of facts.
 */

export type StoreDetails = {
  companyName: string
  tradingName: string
  registrationNumber: string
  vatNumber: string
  address1: string
  address2: string
  address3: string
  postalCode: string
  phone: string
  email: string
  contactName: string
}

/** Read-only rows, for a store whose details are held in the control panel. */
function ReadOnlyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5 border-b border-border py-3 last:border-b-0 sm:flex-row sm:items-baseline sm:gap-4">
      <span className="text-xs text-muted sm:w-56 sm:shrink-0">{label}</span>
      <span className={value ? 'text-sm text-ink' : 'text-sm text-faint'}>
        {value || 'Not set'}
      </span>
    </div>
  )
}

export default function StoreInfoClient({
  initial,
  initialTaxLabel,
  logoFile,
  siteCode,
  editable,
  lockedReason,
  mirroredAt,
}: {
  initial: StoreDetails
  /** What this shop calls its tax. A site setting, so every store may change it. */
  initialTaxLabel: string
  logoFile: string
  siteCode: string
  /** Whether the DETAILS may be changed. The logo is never governed by this. */
  editable: boolean
  /** Why not, when they may not — shown verbatim. */
  lockedReason: string | null
  /** When the offline copy was last confirmed, on a store reading one. */
  mirroredAt: string | null
}) {
  const toast = useToast()
  const [pending, start] = useTransition()
  const [form, setForm] = useState(initial)
  /* The saved values, so "Discard" has something to go back to and the buttons
     know whether there is anything to save. */
  const [saved, setSaved] = useState(initial)

  /* The stored name doubles as a cache-buster: the URL is constant per site, so
     without it a replaced logo would keep showing the old picture. */
  const [logo, setLogo] = useState(logoFile)
  const fileInput = useRef<HTMLInputElement>(null)

  /* Its own pair of states rather than part of `form`: this one saves to a
     different database through a different action, and folding it into the
     details' `dirty` would arm their Save button for a change it does not
     write. */
  /* `taxLabel`, not `label`: the field helper below takes a parameter of that
     name, and a state variable it shadows is one rename away from a bug that
     compiles. */
  const [taxLabel, setTaxLabel] = useState(initialTaxLabel)
  const [savedTaxLabel, setSavedTaxLabel] = useState(initialTaxLabel)

  function saveTaxLabel() {
    start(async () => {
      const res = await saveTaxLabelAction(taxLabel)
      if (!res.ok) {
        toast.error(res.error)
        return
      }
      /* Echoed back from what was TYPED rather than re-read: the action trims,
         so storing the raw value would leave the field looking unsaved. */
      const trimmed = taxLabel.trim()
      setTaxLabel(trimmed)
      setSavedTaxLabel(trimmed)
      toast.success(res.message)
    })
  }

  const dirty = (Object.keys(form) as (keyof StoreDetails)[]).some((k) => form[k] !== saved[k])

  function set<K extends keyof StoreDetails>(key: K, value: string) {
    setForm((f) => ({ ...f, [key]: value }))
  }

  function save() {
    const data = new FormData()
    for (const [key, value] of Object.entries(form)) data.set(key, value)
    start(async () => {
      const res = await saveStoreDetailsAction(data)
      if (!res.ok) {
        toast.error(res.error)
        return
      }
      setSaved(form)
      toast.success(res.message)
    })
  }

  function uploadLogo(file: File) {
    const data = new FormData()
    data.set('logo', file)
    start(async () => {
      const res = await uploadLogoAction(data)
      if (!res.ok) {
        toast.error(res.error)
        return
      }
      toast.success(res.message)
      // A new token, so the <img> refetches rather than showing the old picture.
      setLogo(`${Date.now()}`)
    })
  }

  function removeLogo() {
    start(async () => {
      const res = await clearLogoAction()
      if (!res.ok) {
        toast.error(res.error)
        return
      }
      toast.success(res.message)
      setLogo('')
    })
  }

  /**
   * One field, as an input or as a value, depending on who is reading.
   *
   * `alwaysEditable` is the local store's exception, and today only the VAT
   * number carries it. A shop that owns its own database still has to be able
   * to capture the number that lets it price its catalogue — see LOCAL_EDITABLE
   * in actions.ts, which re-decides this server-side rather than trusting the
   * form that was rendered.
   */
  function text(
    key: keyof StoreDetails,
    label: string,
    opts: {
      hint?: string
      maxLength: number
      type?: string
      alwaysEditable?: boolean
    } = { maxLength: 255 },
  ) {
    if (!editable && !opts.alwaysEditable) {
      return <ReadOnlyRow key={key} label={label} value={form[key]} />
    }
    return (
      <Field key={key} label={label} hint={opts.hint}>
        <Input
          type={opts.type ?? 'text'}
          value={form[key]}
          maxLength={opts.maxLength}
          onChange={(e) => set(key, e.target.value)}
        />
      </Field>
    )
  }

  /* A read-only store is a list to scan, so it stays one column; an editable one
     pairs fields up, which halves the height of every card. */
  const grid = editable ? 'grid gap-4 sm:grid-cols-2' : 'flex flex-col'

  return (
    <div className="flex flex-col gap-5">
      {lockedReason && (
        <Callout tone="neutral" title="These details are managed in the control panel">
          {lockedReason}
          {mirroredAt && (
            <>
              {' '}
              This copy was last confirmed {mirroredAt}.
            </>
          )}
        </Callout>
      )}

      {/* Anchored for the search's "Store name and VAT number": both fields are
          in THIS card. The tax card further down is what the tax is CALLED
          (VAT, HST) rather than your number, so pointing the search there would
          answer a different question. */}
      <Card id="business-identity">
        <CardHeader
          title="Who this business is"
          description="The names and numbers that print on every invoice, statement and order you send out."
        />
        <CardBody>
          <div className={grid}>
            {text('companyName', 'Registered company name', {
              maxLength: 255,
              hint: 'The legal name. Used wherever no trading name is set.',
            })}
            {text('tradingName', 'Trading name', {
              maxLength: 255,
              hint: 'What customers know you as. Leave blank to use the registered name.',
            })}
            {text('registrationNumber', 'Company registration number', { maxLength: 60 })}
            {/* Named with the shop's OWN word — `savedTaxLabel`, not the live
                input, so the heading does not rewrite itself letter by letter
                while somebody types a new label into the card below. */}
            {text('vatNumber', `${savedTaxLabel} number`, {
              maxLength: 60,
              hint: editable
                ? `Prints on tax invoices, and lets you put products on a ${savedTaxLabel} rate. Leave blank if you are not registered.`
                : `Prints on tax invoices, and lets you put products on a ${savedTaxLabel} rate. Saving it needs an internet connection.`,
              /* The local store's one editable detail. Without it a shop that
                 owns its own database could not price its own catalogue — the
                 tax-rate guard refuses every rate above zero until a number is
                 captured. */
              alwaysEditable: true,
            })}
          </div>
        </CardBody>
        {/* Only for a store whose OTHER fields are locked: an editable one saves
            everything together from the footer at the bottom of the next card,
            and a second button there would be two ways to do one thing. */}
        {!editable && (
          <CardFooter>
            <div className="flex items-center justify-end gap-2">
              {!dirty && <span className="text-xs text-muted">No changes to save.</span>}
              <Button variant="primary" onClick={save} disabled={pending || !dirty}>
                Save {savedTaxLabel} number
              </Button>
            </div>
          </CardFooter>
        )}
      </Card>

      <Card>
        <CardHeader
          title="How you are reached"
          description="Where a customer or supplier replies when they have a question about a document."
        />
        <CardBody>
          <div className={grid}>
            {text('phone', 'Telephone', { maxLength: 50 })}
            {text('email', 'Email address', {
              maxLength: 255,
              type: 'email',
              hint: 'Where replies to emailed documents go.',
            })}
            {text('contactName', 'Contact person', {
              maxLength: 150,
              hint: 'Who to ask for. Optional.',
            })}
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Where you are"
          description="Your trading address, as it should appear on printed documents."
        />
        <CardBody>
          <div className={grid}>
            {text('address1', 'Address line 1', { maxLength: 255 })}
            {text('address2', 'Address line 2', { maxLength: 255, hint: 'Suburb or town.' })}
            {text('address3', 'Address line 3', { maxLength: 255, hint: 'City or province.' })}
            {text('postalCode', 'Postal code', { maxLength: 20 })}
          </div>
          {!editable && <ReadOnlyRow label="Store code" value={siteCode} />}
        </CardBody>
        {editable && (
          <CardFooter>
            <div className="flex items-center justify-end gap-2">
              <Button
                variant="ghost"
                onClick={() => setForm(saved)}
                disabled={pending || !dirty}
              >
                Discard changes
              </Button>
              <Button variant="primary" onClick={save} disabled={pending || !dirty}>
                Save store information
              </Button>
            </div>
          </CardFooter>
        )}
      </Card>

      {/* Beside the VAT number rather than on a settings screen somewhere: the
          two are one fact about the shop — what its tax is called and what it is
          registered as — and somebody capturing one is thinking about the other.
          Its own card because it saves separately: this write goes to THIS
          database and works offline, which the number above does not. */}
      <Card>
        <CardHeader
          title="What your tax is called"
          description="The word this country uses. It appears on every screen, document, slip and report."
        />
        <CardBody>
          <div className="flex flex-wrap items-end gap-4">
            <Field
              label="Tax name"
              hint="VAT in South Africa, HST in Canada, Tax in the United States."
            >
              <Input
                className="w-40"
                value={taxLabel}
                maxLength={12}
                onChange={(e) => setTaxLabel(e.target.value)}
              />
            </Field>
            <div className="flex items-center gap-2 pb-1">
              <Button
                variant="primary"
                onClick={saveTaxLabel}
                disabled={pending || taxLabel.trim() === savedTaxLabel}
              >
                Save
              </Button>
              {taxLabel.trim() === savedTaxLabel && (
                <span className="text-xs text-muted">No change to save.</span>
              )}
            </div>
          </div>
          <p className="pt-3 text-sm text-muted">
            Changing this renames the tax everywhere at once — it does not change any rate, any
            price or any figure. A document already issued keeps the wording it was printed
            with.
          </p>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Your logo"
          description="Printed at the top of your documents, and shown on the till's sign-in screen."
        />
        <CardBody>
          <div className="flex flex-wrap items-center gap-4">
            {logo ? (
              // eslint-disable-next-line @next/next/no-img-element -- served by an
              // authenticated route that streams bytes off disk; Next's optimiser
              // cannot fetch it, and a logo needs no responsive variants.
              <img
                src={`/api/document-logo?v=${encodeURIComponent(logo)}`}
                alt=""
                className="max-h-14 w-auto rounded-control border border-border bg-surface p-2"
              />
            ) : (
              <p className="text-sm text-muted">No logo yet — documents print the name only.</p>
            )}

            <input
              ref={fileInput}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) uploadLogo(f)
                e.target.value = ''
              }}
            />
            <Button
              variant="secondary"
              onClick={() => fileInput.current?.click()}
              disabled={pending}
            >
              <Icons.Upload aria-hidden className="h-4 w-4" />
              {logo ? 'Replace' : 'Upload a logo'}
            </Button>
            {logo && (
              <Button variant="danger-ghost" onClick={removeLogo} disabled={pending}>
                Remove
              </Button>
            )}
          </div>
          <p className="mt-3 text-xs text-muted">
            PNG or JPEG reads everywhere; GIF and WebP print but are left off emailed
            invoices. Keep it under 500&nbsp;KB — an emailed PDF carries the file itself, so a
            larger logo is skipped there rather than attached to every invoice. To choose
            where it sits on a document, add a{' '}
            <span className="font-medium text-ink">Your logo</span> block in Setup &rsaquo;
            Stationery.
          </p>
        </CardBody>
      </Card>
    </div>
  )
}
