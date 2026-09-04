import { redirect } from 'next/navigation'
import { Building2, ChevronRight, StatusError as AlertCircle } from '@/components/ui/icons'
import { requireSession } from '@/lib/auth'
import { listSitesForUser, isControlUnreachable } from '@/lib/sites'
import { opensHere, isCloudBackOffice, wrongShellMessage } from '@/lib/siteOpensHere'
import LoginScreen from '@/components/LoginScreen'
import { selectSiteAction } from './actions'

export const dynamic = 'force-dynamic'

const ROLE_LABEL: Record<string, string> = {
  owner: 'Owner',
  manager: 'Manager',
  staff: 'Staff',
}

export default async function SelectSitePage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; wrongsite?: string }>
}) {
  const session = await requireSession()

  // This page is outside the (app) layout, so it carries the same guard —
  // otherwise picking a site would be a way around the forced change.
  if (session.mustChangePassword) redirect('/change-password')

  const { next, wrongsite } = await searchParams

  /* Each back office lists only the stores it can actually open — the EXE the
     local ones, the browser the cloud ones — because offering a row here that
     selectSiteAction then refuses would be a door drawn on a wall. See
     lib/siteOpensHere.ts. `hidden` is what got filtered out, so the screen can
     say so rather than silently showing a shorter list than the one the same
     account sees through the other door. */
  /* ── THE LIST IS THE ONE THING HERE THAT NEEDS THE CONTROL DATABASE ───────
   *
   * ControlUnreachable offers this page as the way out of a store whose own
   * database cannot be opened, which is the usual cause: one row in
   * cp2_site_databases pointing at a host that no longer resolves, while the
   * account's other stores are fine. But the SAME screen appears when the
   * control database itself is down, and then this read throws — turning the
   * door out of that screen into a stack trace on global-error.tsx.
   *
   * So the failure is caught and said in a sentence. Signing out still works
   * from here (it touches no database that has to answer), which is the only
   * action left worth offering.
   */
  let all
  try {
    all = await listSitesForUser(session.userId)
  } catch (err) {
    if (!isControlUnreachable(err)) throw err
    return (
      <LoginScreen>
        <div className="flex flex-col gap-4">
          <div className="text-center">
            <h2 className="text-sm font-semibold text-ink">Can&rsquo;t list your stores</h2>
            <p className="mt-0.5 text-xs text-muted">Signed in as {session.email}</p>
          </div>
          <p className="flex items-start gap-2 rounded-md bg-warning/10 px-3 py-2.5 text-sm text-warning">
            <AlertCircle size={15} className="mt-0.5 shrink-0" />
            <span>
              The server could not reach the control database, which is where the list of
              stores your account can open lives. Try again in a moment; if it keeps
              happening it is a setting or a network fault on the server rather than
              anything you have done.
            </span>
          </p>
          <form action="/api/auth/signout" method="post" className="text-center">
            <button data-kit-ok type="submit" className="text-xs text-muted hover:text-ink">
              Sign out
            </button>
          </form>
        </div>
      </LoginScreen>
    )
  }
  const sites = all.filter((s) => opensHere(s.connectionType))
  const hidden = all.length - sites.length

  return (
    <LoginScreen>
      <div className="flex flex-col gap-4">
        <div className="text-center">
          <h2 className="text-sm font-semibold text-ink">Choose a store</h2>
          <p className="mt-0.5 text-xs text-muted">
            {sites.length > 1
              ? 'Your account has access to more than one store. Select which one to open.'
              : `Signed in as ${session.email}`}
          </p>
        </div>

        {/* Arrived here by trying one anyway — a stale picker, or a store whose
            connection type changed since this page was drawn. */}
        {wrongsite === '1' && (
          <p className="flex items-start gap-2 rounded-md bg-warning/10 px-3 py-2.5 text-sm text-warning">
            <AlertCircle size={15} className="mt-0.5 shrink-0" />
            <span>{wrongShellMessage()}</span>
          </p>
        )}

        {sites.length === 0 && hidden > 0 ? (
          <p className="flex items-start gap-2 rounded-md bg-warning/10 px-3 py-2.5 text-sm text-warning">
            <AlertCircle size={15} className="mt-0.5 shrink-0" />
            <span>{wrongShellMessage(all.length === 1 ? all[0].displayName : undefined)}</span>
          </p>
        ) : sites.length === 0 ? (
          <p className="flex items-start gap-2 rounded-md bg-warning/10 px-3 py-2.5 text-sm text-warning">
            <AlertCircle size={15} className="mt-0.5 shrink-0" />
            <span>
              This account isn&apos;t linked to any store yet. Add a row to
              <code className="mx-1 rounded bg-surface-2 px-1 py-0.5 text-xs">cp2_user_sites</code>
              to grant access.
            </span>
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {sites.map((site) => (
              <li key={site.id}>
                <form action={selectSiteAction}>
                  <input type="hidden" name="siteId" value={site.id} />
                  {next && <input type="hidden" name="next" value={next} />}
                  {/* Not <Button>: a two-line site row with a trailing chevron,
                      closer to a list item than a labelled action. */}
                  <button
                    data-kit-ok
                    type="submit"
                    className="flex w-full items-center justify-between gap-3 rounded-control border border-border px-3 py-2.5 text-left transition hover:border-brand hover:bg-surface-2"
                  >
                    <span className="min-w-0">
                      <span className="flex items-center gap-1.5">
                        <Building2 size={14} className="shrink-0 text-muted" />
                        <span className="truncate text-sm text-ink">{site.displayName}</span>
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-muted">
                        {site.code} · {ROLE_LABEL[site.role] ?? site.role}
                        {site.isDefault && ' · default'}
                        {site.status === 'suspended' && ' · suspended'}
                      </span>
                    </span>
                    <ChevronRight size={16} className="shrink-0 text-muted" />
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}

        {/* Said plainly rather than left as a shorter list. An owner who knows
            they have four stores and counts three here should be told which
            question that answers.

            Which sentence depends on WHICH door this is — the wording used to
            be hardcoded to the desktop's half of the rule, so the browser told
            an owner their local store "keeps its data in the cloud", which is
            the opposite of true and names the wrong remedy. */}
        {hidden > 0 && sites.length > 0 && (
          <p className="text-center text-xs text-muted">
            {hidden === 1 ? 'One other store keeps' : `${hidden} other stores keep`} their data{' '}
            {isCloudBackOffice() ? 'on their own premises' : 'in the cloud'}. Open{' '}
            {hidden === 1 ? 'it' : 'them'} in{' '}
            {isCloudBackOffice()
              ? 'OdysseyAI Back Office, on a computer in the store'
              : 'your web browser'}
            .
          </p>
        )}

        <form action="/api/auth/signout" method="post" className="text-center">
          {/* A quiet text affordance, not a button — it must not compete with
              the site rows above, which are the actual choice on this screen. */}
          <button data-kit-ok type="submit" className="text-xs text-muted hover:text-ink">
            Sign out
          </button>
        </form>
      </div>
    </LoginScreen>
  )
}
