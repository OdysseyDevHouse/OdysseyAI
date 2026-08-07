import { requireSiteUser } from '@/lib/auth'
import { PageHeader, PageBody, Card, CardBody, ButtonLink, Icons } from '@/components/ui'

export const dynamic = 'force-dynamic'

/**
 * Where a capability check sends someone.
 *
 * A real page rather than a 404, because the two mean different things: "this
 * does not exist" sends a person hunting for a link that was never there,
 * while "you may not open this" tells them the truth and who to ask. It also
 * names their role, since the usual cause is a role nobody has finished
 * setting up.
 */
export default async function NotAllowedPage() {
  const { user } = await requireSiteUser()

  return (
    <>
      <PageHeader title="Not allowed" subtitle="You do not have permission to open that screen" />

      <PageBody>
        <Card>
          <CardBody className="flex items-start gap-3">
            <Icons.Ban size={20} className="mt-0.5 shrink-0 text-danger" />
            <div className="flex flex-col gap-3">
              <div>
                <p className="font-medium text-ink">
                  {user.roleName
                    ? `Your role (${user.roleName}) does not include that screen.`
                    : 'You have not been given a role yet, so nothing is open to you.'}
                </p>
                <p className="text-sm text-muted">
                  An owner can change this in Setup → Roles &amp; permissions.
                </p>
              </div>
              <div>
                <ButtonLink href="/dashboard" variant="primary">
                  Back to the dashboard
                </ButtonLink>
              </div>
            </div>
          </CardBody>
        </Card>
      </PageBody>
    </>
  )
}
