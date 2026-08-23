/**
 * What a workflow rule is made of (§12).
 *
 * Pure and free of `server-only`, because the builder is a client component and
 * the dispatcher is a server module, and both must agree about what a rule
 * means. Same split serialStatus and jobFormModel already use.
 */

export const RULE_EVENTS = [
  'created',
  'status_entered',
  'status_exited',
  'priority_changed',
  'assigned',
  'closed',
  'quote_accepted',
  'quote_declined',
  'part_requested',
  'part_received',
  'form_submitted',
] as const
export type RuleEvent = (typeof RULE_EVENTS)[number]

export const RULE_EVENT_LABEL: Record<RuleEvent, string> = {
  created: 'A job is logged',
  status_entered: 'A job reaches a stage',
  status_exited: 'A job leaves a stage',
  priority_changed: 'The priority changes',
  assigned: 'Somebody is given the job',
  closed: 'A job is closed',
  quote_accepted: 'The customer accepts a quote',
  quote_declined: 'The customer declines a quote',
  part_requested: 'Somebody asks for a part',
  part_received: 'A part arrives',
  form_submitted: 'A form is filled in',
}

/** Which events take a status, so the builder knows whether to offer one. */
export const EVENTS_WITH_STATUS: readonly RuleEvent[] = ['status_entered', 'status_exited']

export function isRuleEvent(value: string): value is RuleEvent {
  return (RULE_EVENTS as readonly string[]).includes(value)
}

export type JobRule = {
  id: number
  name: string
  isActive: boolean
  event: RuleEvent
  triggerStatusId: number | null
  ifBoardId: number | null
  ifPriority: string | null
  ifHeadlineId: number | null
  ifIdleHours: number | null
  doNotify: boolean
  doStatusId: number | null
  doPriority: string | null
  doFollowerUserId: number | null
  message: string
}

/**
 * Why this rule would never do anything, or null.
 *
 * A rule with no action is the mistake people actually make — they pick a
 * trigger, write a condition, and press save before choosing what happens. Left
 * unchecked it saves happily and then never does anything, which is the worst
 * kind of broken: it looks configured.
 *
 * Run on the screen as somebody builds and again in the action, from this one
 * function, so the two cannot disagree about what a usable rule is.
 */
export function ruleProblem(rule: {
  name: string
  event: string
  doNotify: boolean
  doStatusId: number | null
  doPriority: string | null
  doFollowerUserId: number | null
  triggerStatusId: number | null
}): string | null {
  if (!rule.name.trim()) return 'A rule needs a name, so somebody can find it later.'
  if (!isRuleEvent(rule.event)) return 'Choose what this rule watches for.'

  const acts =
    rule.doNotify ||
    rule.doStatusId !== null ||
    rule.doPriority !== null ||
    rule.doFollowerUserId !== null
  if (!acts) return 'A rule that does nothing would never be noticed. Choose at least one action.'

  /*
   * A rule that moves a job INTO the status it watches for would fire itself.
   *
   * The cooldown stops it spinning, but a rule whose only effect is to trip its
   * own guard is not a rule anybody meant to write. Refused here rather than
   * survived at runtime, because the failure is legible now and baffling later.
   */
  if (
    rule.event === 'status_entered' &&
    rule.triggerStatusId !== null &&
    rule.doStatusId === rule.triggerStatusId
  ) {
    return 'That rule watches for a stage and then sets the same one, so it would only ever trigger itself.'
  }

  return null
}

/** A sentence describing what a rule does, for the list. */
export function describeRule(
  rule: JobRule,
  names: { status?: (id: number) => string; board?: (id: number) => string },
): string {
  const when =
    rule.event === 'status_entered' && rule.triggerStatusId !== null
      ? `When a job reaches ${names.status?.(rule.triggerStatusId) ?? 'a stage'}`
      : rule.event === 'status_exited' && rule.triggerStatusId !== null
        ? `When a job leaves ${names.status?.(rule.triggerStatusId) ?? 'a stage'}`
        : RULE_EVENT_LABEL[rule.event]

  const does: string[] = []
  if (rule.doNotify) does.push('tell the people on it')
  if (rule.doStatusId !== null) {
    does.push(`move it to ${names.status?.(rule.doStatusId) ?? 'another stage'}`)
  }
  if (rule.doPriority !== null) does.push(`set it to ${rule.doPriority}`)
  if (rule.doFollowerUserId !== null) does.push('add a follower')

  const conditions: string[] = []
  if (rule.ifPriority !== null) conditions.push(`it is ${rule.ifPriority}`)
  if (rule.ifBoardId !== null) {
    conditions.push(`it is on ${names.board?.(rule.ifBoardId) ?? 'a board'}`)
  }
  if (rule.ifIdleHours !== null) {
    conditions.push(`nothing has happened for ${rule.ifIdleHours} hours`)
  }

  const ifPart = conditions.length > 0 ? ` and ${conditions.join(' and ')}` : ''
  return `${when}${ifPart}, ${does.join(' and ') || 'do nothing'}.`
}
