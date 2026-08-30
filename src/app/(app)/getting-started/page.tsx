import { redirect } from 'next/navigation'
import { requireSiteUser } from '@/lib/auth'
import { can, type Capability } from '@/lib/site/permissions'
import { menuHolder } from '@/lib/site/menuVisibility'
import { readProgress, completion, isHidden } from '@/lib/site/gettingStarted'
import { PageHeader, PageBody, Icons } from '@/components/ui'
import GettingStartedClient, {
  type ViewStep,
  type ViewPointer,
} from './GettingStartedClient'
import { STEPS, POINTERS } from './catalogue'

/**
 * Where a brand-new account lands.
 *
 * A shop that has just signed up has an empty dashboard, and an empty dashboard
 * is the worst possible first screen: every figure on it is zero, none of them
 * are wrong, and it says nothing about what to do. This is the screen that
 * answers that instead — what to set up, in what order, and roughly how long it
 * takes to be able to serve a customer.
 *
 * ── IT IS NOT A WIZARD ────────────────────────────────────────────────────
 *
 * Nothing here traps anybody. Every step is a link to the real screen that does
 * the job, and the whole page is reachable at any time from the sidebar. A
 * modal wizard would mean maintaining a second, worse version of six screens
 * that already exist, and it would strand the person who wants to do step four
 * first.
 *
 * ── EVERY TICK IS READ FROM THE DATA ──────────────────────────────────────
 *
 * See the header of lib/site/gettingStarted.ts. Nothing is stored, so a step
 * done by ANY route — the screen, the CSV import, the API, another manager on
 * another device — shows as done the next time this page is opened, and the
 * page can never drift out of step with the shop it describes.
 *
 * `force-dynamic` for that reason: a cached copy of this page is a checklist of
 * work somebody has already finished.
 */

export const dynamic = 'force-dynamic'

export default async function GettingStartedPage({
  searchParams,
}: {
  searchParams: Promise<{ show?: string }>
}) {
  const { site, user, capabilities, modules } = await requireSiteUser()

  /*
   * ── DISMISSED MEANS DISMISSED, INCLUDING BY URL ───────────────────────────
   *
   * The menu row is gone and the sign-in redirect no longer points here, but
   * both of those are doors — this is the room. A bookmark, a browser's history
   * or a stale tab would all still open a screen the shop has explicitly put
   * away, and a checklist that comes back after being dismissed is the thing
   * the button was pressed to stop.
   *
   * `?show=1` is the way back in, and it is why this is not a dead end: the
   * confirmation the page gives when it is hidden links here, so somebody who
   * dismissed it by accident — or a manager who wants it again — has a door
   * that does not require finding a setting. A redirect with no exception
   * would make un-hiding possible only by editing the database.
   */
  const { show } = await searchParams
  const hidden = await isHidden(site.id)
  if (show !== '1' && hidden) redirect('/dashboard')

  /* NOT gated on a capability, and NOT redirected to /not-allowed.
   *
   * Same argument the dashboard makes: this is a landing screen, so bouncing
   * somebody off it strands them the moment they sign in. Instead every step
   * and pointer is filtered by what this person may actually do — a cashier
   * sees the till step and nothing about permissions — and somebody who may do
   * none of it gets an honest empty state rather than a redirect loop. */
  const allow = (c?: string) => !c || can(capabilities, c as Capability)

  /* A module the shop never bought, or switched off under Menu & modules. A
     step pointing at a screen that is not there would be a checklist item
     nobody can ever tick. */
  const holds = await menuHolder(site.id, modules)

  const progress = await readProgress(site)

  const steps: ViewStep[] = STEPS.filter(
    (s) => allow(s.capability) && (!s.module || holds(s.module)),
  ).map((s) => {
    const state = progress[s.key]
    return {
      key: s.key,
      title: s.title,
      blurb: s.blurb,
      href: s.href,
      cta: s.cta,
      icon: s.icon,
      tone: s.tone,
      minutes: s.minutes,
      essential: s.essential,
      newWindow: s.newWindow,
      done: state.done,
      count: state.count,
    }
  })

  const pointers: ViewPointer[] = POINTERS.filter(
    (p) => allow(p.capability) && (!p.module || holds(p.module)),
  ).map((p) => ({ title: p.title, blurb: p.blurb, href: p.href, icon: p.icon, tone: p.tone }))

  /* Counted from the steps this person was actually SHOWN — a bar reading
     "2 of 6" to somebody who can only see three of them is measuring work they
     cannot do. See the note on completion(). */
  const essential = completion(
    steps.filter((s) => s.essential).map((s) => ({ count: s.count, done: s.done })),
  )

  /* The first name alone. "Welcome, Tiaan" reads like a person talking; the
     full name off an account record reads like a form letter. */
  const firstName = (user.name ?? '').trim().split(/\s+/)[0] || 'there'

  return (
    <>
      <PageHeader
        icon={<Icons.Sparkles size={18} />}
        title="Getting started"
        subtitle={`Set ${site.displayName} up and take your first sale`}
      />
      <PageBody>
        {steps.length === 0 && pointers.length === 0 ? (
          <div className="flex flex-col items-center px-6 py-16 text-center">
            <div className="mb-3 text-faint">
              <Icons.Info size={28} strokeWidth={1.75} />
            </div>
            <p className="text-sm font-semibold text-ink">Nothing to set up from here</p>
            <p className="mt-1 max-w-md text-sm text-muted">
              {user.roleName
                ? `Your role (${user.roleName}) does not include any of the setup screens. Use the menu on the left for the screens you do have.`
                : 'You have not been given a role yet. An owner can give you one in Setup → Users.'}
            </p>
          </div>
        ) : (
          <GettingStartedClient
            firstName={firstName}
            shopName={site.displayName}
            steps={steps}
            pointers={pointers}
            essentialDone={essential.done}
            essentialTotal={essential.total}
            /* Only somebody who may change the shop's settings is offered the
               dismiss — it removes the row for every colleague. The action
               re-checks this; the prop only decides what is drawn. */
            canDismiss={allow('setup.edit')}
            /* The stored answer, not the URL: reaching this line with it true
               means the shop hid the checklist and is looking at it anyway via
               `?show=1`. The panel then offers "bring it back" rather than
               "don't show again", which is the only useful button to a reader
               who is already past the redirect. */
            currentlyHidden={hidden}
          />
        )}
      </PageBody>
    </>
  )
}
