import { Fragment } from 'react'
import { redirect } from 'next/navigation'
import { requireSiteUser } from '@/lib/auth'
import { can } from '@/lib/site/permissions'
import { has } from '@/lib/control/modules'
import {
  groupScopeFor,
  consolidatedBalanceSheet,
  type ConsolidatedBlock,
} from '@/lib/groupReporting'
import { formatMoney } from '@/lib/decimals'
import { today } from '@/lib/site/ledger'
import { hrefBuilder } from '@/lib/searchParams'
import {
  PageHeader,
  PageBody,
  Card,
  CardHeader,
  CardBody,
  StatStrip,
  StatTile,
  EmptyState,
  Badge,
  ButtonLink,
  LinkTabs,
  Callout,
  Icons,
  TABLE,
  TABLE_HEAD_ROW,
  TABLE_TH,
  TABLE_TD,
  TABLE_ROW,
  TABLE_NUMERIC,
  TABLE_TOTAL_ROW,
} from '@/components/ui'

export const dynamic = 'force-dynamic'

/**
 * One balance sheet across every linked store, at a date.
 *
 * The same merge the consolidated P&L uses — by account code, dash where a
 * store's chart lacks the account — applied to what is owned and owed. Together
 * they are the financial set a group needs at month end.
 *
 * A SIMPLE consolidation, and the footer says so: balances between linked stores
 * are not eliminated, so a loan from one store to another appears twice, once as
 * a receivable and once as a payable.
 */
export default async function MultiStoreBalanceSheetPage({
  searchParams,
}: {
  searchParams: Promise<{ asAt?: string; period?: string }>
}) {
  const { site, user, capabilities, modules } = await requireSiteUser()
  /* Module before capability: "your shop has not bought Multi-Branch" and
     "your role does not include this" are fixed by different people. */
  if (!has(modules, 'multi_branch')) redirect('/upgrade?module=multi_branch')

  // A hidden menu entry is not a boundary — this URL is typeable.
  if (!can(capabilities, 'reports.financial')) redirect('/not-allowed')
  if (user.controlUserId === null) redirect('/not-allowed')

  const scope = await groupScopeFor(site.id, user.controlUserId, 'reports.financial')

  if (!scope || scope.sites.length === 0) {
    return (
      <>
        <PageHeader title="Multi-store balance sheet" subtitle="What the group owns and owes" />
        <PageBody>
          <Card>
            <CardBody>
              <EmptyState
                title="This store is not linked to any others"
                hint="Link stores together to consolidate their statements. Linking lives under Setup."
                action={<ButtonLink href="/setup/linked-stores" variant="secondary">Open linked stores</ButtonLink>}
              />
            </CardBody>
          </Card>
        </PageBody>
      </>
    )
  }

  const params = await searchParams
  const now = today()
  const preset = params.period ?? 'today'
  const presets: Record<string, { asAt: string; label: string }> = {
    today: { asAt: now, label: 'Today' },
    monthEnd: { asAt: lastDayOfPreviousMonth(now), label: 'Last month end' },
    yearStart: { asAt: `${Number(now.slice(0, 4)) - 1}-12-31`, label: 'Last year end' },
  }
  const chosen = presets[preset] ?? presets.today
  const asAt = /^\d{4}-\d{2}-\d{2}$/.test(params.asAt ?? '') ? params.asAt! : chosen.asAt

  const href = hrefBuilder('/reports/multi-store-balance-sheet', params)
  const sheet = await consolidatedBalanceSheet(scope.sites, asAt)
  const columns = sheet.sites
  const hasAnything = sheet.assetsTotal !== 0 || sheet.liabilitiesTotal !== 0

  return (
    <>
      <PageHeader
        title="Multi-store balance sheet"
        subtitle={`${scope.group.name} — as at ${asAt}`}
      />
      <PageBody>
        <LinkTabs
          items={Object.entries(presets).map(([key, p]) => ({
            value: key,
            label: p.label,
            href: href({ period: key, asAt: null }),
          }))}
          value={params.asAt ? 'custom' : preset}
          aria-label="As at"
        />

        <StatStrip columns={4}>
          <StatTile
            label="Assets"
            value={formatMoney(sheet.assetsTotal)}
            hint="What the group owns"
            icon={<Icons.Boxes size={20} />}
          />
          <StatTile
            label="Liabilities"
            value={formatMoney(sheet.liabilitiesTotal)}
            hint="What it owes"
            icon={<Icons.Scale size={20} />}
          />
          <StatTile
            label="Equity and reserves"
            value={formatMoney(sheet.totalEquityAndReserves)}
            hint={`Includes ${formatMoney(sheet.currentYearResult)} earned this year`}
            icon={<Icons.Coins size={20} />}
            iconTone="success"
          />
          <StatTile
            label={sheet.balanced ? 'In balance' : 'Out of balance'}
            value={sheet.balanced ? '✓' : formatMoney(Math.abs(sheet.outOfBalance))}
            hint={sheet.balanced ? 'Every ledger reconciles' : 'One store’s ledger does not balance'}
            tone={sheet.balanced ? 'positive' : 'danger'}
            icon={<Icons.StatusWarning size={20} />}
            iconTone={sheet.balanced ? 'positive' : 'danger'}
          />
        </StatStrip>

        {!sheet.balanced && (
          <Card>
            <CardBody>
              <Callout tone="danger" title="The consolidated sheet does not balance">
                A group balances when every store does, so this points at one store rather than at
                the consolidation. Open each store&apos;s own balance sheet to find it — the
                out-of-balance figure is {formatMoney(sheet.outOfBalance)}.
              </Callout>
            </CardBody>
          </Card>
        )}

        {sheet.failures.length > 0 && (
          <Card>
            <CardBody>
              <p className="text-sm">
                <Badge tone="warning">Some stores could not be read</Badge>
                <span className="ml-2 text-muted">
                  {sheet.failures.map((f) => `${f.name}: ${f.error}`).join('; ')} — their columns are
                  left out rather than shown as zero.
                </span>
              </p>
            </CardBody>
          </Card>
        )}

        {!hasAnything ? (
          <Card>
            <CardBody>
              <EmptyState
                title="Nothing posted as at this date"
                hint="The consolidated sheet is built from each store's general ledger."
              />
            </CardBody>
          </Card>
        ) : (
          <Card>
            <CardHeader
              tone="default"
              title="Balance sheet, by store"
              description="Accounts are matched across stores by their code. A dash means the account does not exist at that store."
            />
            <div className="overflow-x-auto">
              <table className={TABLE}>
                <thead>
                  <tr className={TABLE_HEAD_ROW}>
                    <th className={TABLE_TH}>Account</th>
                    {columns.map((c) => (
                      <th key={c.siteId} className={`${TABLE_TH} ${TABLE_NUMERIC}`}>
                        {c.name}
                      </th>
                    ))}
                    <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>Total</th>
                  </tr>
                </thead>
                <tbody>
                  <Section blocks={sheet.assets} columnCount={columns.length} />
                  <Subtotal
                    label="Total assets"
                    perSite={sheet.perSiteAssets}
                    total={sheet.assetsTotal}
                    strong
                  />

                  <Section blocks={sheet.liabilities} columnCount={columns.length} />
                  <Subtotal
                    label="Total liabilities"
                    perSite={sumBlocks(sheet.liabilities, columns.length)}
                    total={sheet.liabilitiesTotal}
                  />

                  <Section blocks={sheet.equity} columnCount={columns.length} />
                  {/* The unclosed result has no account of its own — it is this
                      year's profit, not yet journalled to retained earnings. */}
                  <tr className={TABLE_ROW}>
                    <td className={`${TABLE_TD} pl-8`}>
                      <span className="text-ink-2">Profit for the year</span>
                      <span className="ml-2 text-xs text-muted">not yet closed</span>
                    </td>
                    <td className={TABLE_TD} colSpan={columns.length} />
                    <td className={`${TABLE_TD} ${TABLE_NUMERIC} font-medium`}>
                      {formatMoney(sheet.currentYearResult)}
                    </td>
                  </tr>
                  <Subtotal
                    label="Total equity and reserves"
                    perSite={sumBlocks(sheet.equity, columns.length)}
                    total={sheet.totalEquityAndReserves}
                    strong
                    highlight
                  />
                </tbody>
              </table>
            </div>
          </Card>
        )}

        <Card>
          <CardBody>
            <p className="text-sm text-muted">
              This is a simple sum of each store&apos;s own balance sheet, matched by account code.
              Balances between linked stores are not eliminated, so money one store owes another
              appears twice — once as a receivable and once as a payable.
            </p>
          </CardBody>
        </Card>
      </PageBody>
    </>
  )
}

