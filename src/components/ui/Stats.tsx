import type { ReactNode } from 'react'
import Link from 'next/link'
import { Card } from './Card'
import { CONTROL, CONTROL_H } from './styles'

/** A single headline number — takings, stock value, count of something. */
export function StatTile({
  label,
  value,
  hint,
  tone = 'default',
  icon,
  href,
}: {
  label: string
  value: string
  hint?: string
  tone?: 'default' | 'positive' | 'warning' | 'danger'
  /** Tinted glyph in the corner. Keep it to the tile's subject, not decoration. */
  icon?: ReactNode
  /**
   * Makes the whole tile a link — "12 over limit" should go to that filtered
   * list. A figure you cannot drill into is a dead end on a dashboard.
   */
  href?: string
}) {
  const toneClass = {
    default: 'text-ink',
    positive: 'text-success',
    warning: 'text-warning',
    danger: 'text-danger',
  }[tone]

  const body = (
    <>
      <div className="flex items-start justify-between gap-2">
        <div className="text-xs font-medium text-muted">{label}</div>
        {icon && <span className={`shrink-0 ${toneClass} opacity-60`}>{icon}</span>}
      </div>
      <div className={`numeric mt-1.5 text-2xl font-semibold ${toneClass}`}>{value}</div>
      {hint && <div className="mt-1 text-xs text-muted">{hint}</div>}
    </>
  )

  if (href) {
    return (
      <Card className="p-0">
        <Link href={href} className="block rounded-card p-4 transition hover:bg-surface-2">
          {body}
        </Link>
      </Card>
    )
  }

  return <Card className="p-4">{body}</Card>
}

/**
 * Search box that submits on Enter via a plain GET — no client JS needed, so
 * server-rendered list pages can search without becoming Client Components.
 * For a client-side filtered list, use <ToolbarSearch> instead.
 *
 * `keep` matters more than it looks: a GET form submits ONLY its own fields, so
 * without it a search wipes every other filter in the URL. Pass the params the
 * screen wants to survive a search and they ride along as hidden inputs.
 */
export function SearchBar({
  action,
  defaultValue,
  placeholder,
  name = 'q',
  keep,
}: {
  action: string
  defaultValue?: string
  placeholder: string
  /** Query key to write. Only change it on a screen with two search boxes. */
  name?: string
  /** Other params to carry through the submit, e.g. `{ status: 'on_hold' }`. */
  keep?: Record<string, string | number | null | undefined>
}) {
  return (
    <form action={action} className="px-6 py-3">
      {keep &&
        Object.entries(keep).map(([key, value]) =>
          value === null || value === undefined || value === '' ? null : (
            <input key={key} type="hidden" name={key} value={String(value)} />
          ),
        )}
      <input
        type="search"
        name={name}
        defaultValue={defaultValue}
        placeholder={placeholder}
        className={`${CONTROL} ${CONTROL_H} max-w-md`}
      />
    </form>
  )
}
