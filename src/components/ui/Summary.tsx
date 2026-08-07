import type { ReactNode } from 'react'

/**
 * SummaryList — the label/value column every totals panel repeats: subtotal,
 * VAT, discount, then a louder grand total. Three screens had copy-pasted
 * private `Row` helpers with three different total sizes; this is the one
 * spelling.
 *
 *   <SummaryList>
 *     <SummaryRow label="Subtotal" value={formatMoney(sub)} />
 *     <SummaryRow label="VAT" value={formatMoney(vat)} />
 *     <SummaryTotal label="Total" value={formatMoney(total)} />
 *   </SummaryList>
 */
export function SummaryList({
  children,
  className = '',
}: {
  children: ReactNode
  className?: string
}) {
  return <dl className={`flex flex-col gap-1.5 text-sm ${className}`}>{children}</dl>
}

const ROW_TONE = {
  default: 'text-ink-2',
  muted: 'text-muted',
  success: 'text-success-ink',
  warning: 'text-warning-ink',
  danger: 'text-danger-ink',
} as const

export function SummaryRow({
  label,
  value,
  tone = 'default',
}: {
  label: ReactNode
  value: ReactNode
  /** Colour marks exceptions — a negative margin, a discount given away. */
  tone?: keyof typeof ROW_TONE
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-muted">{label}</dt>
      <dd className={`numeric text-right ${ROW_TONE[tone]}`}>{value}</dd>
    </div>
  )
}

/** The grand total — the one number the panel exists to state. */
export function SummaryTotal({
  label,
  value,
  tone = 'default',
}: {
  label: ReactNode
  value: ReactNode
  tone?: 'default' | 'danger'
}) {
  return (
    <div className="mt-1.5 flex items-baseline justify-between gap-4 border-t border-border pt-2.5">
      <dt className="text-sm font-medium text-ink">{label}</dt>
      <dd
        className={`numeric text-right text-xl font-semibold ${
          tone === 'danger' ? 'text-danger' : 'text-ink'
        }`}
      >
        {value}
      </dd>
    </div>
  )
}