/** The last day of the month before this one — a common reporting date. */
function lastDayOfPreviousMonth(iso: string): string {
  const firstOfThis = `${iso.slice(0, 7)}-01`
  const d = new Date(`${firstOfThis}T00:00:00Z`)
  d.setUTCDate(0)
  return d.toISOString().slice(0, 10)
}

/** Column sums over a set of blocks, for a subtotal row. */
function sumBlocks(blocks: ConsolidatedBlock[], columnCount: number): number[] {
  const out = Array.from({ length: columnCount }, () => 0)
  for (const block of blocks) {
    block.perSiteTotals.forEach((v, i) => {
      out[i] = Math.round((out[i] + v) * 100) / 100
    })
  }
  return out
}

function Section({ blocks, columnCount }: { blocks: ConsolidatedBlock[]; columnCount: number }) {
  return (
    <>
      {blocks.map((block) => (
        <Fragment key={block.subtype ?? block.label}>
          <tr className="bg-surface-2">
            <td className={`${TABLE_TD} font-medium text-ink`} colSpan={columnCount + 2}>
              {block.label}
            </td>
          </tr>
          {block.lines.map((line) => (
            <tr key={line.accountCode} className={TABLE_ROW}>
              <td className={`${TABLE_TD} pl-8`}>
                <span className="text-ink-2">{line.name}</span>
                <span className="ml-2 text-xs text-muted">{line.accountCode}</span>
              </td>
              {line.perSite.map((amount, i) => (
                <td key={i} className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                  {amount === null ? <span className="text-faint">—</span> : formatMoney(amount)}
                </td>
              ))}
              <td className={`${TABLE_TD} ${TABLE_NUMERIC} font-medium`}>{formatMoney(line.total)}</td>
            </tr>
          ))}
        </Fragment>
      ))}
    </>
  )
}

function Subtotal({
  label,
  perSite,
  total,
  strong,
  highlight,
}: {
  label: string
  perSite: number[]
  total: number
  strong?: boolean
  highlight?: boolean
}) {
  return (
    <tr
      className={
        highlight
          ? 'border-t-4 border-double border-border bg-brand-soft font-medium text-ink'
          : TABLE_TOTAL_ROW
      }
    >
      <td className={`${TABLE_TD} ${strong ? 'font-semibold' : ''}`}>{label}</td>
      {perSite.map((amount, i) => (
        <td key={i} className={`${TABLE_TD} ${TABLE_NUMERIC} ${strong ? 'font-semibold' : ''}`}>
          {formatMoney(amount)}
        </td>
      ))}
      <td className={`${TABLE_TD} ${TABLE_NUMERIC} ${strong ? 'text-base font-semibold' : ''}`}>
        {formatMoney(total)}
      </td>
    </tr>
  )
}
