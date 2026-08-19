'use client'

import { useState, useTransition } from 'react'
import {
  Badge,
  Button,
  Callout,
  Card,
  CardBody,
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
  TextLink,
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
    showStock: settings.showStock,
    showPhotos: settings.showPhotos,
    showBrands: settings.showBrands,
    showDepartmentImages: settings.showDepartmentImages,
    currencyCode: settings.currencyCode,
    currencySymbol: settings.currencySymbol,
    basketReminders: settings.basketReminders,
    basketReminderHours: settings.basketReminderHours,
    basketReminderNote: settings.basketReminderNote,
    holdMinutes: settings.holdMinutes,
    publicDomain: settings.publicDomain,
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
        <CardBody className="flex items-center gap-4">
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
        </CardBody>

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
          // A note strip, not a SettingRow — it explains the row above it and
          // holds no control. The zero state gets a badge rather than tinting
          // the whole sentence.
          <div className="flex items-start gap-2 border-b border-border px-6 py-3 last:border-b-0">
            {publishedCount === 0 && (
              <Badge tone="danger">Nothing published</Badge>
            )}
            <p className="text-sm text-muted">
              {form.publishMode === 'departments' ? (
                <>
                  Tick “Show in online store” on a department to include it and everything
                  filed under it. <TextLink href="/departments">Go to departments</TextLink>
                </>
              ) : (
                <>
                  Tick “Show in online store” on a product to include it.{' '}
                  <TextLink href="/products">Go to products</TextLink>
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
            <Callout tone="danger" title="Paying online isn't available yet.">
              A payment gateway has to be connected first. Choose “Pay on collection or
              delivery” to open your store.
            </Callout>
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
          icon={<Icons.FileImage size={18} />}
          label="Show product photographs"
          description="Off shows a plain list of names and prices, which is faster on a weak signal and fine for a shop whose products are not photographed."
        >
          <Switch
            checked={form.showPhotos}
            onChange={(next) => patch({ showPhotos: next })}
            label="Show product photographs"
          />
        </SettingRow>

        {/*
          The SHOP’s money, and only the shop’s.

          Said plainly in the description, because it is the sort of setting
          somebody reasonably assumes is app-wide: an invoice, a statement and
          a till slip all still print R. Threading a currency through those is
          a different piece of work — see 190.
        */}
        <SettingRow
          icon={<Icons.Coins size={18} />}
          label="Money"
          description="What your online shoppers see beside a price, and what a search engine is told the number means. Your invoices, statements and till slips are not affected."
        >
          <div className="flex gap-2">
            <Field label="Symbol">
              <Input
                value={form.currencySymbol}
                maxLength={4}
                placeholder="R"
                className="w-20"
                onChange={(e) => patch({ currencySymbol: e.target.value })}
              />
            </Field>
            {/* Three letters, because that is what schema.org and every
                payment gateway expect. "$" is eight different currencies, so
                the code cannot be derived from the symbol. */}
            <Field label="Code" hint="Three letters, e.g. ZAR.">
              <Input
                value={form.currencyCode}
                maxLength={3}
                placeholder="ZAR"
                className="w-24"
                onChange={(e) => patch({ currencyCode: e.target.value.toUpperCase() })}
              />
            </Field>
          </div>
        </SettingRow>

        {/* Beside the product-photograph switch, because they are the same
            kind of decision — how picture-led the shop is — and an owner
            turning one on usually wants the other. */}
        <SettingRow
          icon={<Icons.LayoutGrid size={18} />}
          label="Show department pictures"
          description="Puts each department’s picture on the row under the search and on the “Shop by department” tiles. Departments without one show their colour and initial instead — set a picture on the department itself."
        >
          <Switch
            checked={form.showDepartmentImages}
            onChange={(next) => patch({ showDepartmentImages: next })}
            label="Show department pictures"
          />
        </SettingRow>

        <SettingRow
          icon={<Icons.Package size={18} />}
          label="Show how many are left"
          description="Shoppers see “Only 3 left” on low stock, which encourages them to decide. It also publishes what you are holding, and it is only as accurate as your last stock take — so leave it off if your counts drift."
        >
          <Switch
            checked={form.showStock}
            onChange={(next) => patch({ showStock: next })}
            label="Show how many are left"
          />
        </SettingRow>

        <SettingRow
          icon={<Icons.Tag size={18} />}
          label="Show brand names"
          description="Shows the maker on each product and lets shoppers filter by it. Only useful if you record brands."
        >
          <Switch
            checked={form.showBrands}
            onChange={(next) => patch({ showBrands: next })}
            label="Show brand names"
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
        title="Holding stock"
        description="What a placed order keeps off the shelf while it waits for you."
      >
        <div className="flex flex-col gap-4 px-6 py-4">
          <div className="max-w-xs">
            <Field
              label="Hold stock for"
              hint="Minutes. An order keeps its items out of the shop's available count until you accept it or this lapses. 0 turns holding off."
            >
              <NumberInput
                value={form.holdMinutes}
                min={0}
                max={10080}
                className="w-24"
                onChange={(e) => patch({ holdMinutes: Number(e.target.value) || 0 })}
              />
            </Field>
          </div>

          <Callout
            tone="neutral"
            title={
              form.holdMinutes > 0
                ? 'Nothing is taken off your stock figures'
                : 'Two shoppers can be promised the same item'
            }
          >
            {form.holdMinutes > 0
              ? 'A hold only changes what the shop advertises. Your stock on hand, your movements and your reconciliation are untouched — the goods are still yours until you accept the order and it becomes a sale.'
              : 'With holding off, the shop shows everything you have to every shopper. Two people can order the last one within the same minute, and you will find out when you come to accept the second.'}
          </Callout>
        </div>
      </SettingGroup>

      {/* Its own group rather than another display switch: this one sends mail
          to people, which is a different kind of decision from whether a tile
          shows a photograph. */}
      <SettingGroup
        title="Abandoned baskets"
        description="Shoppers can save a basket and be reminded about it once."
      >
        <SettingRow
          icon={<Icons.Mail size={18} />}
          label="Remind shoppers about a saved basket"
          description="Adds a “save my basket” box to the basket panel. Anyone who uses it gets ONE email if they do not come back — never a second, and never anyone who did not ask. Off by default."
        >
          <Switch
            checked={form.basketReminders}
            onChange={(next) => patch({ basketReminders: next })}
            label="Remind shoppers about a saved basket"
          />
        </SettingRow>

        {/* Only once the feature is on. A delay and a message for something
            switched off are two controls that cannot do anything. */}
        {form.basketReminders && (
          <div className="flex flex-col gap-4 px-6 py-4">
            <div className="max-w-xs">
              <Field
                label="Wait this long first"
                hint="Hours of no activity before the reminder goes out. Too short and you chase someone who is still shopping."
              >
                <NumberInput
                  value={form.basketReminderHours}
                  min={1}
                  max={168}
                  className="w-24"
                  onChange={(e) => patch({ basketReminderHours: Number(e.target.value) || 4 })}
                />
              </Field>
            </div>

            <Field
              label="What the email says"
              hint="Left empty, it says they left some shopping behind. The items, the total and the link are added for you."
            >
              <Textarea
                value={form.basketReminderNote}
                rows={2}
                maxLength={500}
                placeholder="e.g. Still thinking it over? Your basket is waiting."
                onChange={(e) => patch({ basketReminderNote: e.target.value })}
              />
            </Field>

            <Callout tone="neutral" title="This needs the reminder job running">
              Your host must call the basket sweep on a schedule with{' '}
              <code>BASKET_CRON_SECRET</code> set. Without it, baskets are still saved and can
              still be recovered from a link — no reminders are sent.
            </Callout>
          </div>
        )}
      </SettingGroup>

      <SettingGroup
        title="How your store introduces itself"
        description="Shown when your link is shared and in search results."
      >
        <div className="px-6 py-4">
          <Field
            label="Your shop's web address"
            hint="Only needed if you have your own domain pointing at this shop, e.g. shop.example.co.za. It tells search engines which address to list — paste the whole URL if it is easier, we'll tidy it."
          >
            <Input
              value={form.publicDomain}
              placeholder="shop.example.co.za"
              onChange={(e) => patch({ publicDomain: e.target.value })}
            />
          </Field>
        </div>
      </SettingGroup>

      <SettingGroup
        title="Your welcome message"
        description="One line describing the shop, used when your link is shared."
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
