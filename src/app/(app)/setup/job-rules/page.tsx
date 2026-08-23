import { requireModuleCapability } from '@/lib/auth'
import { listRules, reconcileJobRules } from '@/lib/site/jobRules'
import { listJobStatuses } from '@/lib/site/jobStatuses'
import { listJobBoards } from '@/lib/site/jobBoards'
import { listHeadlines } from '@/lib/site/jobHeadlines'
import { listUsers } from '@/lib/site/users'
import { getSettings } from '@/lib/site/settings'
import { PageHeader, PageBody, Callout } from '@/components/ui'
import RulesClient from './RulesClient'

export const dynamic = 'force-dynamic'

/**
 * Workflow rules: when this happens, if that is true, do this (§12).
 *
 * ── WHY ITS OWN ROUTE ──────────────────────────────────────────────────────
 *
 * Same reasoning /setup/job-forms gives. A rule builder has a list, an editor
 * with three sections, and a lookup of statuses, boards, headlines and people
 * behind every dropdown. Stacked into /setup/job-workflow it would bury the
 * five settings people actually change weekly under a screen opened rarely.
 *
 * ── WHY NOT /setup/alerts ──────────────────────────────────────────────────
 *
 * Alerts are SCHEDULED and job rules are EVENT-driven — the reasoning is set
 * out at length in 225_job_rules.sql. Two clocks, and putting them on one
 * screen would teach people they are the same thing right up until somebody
 * asks why their "when a job is assigned" rule ran at 6am.
 */
export default async function JobRulesPage() {
  const { siteId } = await requireModuleCapability('job_cards', 'jobs.setup')

  const [rules, statuses, boards, headlines, users, settings, drift] = await Promise.all([
    listRules(siteId),
    listJobStatuses(siteId, false),
    listJobBoards(siteId, false),
    listHeadlines(siteId),
    listUsers(siteId),
    getSettings(siteId, ['job_rule_cooldown_minutes']),
    reconcileJobRules(siteId),
  ])

  /*
   * A rule that has fired ten times on ONE job in a day is shown here rather
   * than in a report nobody opens.
   *
   * Not called a loop, because it is not proof of one — see the type. It is the
   * shape a loop takes, and the person who can tell the difference is the one
   * looking at this screen.
   */
  const noisy = drift.noisy

  return (
    <>
      <PageHeader
        title="Rules"
        subtitle="When something happens on a job, do something about it automatically."
      />
      <PageBody>
        {noisy.length > 0 && (
          <Callout tone="warning" title="A rule is firing repeatedly on the same job">
            {noisy
              .slice(0, 4)
              .map((n) => `${n.ruleName} — ${n.fires} times on job #${n.jobId}`)
              .join('; ')}
            . That is normal on a busy job and is also what a pair of rules moving a job back
            and forth looks like. Worth reading the two rules involved before it becomes a habit.
          </Callout>
        )}
        <RulesClient
          rules={rules}
          statuses={statuses.map((s) => ({ id: s.id, name: s.name }))}
          boards={boards.map((b) => ({ id: b.id, name: b.name }))}
          headlines={headlines.map((h) => ({ id: h.id, name: h.name }))}
          users={users
            .filter((u) => u.isActive)
            .map((u) => ({ id: u.id, name: u.name }))}
          cooldownMinutes={settings.job_rule_cooldown_minutes ?? '5'}
        />
      </PageBody>
    </>
  )
}
