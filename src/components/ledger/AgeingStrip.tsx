import Link from 'next/link'
import { formatMoney } from '@/lib/decimals'
/* From agingBuckets, NOT from site/ledger — this component renders on both
   sides of the boundary now (the dashboard is a client tree), and ledger.ts is
   server-only. Same constants, re-exported there for existing callers. */
import { AGING_BUCKETS, BUCKET_LABELS, type Aging, type AgingBucket } from '@/lib/agingBuckets'

/**
 * Current / 30 / 60 / 90 / 120+ as one strip.
 *
 * Shared by debtors and creditors unchanged: bucketing a balance by how overdue
 * it is is accounting, and it does not care which direction the money flows.
 *
 * Buckets count days past the DUE date, not the document date — "30 days" means
 * thirty days late, which is what a collections call is about.
 */
export function AgeingStrip({
  aging,
  hrefFor,
  className = '',
}: {
  aging: Aging
  /** Makes each bucket a link into a filtered list. */
  hrefFor?: (bucket: AgingBucket) => string
  className?: string
}) {
  return (
    <div className={`grid grid-cols-3 gap-px overflow-hidden rounded-card bg-border sm:grid-cols-6 ${className}`}>
      {AGING_BUCKETS.map((bucket) => (
        <Cell
          key={bucket}
          label={BUCKET_LABELS[bucket]}
          value={aging[bucket]}
          /* Anything past 60 days is a collections problem, not a timing one. */
          tone={bucket === 'd90' || bucket === 'd120' ? 'danger' : bucket === 'd60' ? 'warning' : 'default'}
          href={hrefFor?.(bucket)}
        />
      ))}
      <Cell label="Total" value={aging.total} tone="total" />
    </div>
  )
}

function Cell({
  label,
  value,
  tone,
  href,
}: {
  label: string
  value: number
  tone: 'default' | 'warning' | 'danger' | 'total'
  href?: string
}) {
  const valueClass = {
    default: 'text-ink',
    warning: 'text-warning',
    danger: 'text-danger',
    total: 'text-ink font-semibold',
  }[tone]

  // A zero bucket is greyed rather than hidden: the shape of the strip must
  // stay the same between accounts, or the eye cannot compare two of them.
  const body = (
    <>
      <div className="text-xs text-muted">{label}</div>
      <div className={`numeric mt-1 text-sm ${value === 0 ? 'text-faint' : valueClass}`}>
        {formatMoney(value)}
      </div>
    </>
  )

  if (href && value !== 0) {
    return (
      <Link href={href} className="bg-surface px-3 py-2.5 transition hover:bg-surface-2">
        {body}
      </Link>
    )
  }

  return <div className={`px-3 py-2.5 ${tone === 'total' ? 'bg-surface-2' : 'bg-surface'}`}>{body}</div>
}
