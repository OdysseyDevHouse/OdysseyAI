import Link from 'next/link'
import { requireSiteUser } from '@/lib/auth'
import { listNotifications } from '@/lib/site/notifications'
import { Bell } from '@/components/ui/icons'
import { PageHeader, PageBody, Card, CardBody, EmptyState, Badge, Button } from '@/components/ui'
import { markAllReadAction } from './actions'

export const dynamic = 'force-dynamic'

/**
 * The full feed behind the bell's "See all" link.
 *
 * Session-only like /security — reached from the top bar, not the sidebar.
 * WHAT appears is decided per person inside the lib, from the same
 * capabilities every request already resolves.
 */
export default async function NotificationsPage() {
  const { site, user, capabilities } = await requireSiteUser()
  const items = await listNotifications(site.id, user.id, capabilities, { limit: 100 })
  const unread = items.filter((n) => n.readAt === null).length

  return (
    <>
      <PageHeader
        title="Notifications"
        subtitle="What the shop wants you to hear about"
        action={
          unread > 0 ? (
            <form action={markAllReadAction}>
              <Button type="submit" variant="secondary">
                Mark all read
              </Button>
            </form>
          ) : undefined
        }
      />
      <PageBody>
        <Card>
          {items.length === 0 ? (
            <CardBody>
              <EmptyState
                icon={<Bell size={28} strokeWidth={1.75} />}
                title="Nothing yet"
                hint="Online orders, voided sales, goods received and low-stock alerts will appear here as they happen."
              />
            </CardBody>
          ) : (
            <ul>
              {items.map((n) => {
                const inner = (
                  <div className="flex items-start gap-3 px-5 py-3.5 transition hover:bg-surface-2">
                    <span
                      aria-hidden
                      className={`mt-1.5 size-2 shrink-0 rounded-pill ${n.readAt ? 'bg-border' : 'bg-brand'}`}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-ink">{n.title}</p>
                      {n.body && <p className="truncate text-sm text-muted">{n.body}</p>}
                    </div>
                    <div className="shrink-0 text-right">
                      {n.readAt === null && <Badge tone="brand">New</Badge>}
                      <p className="mt-1 text-xs text-faint">
                        {n.createdAt instanceof Date
                          ? n.createdAt.toISOString().slice(0, 16).replace('T', ' ')
                          : String(n.createdAt)}
                      </p>
                    </div>
                  </div>
                )
                return (
                  <li key={n.id} className="border-b border-border last:border-b-0">
                    {n.href ? <Link href={n.href}>{inner}</Link> : inner}
                  </li>
                )
              })}
            </ul>
          )}
        </Card>
      </PageBody>
    </>
  )
}
