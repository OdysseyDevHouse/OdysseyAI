'use client'

import { useRouter } from 'next/navigation'
import {
  Badge,
  Button,
  Card,
  Field,
  Icons,
  Input,
  Select,
  Tabs,
  ToolbarSearch,
  type BadgeTone,
} from '@/components/ui'

type EventRow = {
  id: number
  entity: string
  entityId: number | null
  action: string
  detail: string | null
  changes: Record<string, { from: unknown; to: unknown }> | null
  userName: string
  userId: number | null
  at: string
}

type SignInRow = {
  id: number
  email: string
  event: string
  ip: string | null
  at: string
}

const SIGNIN_TONE: Record<string, BadgeTone> = {
  success: 'success',
  failed: 'danger',
  locked: 'warning',
  totp_failed: 'danger',
}

const SIGNIN_LABEL: Record<string, string> = {
  success: 'Signed in',
  failed: 'Wrong password',
  locked: 'Locked out',
  totp_failed: 'Wrong 2FA code',
}

export default function AuditScreen({
  events,
  hasMore,
  actors,
  signIns,
  tab,
  filter,
}: {
  events: EventRow[]
  hasMore: boolean
  actors: Array<{ userId: number | null; userName: string }>
  signIns: SignInRow[]
  tab: 'activity' | 'signins'
  filter: { entity: string; user: string; q: string; from: string; to: string }
}) {
  const router = useRouter()

  const go = (next: Partial<typeof filter & { tab: string; beforeAt: string; beforeId: string }>) => {
    const merged = { tab, ...filter, ...next }
    const params = new URLSearchParams()
    if (merged.tab !== 'activity') params.set('tab', merged.tab)
    for (const key of ['entity', 'user', 'q', 'from', 'to'] as const) {
      if (merged[key]) params.set(key, merged[key])
    }
    if ('beforeAt' in next && next.beforeAt) {
      params.set('beforeAt', next.beforeAt)
      params.set('beforeId', String(next.beforeId))
    }
    router.push(`/setup/audit${params.size ? `?${params.toString()}` : ''}`)
  }

  const oldest = events.at(-1)

  return (
    <>
      <Tabs
        aria-label="Which trail"
        value={tab}
        onChange={(next) => go({ tab: next })}
        items={[
          { value: 'activity', label: 'Activity' },
          { value: 'signins', label: 'Sign-ins' },
        ]}
      />

      {tab === 'activity' ? (
        <>
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-56 flex-1">
              <ToolbarSearch
                value={filter.q}
                onChange={(value) => go({ q: value })}
                placeholder="Action or wording…"
                aria-label="Search the trail"
              />
            </div>
            <Field label="Who">
              <Select value={filter.user} onChange={(e) => go({ user: e.target.value })}>
                <option value="">Everyone</option>
                {actors.map((actor) => (
                  <option key={`${actor.userId}-${actor.userName}`} value={String(actor.userId ?? '')}>
                    {actor.userName || 'System'}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="From">
              <Input type="date" value={filter.from} onChange={(e) => go({ from: e.target.value })} />
            </Field>
            <Field label="To">
              <Input type="date" value={filter.to} onChange={(e) => go({ to: e.target.value })} />
            </Field>
          </div>

          <Card>
            {events.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-muted">
                Nothing in the trail matches those filters.
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {events.map((event) => (
                  <li key={event.id} className="flex flex-col gap-1 px-4 py-2.5">
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <Badge tone="neutral">{event.entity}</Badge>
                      <span className="font-medium text-ink">{event.action}</span>
                      <span className="ml-auto shrink-0 text-xs text-muted">
                        {event.userName || 'System'} · {new Date(event.at).toLocaleString('en-ZA')}
                      </span>
                    </div>
                    {event.detail && <p className="text-sm text-ink-2">{event.detail}</p>}
                    {event.changes && (
                      <dl className="flex flex-col gap-0.5 text-xs text-muted">
                        {Object.entries(event.changes).map(([field, change]) => (
                          <div key={field} className="flex flex-wrap gap-1.5">
                            <dt className="font-medium text-ink-2">{field}:</dt>
                            <dd>
                              {String(change.from ?? '—')} → {String(change.to ?? '—')}
                            </dd>
                          </div>
                        ))}
                      </dl>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {hasMore && oldest && (
            <div className="flex justify-center">
              <Button
                variant="secondary"
                onClick={() =>
                  go({
                    beforeAt: oldest.at.slice(0, 19).replace('T', ' '),
                    beforeId: String(oldest.id),
                  })
                }
              >
                <Icons.ChevronDown size={15} />
                Show older
              </Button>
            </div>
          )}
        </>
      ) : (
        <Card>
          {signIns.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-muted">
              No sign-ins recorded yet — the log starts from when this screen shipped.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {signIns.map((row) => (
                <li key={row.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-sm">
                  <Badge tone={SIGNIN_TONE[row.event] ?? 'neutral'} dot>
                    {SIGNIN_LABEL[row.event] ?? row.event}
                  </Badge>
                  <span className="min-w-0 flex-1 truncate text-ink">{row.email}</span>
                  {row.ip && <span className="numeric text-xs text-muted">{row.ip}</span>}
                  <span className="shrink-0 text-xs text-muted">
                    {new Date(row.at).toLocaleString('en-ZA')}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </>
  )
}
