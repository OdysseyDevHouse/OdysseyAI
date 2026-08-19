/**
 * The line of encouragement on the open-till screen.
 *
 * ── WHY A DAY INDEX AND NOT A RANDOM PICK ─────────────────────────────────
 *
 * The gate is the first screen of somebody's working day, and on a busy counter
 * it is also the screen they come back to after every sign-out. A random quote
 * would change on each of those — three different "thoughts for the day" before
 * ten o'clock, which reads as decoration rather than as something meant.
 *
 * One quote per calendar day makes it a fixture instead: the same line all day
 * for everyone on the floor, so two cashiers can talk about it, and a new one
 * tomorrow. It is also the reason there is no shuffle button — a thought you can
 * press past is one nobody reads.
 *
 * The index is the day number since the epoch, so the list walks in order and
 * every quote gets its turn before any repeats. With 50 quotes that is a cycle
 * a little over seven weeks long, which is far enough apart that nobody clocks
 * the repetition.
 *
 * ── LOCAL DAYS, NOT UTC ───────────────────────────────────────────────────
 *
 * Computed from the till's own calendar date rather than from `Date.now() /
 * 86400000`. A shop two hours ahead of UTC would otherwise turn its page at two
 * in the morning for half the year and at some other hour the rest — and the one
 * thing this must do is change exactly once, overnight, while nobody is looking.
 */

export const TILL_QUOTES = [
  'Small steps every day lead to big results.',
  'Start where you are. Use what you have.',
  'Make today count.',
  'A positive start shapes the whole day.',
  'Progress begins with showing up.',
  'Bring good energy into every moment.',
  'Today is full of possibility.',
  'One good choice can change your day.',
  'Do the simple things exceptionally well.',
  'A little progress is still progress.',
  'Your attitude sets the tone.',
  'Be proud of how far you have come.',
  'Great service starts with a warm hello.',
  'Focus on what you can make better.',
  'Every customer is a fresh opportunity.',
  'Make someone’s day a little brighter.',
  'Confidence grows through action.',
  'Today’s effort builds tomorrow’s success.',
  'Choose progress over perfection.',
  'Good things begin with a clear intention.',
  'Your best is always worth bringing.',
  'A calm mind makes strong decisions.',
  'Kindness is always good business.',
  'Small wins create strong momentum.',
  'Let purpose guide your pace.',
  'The day gets better when you do.',
  'Stay curious. Stay kind. Keep moving.',
  'Success is built one moment at a time.',
  'Show up with purpose.',
  'A bright outlook opens doors.',
  'You can make a difference today.',
  'Keep it simple. Keep it moving.',
  'Energy follows attention.',
  'Every day is a new beginning.',
  'Let your work speak with care.',
  'Turn intention into action.',
  'Begin with confidence.',
  'Good habits make great days.',
  'Your smile is part of the service.',
  'Fresh day. Fresh focus.',
  'Be the reason the day runs smoothly.',
  'Trust the work you have put in.',
  'There is power in a positive start.',
  'Today is yours to shape.',
  'Keep going—you are building something.',
  'Make excellence feel effortless.',
  'A thoughtful moment can change everything.',
  'Lead the day with optimism.',
  'Start strong and stay steady.',
  'Here’s to a day of good work.',
] as const

/**
 * The quote for a given day. `at` defaults to now, and is a parameter so this
 * can be tested without waiting until tomorrow.
 */
export function quoteOfTheDay(at: Date = new Date()): string {
  // Local Y/M/D turned into a day number via a UTC timestamp — Date.UTC on the
  // LOCAL parts, which is the standard way to count calendar days without the
  // arithmetic wandering across a daylight-saving boundary.
  const days = Math.floor(
    Date.UTC(at.getFullYear(), at.getMonth(), at.getDate()) / 86_400_000,
  )
  return TILL_QUOTES[((days % TILL_QUOTES.length) + TILL_QUOTES.length) % TILL_QUOTES.length]
}

/**
 * "Good morning" / "Good afternoon" / "Good evening" for the till's own clock.
 *
 * Boundaries at 12 and 17 because that is what a South African counter calls
 * them, and the greeting sits beside the operator's name where getting it wrong
 * is noticeable — a screen wishing somebody good morning at four in the
 * afternoon is the sort of small wrongness that makes a whole app feel unminded.
 */
export function greetingFor(at: Date = new Date()): string {
  const hour = at.getHours()
  if (hour < 12) return 'Good morning'
  if (hour < 17) return 'Good afternoon'
  return 'Good evening'
}

/**
 * The eyebrow above the greeting — "WEDNESDAY · A FRESH START".
 *
 * The day name is the useful half: somebody opening a till at six in the morning
 * on a rota that changes by weekday genuinely does check. The second half is
 * tied to the same three parts of the day as the greeting, so the whole line
 * moves together rather than saying "a fresh start" at closing time.
 */
export function dayBannerFor(at: Date = new Date()): string {
  const day = at.toLocaleDateString(undefined, { weekday: 'long' }).toUpperCase()
  const hour = at.getHours()
  const phrase = hour < 12 ? 'A fresh start' : hour < 17 ? 'Well underway' : 'Into the evening'
  return `${day} · ${phrase}`
}
