'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  Badge,
  Card,
  CardBody,
  DataTable,
  Field,
  Select,
  StatStrip,
  StatTile,
  Tabs,
  type Column,
} from '@/components/ui'
import { formatMoney, formatQty } from '@/lib/decimals'
import type {
  StockAgeReport,
  AgeBandRow,
  StaleProductRow,
  AbcReport,
  AbcRow,
  StockTurnReport,
  StockTurnRow,
  SellThroughReport,
  SellThroughRow,
} from '@/lib/site/stockIntelligence'

type Tab = 'age' | 'abc' | 'turn' | 'sell'

const WINDOW_OPTIONS = [
  { value: '30', label: 'Last 30 days' },
  { value: '60', label: 'Last 60 days' },
  { value: '90', label: 'Last 90 days' },
  { value: '180', label: 'Last 180 days' },
  { value: '365', label: 'Last year' },
]

export default function StockIntelClient({
  age,
  abc,
  turn,
  sell,
  windowDays,
}: {
  age: StockAgeReport
  abc: AbcReport
  turn: StockTurnReport
  sell: SellThroughReport
  windowDays: number
}) {
  const router = useRouter()
  const [tab, setTab] = useState<Tab>('age')

  const staleValue = age.bands
    .filter((b) => b.key === 'b180' || b.key === 'b365' || b.key === 'older' || b.key === 'unknown')
    .reduce((sum, b) => sum + b.value, 0)
  const freshValue = age.bands
    .filter((b) => b.key === 'b30' || b.key === 'b60')
    .reduce((sum, b) => sum + b.value, 0)

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <Tabs
          aria-label="Which question"
          value={tab}
          onChange={setTab}
          items={[
            { value: 'age', label: 'Stock age' },
            { value: 'abc', label: 'ABC classes' },
            { value: 'turn', label: 'Stock turn' },
            { value: 'sell', label: 'Sell-through' },
          ]}
        />
        {tab !== 'age' && (
          <Field label="Window">
            <Select
              value={String(windowDays)}
              onChange={(e) => router.push(`/reports/stock-intel?days=${e.target.value}`)}
            >
              {WINDOW_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
        )}
      </div>

      {tab === 'age' && (
        <>
          <StatStrip columns={3}>
            <StatTile label="Stock at cost" value={formatMoney(age.totalValue)} />
            <StatTile
              label="Older than 180 days"
              value={formatMoney(staleValue)}
              tone={staleValue > 0 ? 'warning' : 'default'}
              hint="The capital going stale"
            />
            <StatTile label="Fresh (under 60 days)" value={formatMoney(freshValue)} />
          </StatStrip>
          <Card>
            <CardBody>
              <DataTable<AgeBandRow>
                columns={BAND_COLUMNS}
                rows={age.bands}
                getRowKey={(r) => r.key}
                empty={{ title: 'No stock on hand', hint: 'Nothing to age yet.' }}
              />
            </CardBody>
          </Card>
          <Card>
            <CardBody>
              <DataTable<StaleProductRow>
                columns={STALE_COLUMNS}
                rows={age.stale}
                getRowKey={(r) => r.productId}
                empty={{
                  title: 'Nothing older than 90 days',
                  hint: 'Every layer of the pile arrived within the last quarter.',
                }}
              />
            </CardBody>
          </Card>
        </>
      )}

      {tab === 'abc' && (
        <>
          <StatStrip columns={3}>
            {abc.summary.map((s) => (
              <StatTile
                key={s.cls}
                label={`Class ${s.cls}`}
                value={formatMoney(s.value)}
                hint={`${s.products} product${s.products === 1 ? '' : 's'} · ${s.sharePct.toFixed(1)}% of consumption`}
              />
            ))}
          </StatStrip>
          <Card>
            <CardBody>
              <DataTable<AbcRow>
                columns={ABC_COLUMNS}
                rows={abc.rows}
                getRowKey={(r) => r.productId}
                empty={{
                  title: 'Nothing sold in this window',
                  hint: 'Widen the window, or come back once there are sales to rank.',
                }}
              />
            </CardBody>
          </Card>
        </>
      )}

      {tab === 'turn' && (
        <Card>
          <CardBody>
            <DataTable<StockTurnRow>
              columns={TURN_COLUMNS}
              rows={turn.rows}
              getRowKey={(r) => r.department}
              empty={{
                title: 'Nothing to measure',
                hint: 'Turn needs both stock on the shelf and sales in the window.',
              }}
            />
          </CardBody>
        </Card>
      )}

      {tab === 'sell' && (
        <Card>
          <CardBody>
            <DataTable<SellThroughRow>
              columns={SELL_COLUMNS}
              rows={sell.rows}
              getRowKey={(r) => r.department}
              empty={{
                title: 'Nothing moved in this window',
                hint: 'Sell-through needs sales or receipts to compare.',
              }}
            />
          </CardBody>
        </Card>
      )}
    </>
  )
}

/* ── columns ───────────────────────────────────────────────────────────── */

