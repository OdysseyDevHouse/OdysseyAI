import { requireSiteUser } from '@/lib/auth'
import { can } from '@/lib/site/permissions'
import { accountForSite, currentPrices, MODULE_KEYS, MODULE_LABELS, type ModuleKey } from '@/lib/control/modules'
import { MODULE_DESCRIPTIONS } from '@/lib/control/moduleMessages'
import { formatMoney } from '@/lib/decimals'
import { PageHeader, PageBody, Card, CardBody, ButtonLink, Icons, Badge } from '@/components/ui'

export const dynamic = 'force-dynamic'

/**
 * Where a MODULE check sends someone.
 *
 * Deliberately not /not-allowed. A permission refusal and a plan refusal look
 * identical to whoever hits them and are fixed by entirely different people —
 * one by whoever manages roles, the other by whoever pays the bill. Merging the
 * two pages would send half of each group to the wrong person.
 *
 * So this page answers three things the other one cannot: what the feature
 * actually is, what it costs, and — depending on who is reading — either a
 * button that adds it or the name of the person who can.
 */
export default async function UpgradePage({
  searchParams,
}: {
  searchParams: Promise<{ module?: string }>
}) {
  const { site, capabilities } = await requireSiteUser()
  const params = await searchParams

  const key = isModuleKey(params.module) ? params.module : null
  const canManageBilling = can(capabilities, 'setup.edit')

  const [account, prices] = await Promise.all([accountForSite(site.id), currentPrices()])
  const price = key ? prices[key] : undefined

  return (
    <>
      <PageHeader
        title={key ? MODULE_LABELS[key] : 'Not in your plan'}
        subtitle={
          key
            ? `${MODULE_LABELS[key]} is not part of this store’s plan`
            : 'That feature is not part of this store’s plan'
        }
      />

      <PageBody>
        <Card>
          <CardBody className="flex items-start gap-3">
            <Icons.Lock size={20} className="mt-0.5 shrink-0 text-brand" />
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1">
                <p className="font-medium text-ink">
                  {key
                    ? `${MODULE_LABELS[key]} has not been added to ${site.displayName}.`
                    : `That feature has not been added to ${site.displayName}.`}
                </p>
                {key ? <p className="text-sm text-muted">{MODULE_DESCRIPTIONS[key]}</p> : null}
              </div>

              {/* Only shown when the price book has a real figure. A module
                  seeded at zero is unpriced, not free, and saying "R0.00 per
                  month" would be a promise nobody meant to make. */}
              {price ? (
                <div className="flex items-center gap-2">
                  <span className="numeric text-lg font-semibold text-ink">
                    {formatMoney(price)}
                  </span>
                  <span className="text-sm text-muted">per store, per month</span>
                </div>
              ) : null}

              <div className="flex flex-col gap-2">
                {canManageBilling ? (
                  <div className="flex flex-wrap gap-2">
                    <ButtonLink href="/setup/billing" variant="primary">
                      {key ? `Add ${MODULE_LABELS[key]}` : 'Open plan & billing'}
                    </ButtonLink>
                    <ButtonLink href="/dashboard" variant="secondary">
                      Back to the dashboard
                    </ButtonLink>
                  </div>
                ) : (
                  <>
                    <p className="text-sm text-muted">
                      {/* Naming the person is the point. "Contact your
                          administrator" is what a message says when it does not
                          know, and it leaves the reader exactly where they
                          started. */}
                      {account?.billingContact
                        ? `${account.billingContact} looks after billing for this account and can add it under Setup → Plan & billing.`
                        : 'An owner can add it under Setup → Plan & billing.'}
                      {account?.billingEmail ? ` (${account.billingEmail})` : ''}
                    </p>
                    <div>
                      <ButtonLink href="/dashboard" variant="primary">
                        Back to the dashboard
                      </ButtonLink>
                    </div>
                  </>
                )}
              </div>
            </div>
          </CardBody>
        </Card>

        {/* What else could be added, for somebody who arrived here wondering
            what the plan covers. Only for the person who can act on it. */}
        {canManageBilling ? (
          <Card>
            <CardBody className="flex flex-col gap-3">
              <p className="text-sm font-medium text-ink">Other modules</p>
              <ul className="flex flex-col gap-2">
                {MODULE_KEYS.filter((k) => k !== 'starter' && k !== key).map((k) => (
                  <li key={k} className="flex items-start justify-between gap-4">
                    <div className="flex flex-col">
                      <span className="text-sm font-medium text-ink-2">{MODULE_LABELS[k]}</span>
                      <span className="text-sm text-muted">{MODULE_DESCRIPTIONS[k]}</span>
                    </div>
                    {prices[k] ? (
                      <Badge tone="neutral">{formatMoney(prices[k])}/mo</Badge>
                    ) : null}
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>
        ) : null}
      </PageBody>
    </>
  )
}

function isModuleKey(value: string | undefined): value is ModuleKey {
  return value !== undefined && (MODULE_KEYS as readonly string[]).includes(value)
}
