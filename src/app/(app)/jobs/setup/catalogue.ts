import { groupsFor, resolveGroups, type DeclaredGroup, type HubGroup } from '@/lib/hub'
import type { SubpageHref } from '@/lib/nav'

/**
 * How job cards work, as opposed to the work in flight.
 *
 * ── WHY THIS IS EIGHTEEN TILES AND NOT FOUR ────────────────────────────────
 *
 * It was four. One of them — "Workflow" — was a single route that stacked six
 * unrelated panels: the stages, the boards, the kinds of work, the crews, the
 * kinds of equipment, the promises, and a catch-all card of twenty-two switches
 * whose own heading read "Closing, parts, telling people, and what happens on
 * its own". That heading is the diagnosis. A card that needs four nouns to say
 * what it does is four cards.
 *
 * The cost was not the scrolling. It was that the route's NAME had to cover
 * everything inside it, so it named none of it: somebody looking for who signs a
 * job off, or what a technician may photograph, had no reason to open a screen
 * called Workflow — and the hub search, which matches labels, descriptions and
 * keywords, had one entry to match against instead of eighteen. A setting that
 * cannot be searched for is a setting that does not exist.
 *
 * So each panel is its own route, named for what it decides.
 *
 * ── THE THREE GROUPS ───────────────────────────────────────────────────────
 *
 * Grouped by WHEN somebody is deciding it, which is the order the questions
 * actually arrive in:
 *
 *   Input — what a job IS before anybody works on it. The shape of the card and
 *           where its details come from.
 *   Flow  — what happens to it once it exists: where it moves, who hears, what
 *           it does on its own.
 *   Data  — what gets recorded AGAINST it while the work happens.
 *
 * That ordering is why Assets is in Data and not Input: a shop is not defining
 * its equipment when it opens a job, it is recording readings against a machine
 * while a technician is standing in front of it.
 */

/**
 * The screens this hub may list.
 *
 * Its own routes, plus the handful it SHOWS without OWNING — the cross-reference
 * pattern `SETUP_ELSEWHERE` exists for, and for the same reason. Custom fields
 * are the case here: the same mechanism serves jobs, customers and equipment, so
 * a job-specific copy would be the mechanism going job-shaped and wrong for the
 * other two. The tile goes to the real screen, which opens on its Jobs tab, and
 * the breadcrumb there stays Setup's.
 *
 * Deliberately narrow rather than `SubpageHref`: a typo still has to be a route
 * that exists, and a tile still cannot point just anywhere.
 */
export type JobsSetupHref =
  | Extract<SubpageHref, `/jobs/setup/${string}`>
  | '/setup/custom-fields'

