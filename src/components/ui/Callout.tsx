import type { ReactNode } from 'react'
import { StatusError, StatusInfo, StatusSuccess, StatusWarning } from './icons'

/**
 * Callout — the inline notice: "this document is cancelled", "mail is not
 * configured", "posting is blocked until the period opens".
 *
 * Before this existed every screen hand-rolled its own banner (an audit found
 * ~36 of them in four different visual dialects, several using the non-token
 * `rounded-md` and `bg-danger/10`). Use this instead, always.
 *
 * Tone follows meaning, same as Badge: danger = blocked/destructive/broken,
 * warning = needs attention before something else can happen, success = a
 * good outcome worth confirming, brand = informational, neutral = plain note.
 * One Callout per condition — and if several conditions hold at once, show
 * the most severe one rather than stacking four banners above the content.
 */
export type CalloutTone = 'neutral' | 'brand' | 'success' | 'warning' | 'danger'

const TONE: Record<CalloutTone, { box: string; icon: string; defaultIcon: ReactNode }> = {
  neutral: {
    box: 'border-border bg-surface-2',
    icon: 'text-muted',
    defaultIcon: <StatusInfo size={18} />,
  },
  brand: {
    box: 'border-brand/30 bg-brand-soft',
    icon: 'text-brand',
    defaultIcon: <StatusInfo size={18} />,
  },
  success: {
    box: 'border-success/30 bg-success-soft',
    icon: 'text-success',
    defaultIcon: <StatusSuccess size={18} />,
  },
  warning: {
    box: 'border-warning/30 bg-warning-soft',
    icon: 'text-warning',
    defaultIcon: <StatusWarning size={18} />,
  },
  danger: {
    box: 'border-danger/30 bg-danger-soft',
    icon: 'text-danger',
    defaultIcon: <StatusError size={18} />,
  },
}

export function Callout({
  tone = 'neutral',
  title,
  icon,
  action,
  children,
  className = '',
}: {
  tone?: CalloutTone
  /** The one-line headline. Bold; keep it to the condition itself. */
  title?: ReactNode
  /** Override the tone's default glyph. Pass null to drop the icon. */
  icon?: ReactNode | null
  /** A button or link that resolves the condition — "Open settings". */
  action?: ReactNode
  /** The explanation. Say what happened AND what fixes it. */
  children?: ReactNode
  className?: string
}) {
  const spec = TONE[tone]
  return (
    <div
      role={tone === 'danger' ? 'alert' : undefined}
      className={`flex items-start gap-3 rounded-card border px-4 py-3.5 ${spec.box} ${className}`}
    >
      {icon !== null && (
        <span className={`mt-0.5 shrink-0 ${spec.icon}`}>{icon ?? spec.defaultIcon}</span>
      )}
      <div className="min-w-0 flex-1 text-sm">
        {title && <p className="font-medium text-ink">{title}</p>}
        {children && <div className={`text-ink-2 ${title ? 'mt-0.5' : ''}`}>{children}</div>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  )
}
