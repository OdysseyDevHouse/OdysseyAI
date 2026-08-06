'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import {
  Badge,
  Button,
  Card,
  CardFooter,
  CardHeader,
  Checkbox,
  CurrencyInput,
  Field,
  Icons,
  Input,
  NumberInput,
  SettingGroup,
  SettingRow,
  Select,
  Switch,
  Textarea,
  useToast,
} from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import type {
  DeliveryZone,
  OnlineSettings,
  OnlineSettingsInput,
  PublishCounts,
} from '@/lib/site/onlineStore'
import { saveSettingsAction } from './actions'
import DeliveryZones from './DeliveryZones'

/**
 * The storefront's settings.
 *
 * The screen is built around one idea: opening the store is a big deal, so the
 * consequence of every choice is stated BEFORE it is made. The publish selector
 * carries live product counts, the delivery section says what happens with no
 * areas set up, and the switch at the top refuses to move until the rest is
 * coherent. An owner should never learn what they configured by looking at
 * their own live storefront.
 */

export default function SetupForm({
  settings,
  counts,
  zones,
  storePath,
}: {
  settings: OnlineSettings
  counts: PublishCounts
  zones: DeliveryZone[]
  /** The public shop's path. The origin is added in the browser. */
  storePath: string
}) {
  const toast = useToast()
  const [saving, startSaving] = useTransition()

  const [form, setForm] = useState<OnlineSettingsInput>({
    isEnabled: settings.isEnabled,
    collectEnabled: settings.collectEnabled,
    deliverEnabled: settings.deliverEnabled,
    paymentMode: settings.paymentMode,
    allowAccount: settings.allowAccount,
    publishMode: settings.publishMode,
    priceStructureId: settings.priceStructureId,
    leadTimeMinutes: settings.leadTimeMinutes,
    minOrderIncl: settings.minOrderIncl,
    blurb: settings.blurb,
    paidStatusId: settings.paidStatusId,
    reviewsEnabled: settings.reviewsEnabled,
  })

  function patch(next: Partial<OnlineSettingsInput>) {
    setForm((f) => ({ ...f, ...next }))
  }

  function save() {
    startSaving(async () => {
      const result = await saveSettingsAction(form)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(form.isEnabled ? 'Your online store is open.' : 'Settings saved.')
    })
  }

  // Built in the browser: the server has no reliable view of the public
  // origin behind a proxy, and getting it wrong would print a link that works
  // for nobody.
  const storeUrl = typeof window === 'undefined' ? storePath : `${window.location.origin}${storePath}`

  const activeZones = zones.filter((z) => z.isActive).length
  const publishedCount =
    form.publishMode === 'all'
      ? counts.all
      : form.publishMode === 'departments'
        ? counts.departments
        : counts.flagged

  // Everything that would stop the store opening, gathered so the switch can
  // explain itself instead of failing on save.
  const blockers: string[] = []
  if (!form.collectEnabled && !form.deliverEnabled) {
    blockers.push('Choose collection, delivery, or both.')
  }
  if (publishedCount === 0) {
    blockers.push(
      form.publishMode === 'departments'
        ? 'No departments are set to show online, so the store would be empty.'
        : 'No products are set to show online, so the store would be empty.',
    )
  }
  if (form.deliverEnabled && activeZones === 0) {
    blockers.push('Add at least one delivery area, or every address is turned away.')
  }
  if (form.paymentMode === 'online') {
    blockers.push('Paying online is not available yet.')
  }

  return (
    <>
      {/* The one thing an owner comes here to check: is my shop open? */}
      <Card>
        <div className="flex items-center gap-4 px-6 py-4">
          <span
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-control ${
              form.isEnabled ? 'bg-success-soft text-success' : 'bg-surface-2 text-muted'
            }`}
          >
            <Icons.Globe size={18} />
          </span>

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-ink">Online store</span>
              <Badge tone={form.isEnabled ? 'success' : 'neutral'}>
                {form.isEnabled ? 'Open' : 'Closed'}
              </Badge>
            </div>
            <p className="mt-0.5 text-sm text-muted">
              {form.isEnabled
                ? 'Anyone with your link can place an order.'
                : 'Nobody can reach your store while this is off.'}
            </p>
          </div>

          <Switch
            checked={form.isEnabled}
            onChange={(next) => patch({ isEnabled: next })}
            label="Online store open"
            disabled={blockers.length > 0 && !form.isEnabled}
          />
        </div>

        {/* Why the switch won't move. Stated here rather than as a save error,
            so the owner sees the work remaining before they try. */}
        {blockers.length > 0 && !form.isEnabled && (
          <div className="border-t border-border bg-warning-soft px-6 py-3">
            <p className="text-sm font-medium text-warning-ink">
              Finish these before opening the store
            </p>
            <ul className="mt-1 flex flex-col gap-0.5">
              {blockers.map((b) => (
                <li key={b} className="text-sm text-warning-ink">
                  • {b}
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>

      {/* Only shown once the shop is open: a link that 404s is worse than no
          link, and handing one out before opening is how that happens. */}
      {form.isEnabled && (
        <Card>
          <CardHeader
            title="Your shop link"
            description="Share this on WhatsApp, your Facebook page, or as a QR code on the counter."
          />
          <div className="flex flex-wrap items-center gap-2 px-5 pb-5">
            <Input
              readOnly
              value={storeUrl}
              aria-label="Your shop link"
              className="min-w-0 flex-1"
              onFocus={(e) => e.currentTarget.select()}
            />
            <Button
              variant="secondary"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(storeUrl)
                  toast.success('Link copied.')
                } catch {
                  // Clipboard access is refused outside a secure context, and
                  // "nothing happened" would look like a broken button.
                  toast.info('Select the link and copy it.')
                }
              }}
            >
              <Icons.Copy size={15} />
              Copy
            </Button>
            <a href={storePath} target="_blank" rel="noreferrer">
              <Button variant="ghost">
                <Icons.ExternalLink size={15} />
                Open
              </Button>
            </a>
          </div>
        </Card>
      )}

      <SettingGroup
        title="What customers can buy"
        description="Your store is public — only publish what you're happy for anyone to see."
      >
        <SettingRow
          icon={<Icons.Boxes size={18} />}
          label="Products to publish"
          description={
            publishedCount === 0
              ? 'Nothing would be published, so the store would be empty.'
              : `${publishedCount.toLocaleString('en-ZA')} of your ${counts.total.toLocaleString('en-ZA')} products.`
          }
          htmlFor="publish-mode"
        >
          <Select
            id="publish-mode"
            value={form.publishMode}
            onChange={(e) =>
              patch({ publishMode: e.target.value as OnlineSettingsInput['publishMode'] })
            }
            className="w-72"
          >
            <option value="departments">
              Chosen departments only ({counts.departments.toLocaleString('en-ZA')})
            </option>
            <option value="flagged">
              Only products I&apos;ve ticked ({counts.flagged.toLocaleString('en-ZA')})
            </option>
            <option value="all">
              Everything in my product file ({counts.all.toLocaleString('en-ZA')})
            </option>
          </Select>
        </SettingRow>

        {form.publishMode !== 'all' && (
          <div className="border-b border-border px-6 py-3 last:border-b-0">
            <p className={`text-sm ${publishedCount === 0 ? 'text-danger' : 'text-muted'}`}>
              {form.publishMode === 'departments' ? (
                <>
                  Tick “Show in online store” on a department to include it and everything
                  filed under it.{' '}
                  <Link href="/departments" className="font-medium text-brand hover:underline">
                    Go to departments
                  </Link>
                </>
              ) : (
                <>
                  Tick “Show in online store” on a product to include it.{' '}
                  <Link href="/products" className="font-medium text-brand hover:underline">
                    Go to products
                  </Link>
                </>
              )}
            </p>
          </div>
        )}
      </SettingGroup>

      <SettingGroup
        title="How customers get their order"
        description="Delivery also asks the customer for an address at checkout."
      >
        <SettingRow
          icon={<Icons.Store size={18} />}
          label="Collection"
          description="Customers collect from the shop."
        >
          <Checkbox
            checked={form.collectEnabled}
            onChange={(e) => patch({ collectEnabled: e.target.checked })}
            aria-label="Offer collection"
          />
        </SettingRow>

        <SettingRow
          icon={<Icons.Truck size={18} />}
          label="Delivery"
          description={
            form.deliverEnabled && activeZones === 0
              ? 'No delivery areas yet — every address would be turned away.'
              : `${activeZones} delivery ${activeZones === 1 ? 'area' : 'areas'} set up.`
          }
        >
          <Checkbox
            checked={form.deliverEnabled}
            onChange={(e) => patch({ deliverEnabled: e.target.checked })}
            aria-label="Offer delivery"
          />
        </SettingRow>

        <SettingRow
          icon={<Icons.Clock size={18} />}
          label="Preparation time"
          description="How long you need before an order can be collected."
          htmlFor="lead-time"
        >
          <div className="flex items-center gap-2">
            <NumberInput
              id="lead-time"
              value={form.leadTimeMinutes}
              min={0}
              onChange={(e) => patch({ leadTimeMinutes: Number(e.target.value) || 0 })}
              className="w-24"
            />
            <span className="text-sm text-muted">minutes</span>
          </div>
        </SettingRow>

        <SettingRow
          icon={<Icons.Money size={18} />}
          label="Minimum order"
          description={
            form.minOrderIncl > 0
              ? `Orders under ${formatMoney(form.minOrderIncl)} are refused.`
              : 'Leave at 0 for no minimum.'
          }
          htmlFor="min-order"
        >
          <CurrencyInput
            id="min-order"
            value={form.minOrderIncl}
            onChange={(e) => patch({ minOrderIncl: Number(e.target.value) || 0 })}
            className="w-32"
          />
        </SettingRow>
      </SettingGroup>

      {form.deliverEnabled && <DeliveryZones zones={zones} />}

      <SettingGroup title="Paying" description="How customers settle up for an online order.">
        <SettingRow
          icon={<Icons.CreditCard size={18} />}
          label="When customers pay"
          description="Accepted orders become normal sales you finalise at the till."
          htmlFor="payment-mode"
        >
          <Select
            id="payment-mode"
            value={form.paymentMode}
            onChange={(e) =>
              patch({ paymentMode: e.target.value as OnlineSettingsInput['paymentMode'] })
            }
            className="w-72"
          >
            <option value="on_collection">Pay on collection or delivery</option>
            <option value="online">Pay online when ordering</option>
          </Select>
        </SettingRow>

        {form.paymentMode === 'online' && (
          // Not a soft warning: the save is refused. Taking card payments needs
          // a verified gateway callback, and until that exists an order that
          // says it is paid would be taking the shopper's word for it.
          <div className="border-b border-border px-6 py-3 last:border-b-0">
            <p className="text-sm text-danger">
              Paying online isn&apos;t available yet — a payment gateway has to be connected
              first. Choose “Pay on collection or delivery” to open your store.
            </p>
          </div>
        )}

        <SettingRow
          icon={<Icons.MessageSquare size={18} />}
          label="Show customer reviews"
          description="Reviews appear on a product only after you approve them — nothing publishes itself."
        >
          <Switch
            checked={form.reviewsEnabled}
            onChange={(next) => patch({ reviewsEnabled: next })}
            label="Show customer reviews"
          />
        </SettingRow>

        <SettingRow
          icon={<Icons.Contact size={18} />}
          label="Let account customers order on account"
          description="Signed-in customers charge the order to their account. Their credit limit is checked, and the account is only debited when you finalise the sale."
        >
          <Switch
            checked={form.allowAccount}
            onChange={(next) => patch({ allowAccount: next })}
            label="Allow account orders"
          />
        </SettingRow>
      </SettingGroup>

      <SettingGroup
        title="How your store introduces itself"
        description="Shown when your link is shared and in search results."
      >
        <div className="px-6 py-4">
          <Field
            label="Welcome message"
            hint="One line describing your shop."
          >
            <Textarea
              value={form.blurb}
              rows={2}
              maxLength={500}
              placeholder="e.g. Order ahead and skip the queue."
              onChange={(e) => patch({ blurb: e.target.value })}
            />
          </Field>
        </div>
      </SettingGroup>

      <Card>
        <CardHeader
          title="Save"
          description={
            settings.updatedBy
              ? `Last changed by ${settings.updatedBy}.`
              : 'These settings have not been changed yet.'
          }
        />
        <CardFooter>
          <Button variant="primary" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save settings'}
          </Button>
        </CardFooter>
      </Card>
    </>
  )
}
