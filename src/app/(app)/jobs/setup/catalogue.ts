import { groupsFor, resolveGroups, type DeclaredGroup, type HubGroup } from '@/lib/hub'
import type { SubpageHref } from '@/lib/nav'

/**
 * How job cards work, as opposed to the work in flight.
 *
 * These four screens were tiles in the general Setup hub, which put a field
 * team's configuration behind a section mostly about tills and stock. They are
 * listed here instead, under the Job cards section's own Setup row — one front
 * door, in the module they belong to.
 *
 * Grouped by WHAT SOMEBODY IS TRYING TO DO: change how work moves, or connect
 * it to something outside.
 */

/** A jobs route, narrowed so a tile cannot point outside this hub. */
export type JobsSetupHref = Extract<SubpageHref, `/jobs/setup/${string}`>

const DECLARED: DeclaredGroup<JobsSetupHref>[] = [
  {
    label: 'How work moves',
    description: 'The stages a job goes through, and what happens on its own along the way.',
    tone: 'amber',
    icon: 'Wrench',
    items: [
      {
        href: '/jobs/setup/workflow',
        description: 'The stages a job moves through, and the boards that show them.',
        keywords: 'job card workflow statuses stages board kanban columns service repair technician',
        icon: 'Wrench',
        tone: 'amber',
        capability: 'jobs.setup',
      },
      {
        href: '/jobs/setup/rules',
        description: 'When something happens on a job, do something about it without being asked.',
        /* "alert" and "notification" deliberately present: somebody looking for
           "notify me when a job is assigned" reaches for those words, and the
           alerts screen cannot do it — alerts are scheduled, these are not. */
        keywords:
          'rule rules automation workflow trigger when then automatic escalate notify alert notification event',
        icon: 'Zap',
        tone: 'amber',
        capability: 'jobs.setup',
      },
    ],
  },
  {
    label: 'What it connects to',
    description: 'What a technician records on site, and the diaries a visit shows up in.',
    tone: 'sky',
    icon: 'FileText',
    items: [
      {
        href: '/jobs/setup/forms',
        description: 'What a technician records on site — readings, checks, a commissioning report.',
        keywords: 'form forms custom builder checklist questions fields survey report capture',
        icon: 'FileText',
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
]

/** Every tile, for the search index. */
export const JOBS_SETUP_GROUPS: HubGroup[] = resolveGroups(DECLARED)

/** The groups this user may see, with tiles they may not open dropped. */
export function jobsSetupGroupsFor(allow: (capability: string) => boolean): HubGroup[] {
  return groupsFor(JOBS_SETUP_GROUPS, allow)
}