const DECLARED: DeclaredGroup<JobsSetupHref>[] = [
  {
    label: 'Job Input Settings',
    description: 'What a job is made of, and where the details come from.',
    tone: 'amber',
    icon: 'Package',
    items: [
      {
        href: '/jobs/setup/statuses',
        description:
          'The steps a job moves through — and what has to be true before a job can reach each one.',
        /* "stage" as well as "status": the screen calls them stages, the schema
           calls them statuses, and somebody who has only ever seen the board
           calls them columns. All three reach it. */
        keywords:
          'status statuses stage stages step steps state workflow lifecycle column progress open closed cancelled',
        icon: 'Wrench',
        tone: 'amber',
        capability: 'jobs.setup',
      },
      {
        href: '/jobs/setup/job-types',
        description: 'The kinds of jobs you take on, and what each one needs.',
        /* "headline" is what the table is called, and it is in here rather than
           in the label because it is the word nobody outside the code uses. */
        keywords:
          'job type types headline headlines kind category work service repair install priority default',
        icon: 'Tag',
        tone: 'amber',
        capability: 'jobs.setup',
      },
      {
        /* Somebody else's screen, on purpose — see JobsSetupHref above. It opens
           on its Jobs tab, so arriving from here lands where you meant. */
        href: '/setup/custom-fields',
        description: 'Extra fields on a job card, and who has to fill them in.',
        keywords:
          'custom field fields extra additional attribute property required capture data entry',
        icon: 'Database',
        tone: 'amber',
        /* Its own guard, not jobs.setup: the screen it opens is guarded on
           setup.edit, and a tile promising a page that will turn you away is
           worse than no tile. */
        capability: 'setup.edit',
      },
      {
        href: '/jobs/setup/web-forms',
        description:
          'Requests from outside — public forms that create a job when someone submits one.',
        /* "intake" is the internal word; "website" and "public" are what the
           person searching actually types. */
        keywords:
          'web form forms public intake request requests website online submit enquiry lead stranger customer',
        icon: 'FileText',
        tone: 'amber',
        capability: 'jobs.setup',
      },
      {
        href: '/jobs/setup/document-templates',
        description: 'The layouts your quotes, reports and certificates print from.',
        keywords:
          'document template templates layout print quote report certificate stationery letterhead pdf design',
        icon: 'Stamp',
        tone: 'amber',
        capability: 'jobs.setup',
      },
      {
        href: '/jobs/setup/crews',
        description: 'Who works together, and what work they can be sent to.',
        /* "team" is the schema's word and the one half the market uses. */
        keywords: 'crew crews team teams group squad staff technician assign who members',
        icon: 'Users',
        tone: 'amber',
        capability: 'jobs.setup',
      },
    ],
  },
  {
    label: 'Job Flow Settings',
    description: 'How a job moves, who hears about it, and what happens on its own.',
    tone: 'sky',
    icon: 'Zap',
    items: [
      {
        href: '/jobs/setup/rules',
        description:
          'What happens on its own — when something changes on a job, act on it without being asked.',
        /* "alert" and "notification" deliberately present: somebody looking for
           "notify me when a job is assigned" reaches for those words, and the
           alerts screen cannot do it — alerts are scheduled, these are not. */
        keywords:
          'rule rules automation workflow trigger when then automatic escalate notify alert notification event',
        icon: 'Zap',
        tone: 'sky',
        capability: 'jobs.setup',
      },
      {
        href: '/jobs/setup/boards',
        description: 'The views your team works from, and what each one shows.',
        keywords:
          'board boards kanban view views column columns lane swimlane display list grouped',
        icon: 'Columns',
        tone: 'sky',
        capability: 'jobs.setup',
      },
      {
        href: '/jobs/setup/notifications',
        description: 'Telling people — who hears about a job, and at which moment.',
        keywords:
          'notification notifications notify email alert tell inform follower assignee message send smtp',
        icon: 'Bell',
        tone: 'sky',
        capability: 'jobs.setup',
      },
      {
        href: '/jobs/setup/signoff',
        description: 'Who signs a job off, and what they have to see or sign before they can.',
        /* "close" is the word the setting uses internally — a signoff IS the
           close guard — and the one somebody types when a job will not close. */
        keywords:
          'signoff sign off signature sign close closing complete completion approve accept customer agree terms declaration',
        icon: 'Pen',
        tone: 'sky',
        capability: 'jobs.setup',
      },
      {
        href: '/jobs/setup/service-levels',
        description: 'What you promise a customer — response and completion times.',
        keywords:
          'service level sla promise target response completion time deadline due priority escalate breach',
        icon: 'ShieldCheck',
        tone: 'sky',
        capability: 'jobs.setup',
      },
      {
        href: '/jobs/setup/calendars',
        description: 'Job visits in Google or Outlook, and what those calendars say back.',
        /* "sync", "google" and "outlook" are the words somebody reaches for;
           none of them is in the label. */
        keywords:
          'calendar calendars google outlook microsoft sync ical subscribe availability busy free',
        icon: 'Clock',
        tone: 'sky',
        capability: 'jobs.setup',
      },
    ],
  },
  {
    label: 'Job Data Settings',
    description: 'What gets recorded against a job while the work happens.',
    tone: 'emerald',
    icon: 'Database',
    items: [
      {
        href: '/jobs/setup/assets',
        description: 'The equipment you service, and what to record on each one.',
        /* "serial" and "vin" because the identifier label is configurable, and
           what somebody remembers is the field, not the screen. */
        keywords:
          'asset assets equipment machine plant vehicle serial vin registration tag service interval customer owned',
        icon: 'Cube',
        tone: 'emerald',
        capability: 'jobs.setup',
      },
      {
        href: '/jobs/setup/forms',
        description:
          'What a technician records on site — readings, checks, a commissioning report.',
        keywords: 'form forms custom builder checklist questions fields survey report capture',
        icon: 'FileText',
        tone: 'emerald',
        capability: 'jobs.setup',
      },
      {
        href: '/jobs/setup/tasks',
        description: 'The checklist a technician works down while on a job.',
        keywords: 'task tasks checklist check list todo step steps required tick done work',
        icon: 'ClipboardList',
        tone: 'emerald',
        capability: 'jobs.setup',
      },
      {
        href: '/jobs/setup/job-files',
        description: 'Photos, drawings and attachments that travel with a job.',
        keywords:
          'file files photo photos picture image attachment attach document drawing upload gallery evidence',
        icon: 'Folder',
        tone: 'emerald',
        capability: 'jobs.setup',
      },
      {
        href: '/jobs/setup/time-tracking',
        description: 'When the clock runs, and what counts as billable.',
        keywords:
          'time tracking clock timer hours labour billable chargeable timesheet start stop duration rate',
        icon: 'Clock',
        tone: 'emerald',
        capability: 'jobs.setup',
      },
      {
        href: '/jobs/setup/parts-stock',
        description: 'How parts and stock get onto a job, and who signs them out.',
        keywords:
          'part parts stock item items consumable material issue request awaiting shortage warn availability',
        icon: 'Boxes',
        tone: 'emerald',
        capability: 'jobs.setup',
      },
    ],
  },
]

/** Every tile, for the search index. */
export const JOBS_SETUP_GROUPS: HubGroup[] = resolveGroups(DECLARED)

/** The groups this user may see, with tiles they may not open dropped. */
export function jobsSetupGroupsFor(allow: (capability: string) => boolean): HubGroup[] {
  return groupsFor(JOBS_SETUP_GROUPS, allow)
}
