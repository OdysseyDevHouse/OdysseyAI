import { Card, CardBody, EmptyState, Icons, TextLink } from '@/components/ui'

/**
 * A tile that has a name and a route but no screen behind it yet.
 *
 * ── WHY THESE EXIST AT ALL ─────────────────────────────────────────────────
 *
 * Five of the eighteen job card settings — custom fields, web-form building,
 * document templates, tasks, job files and time tracking — were specified before
 * they were built. Listing them as tiles that open a page saying so is a
 * deliberate choice over the two alternatives:
 *
 * A tile that opens a 404 is a bug report. A tile silently missing from the hub
 * means the person looking for it concludes the product cannot do it and stops
 * asking — which is worse, because the intent to build it is real and the ask is
 * the signal that would prioritise it.
 *
 * ── WHAT THIS IS NOT ───────────────────────────────────────────────────────
 *
 * Not a teaser and not a roadmap. It says the setting is not built, says where
 * the behaviour lives TODAY if it lives anywhere, and stops. A page promising a
 * date is a page that will be wrong.
 *
 * Delete this component when the last of the five ships; a stub that outlives
 * its feature is how a working screen ends up unreachable.
 */
export default function NotBuiltYet({
  /** What this screen will decide, in the words the tile already uses. */
  what,
  /**
   * Where the behaviour lives today, if it lives anywhere.
   *
   * Most of these are genuinely absent, but some are partly reachable elsewhere
   * — and sending somebody to the screen that can do half of it is the only
   * useful thing this page can offer.
   */
  today,
}: {
  what: string
  today?: React.ReactNode
}) {
  return (
    <Card>
      <CardBody>
        <EmptyState
          icon={<Icons.Settings size={22} />}
          title="Not built yet"
          hint={what}
          action={
            today ? (
              <p className="max-w-prose text-sm text-muted">{today}</p>
            ) : (
              <p className="max-w-prose text-sm text-muted">
                Nothing is configurable here yet. Everything else about a job card is under{' '}
                <TextLink href="/jobs/setup">Job card setup</TextLink>.
              </p>
            )
          }
        />
      </CardBody>
    </Card>
  )
}