const BAND_COLUMNS: readonly Column<AgeBandRow>[] = [
  { key: 'label', header: 'Age of stock', cell: (r) => r.label },
  { key: 'products', header: 'Products', cell: (r) => String(r.products), numeric: true },
  { key: 'qty', header: 'Units', cell: (r) => formatQty(r.qty), numeric: true, sortValue: (r) => r.qty },
  {
    key: 'value',
    header: 'Value at cost',
    cell: (r) => formatMoney(r.value),
    numeric: true,
    sortValue: (r) => r.value,
  },
]

const STALE_COLUMNS: readonly Column<StaleProductRow>[] = [
  { key: 'code', header: 'Code', cell: (r) => r.code ?? '—', width: 'w-32' },
  { key: 'description', header: 'Product', cell: (r) => r.description },
  { key: 'department', header: 'Department', cell: (r) => r.department },
  { key: 'onHand', header: 'On hand', cell: (r) => formatQty(r.onHand), numeric: true, sortValue: (r) => r.onHand },
  {
    key: 'staleQty',
    header: 'Stale units',
    cell: (r) => formatQty(r.staleQty),
    numeric: true,
    sortValue: (r) => r.staleQty,
  },
  {
    key: 'staleValue',
    header: 'Stale value',
    cell: (r) => formatMoney(r.staleValue),
    numeric: true,
    sortValue: (r) => r.staleValue,
  },
  {
    key: 'oldestDays',
    header: 'Oldest layer',
    cell: (r) => (r.oldestDays === null ? 'Before records' : `${r.oldestDays} days`),
    numeric: true,
    sortValue: (r) => r.oldestDays ?? Number.MAX_SAFE_INTEGER,
  },
]

const ABC_TONE = { A: 'success', B: 'brand', C: 'neutral' } as const

const ABC_COLUMNS: readonly Column<AbcRow>[] = [
  {
    key: 'cls',
    header: 'Class',
    cell: (r) => <Badge tone={ABC_TONE[r.cls]}>{r.cls}</Badge>,
    sortValue: (r) => r.cls,
    width: 'w-20',
  },
  { key: 'code', header: 'Code', cell: (r) => r.code ?? '—', width: 'w-32' },
  { key: 'description', header: 'Product', cell: (r) => r.description },
  { key: 'department', header: 'Department', cell: (r) => r.department },
  {
    key: 'unitsSold',
    header: 'Units sold',
    cell: (r) => formatQty(r.unitsSold),
    numeric: true,
    sortValue: (r) => r.unitsSold,
  },
  {
    key: 'value',
    header: 'Consumption at cost',
    cell: (r) => formatMoney(r.value),
    numeric: true,
    sortValue: (r) => r.value,
  },
  {
    key: 'sharePct',
    header: 'Share',
    cell: (r) => `${r.sharePct.toFixed(1)}%`,
    numeric: true,
    sortValue: (r) => r.sharePct,
  },
]

const TURN_COLUMNS: readonly Column<StockTurnRow>[] = [
  { key: 'department', header: 'Department', cell: (r) => r.department },
  {
    key: 'stockValue',
    header: 'Stock at cost',
    cell: (r) => formatMoney(r.stockValue),
    numeric: true,
    sortValue: (r) => r.stockValue,
  },
  { key: 'cogs', header: 'Sold at cost', cell: (r) => formatMoney(r.cogs), numeric: true, sortValue: (r) => r.cogs },
  {
    key: 'turn',
    header: 'Turns per year',
    cell: (r) => (r.turn === null ? '—' : r.turn.toFixed(1)),
    numeric: true,
    sortValue: (r) => r.turn ?? -1,
  },
  {
    key: 'daysOfStock',
    header: 'Days of stock',
    cell: (r) => (r.daysOfStock === null ? '—' : String(Math.round(r.daysOfStock))),
    numeric: true,
    sortValue: (r) => r.daysOfStock ?? -1,
  },
]

const SELL_COLUMNS: readonly Column<SellThroughRow>[] = [
  { key: 'department', header: 'Department', cell: (r) => r.department },
  {
    key: 'unitsReceived',
    header: 'Units received',
    cell: (r) => formatQty(r.unitsReceived),
    numeric: true,
    sortValue: (r) => r.unitsReceived,
  },
  {
    key: 'unitsSold',
    header: 'Units sold',
    cell: (r) => formatQty(r.unitsSold),
    numeric: true,
    sortValue: (r) => r.unitsSold,
  },
  {
    key: 'unitsOnHand',
    header: 'Still on hand',
    cell: (r) => formatQty(r.unitsOnHand),
    numeric: true,
    sortValue: (r) => r.unitsOnHand,
  },
  {
    key: 'sellThroughPct',
    header: 'Sell-through',
    cell: (r) => (r.sellThroughPct === null ? '—' : `${r.sellThroughPct.toFixed(1)}%`),
    numeric: true,
    sortValue: (r) => r.sellThroughPct ?? -1,
  },
]
