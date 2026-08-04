import { Card } from './Card'

/** A single headline number — takings, stock value, count of something. */
export function StatTile({
  label,
  value,
  hint,
  tone = 'default',
}: {
  label: string
  value: string
  hint?: string
  tone?: 'default' | 'positive' | 'warning' | 'danger'
}) {
  const toneClass = {
    default: 'text-ink',
    positive: 'text-success',
    warning: 'text-warning',
    danger: 'text-danger',
  }[tone]

  return (
    <Card className="p-4">
      <div className="text-xs font-medium text-muted">{label}</div>
      <div className={`numeric mt-1.5 text-2xl font-semibold ${toneClass}`}>{value}</div>
      {hint && <div className="mt-1 text-xs text-muted">{hint}</div>}
    </Card>
  )
}

/**
 * Search box that submits on Enter via a plain GET — no client JS needed, so
 * server-rendered list pages can search without becoming Client Components.
 * For a client-side filtered list, use <ToolbarSearch> instead.
 */
export function SearchBar({
  action,
  defaultValue,
  placeholder,
}: {
  action: string
  defaultValue?: string
  placeholder: string
}) {
  return (
    <form action={action} className="px-6 py-3">
      <input
        type="search"
        name="q"
        defaultValue={defaultValue}
        placeholder={placeholder}
        className="w-full max-w-md rounded-control border border-border-strong bg-surface px-3 py-2 text-sm text-ink placeholder:text-faint outline-none focus:border-brand"
      />
    </form>
  )
}
