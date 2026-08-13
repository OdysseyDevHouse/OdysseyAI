/**
 * Building an iCalendar feed.
 *
 * Pure — no database, no request, no `server-only`. Everything here is string
 * handling against RFC 5545, and the fiddly parts (escaping, line folding, the
 * UID rule) are worth testing without a fixture.
 *
 * ── WHY NOT A LIBRARY ───────────────────────────────────────────────────────
 *
 * The whole of what this app needs is about eighty lines: a VCALENDAR wrapper, a
 * VEVENT per visit, five properties each. An ics library brings recurrence
 * rules, timezone databases and attendee handling that this feed will never use,
 * and every one of them is a dependency to keep current.
 */

export type IcsEvent = {
  /**
   * Stable across regenerations. THE most important field in the file.
   *
   * A calendar matches events by UID. If it changes when a visit is edited, the
   * subscriber gets a second event rather than an updated one — and a technician
   * ends up with two 08:00 bookings, one of them a ghost. So it is derived from
   * the appointment id, never from anything that can change.
   */
  uid: string
  /** UTC. See toIcsStamp — a feed with no timezone must be in Zulu time. */
  startsAt: Date
  endsAt: Date
  summary: string
  description?: string
  location?: string
  /** Bumped when the event changes, so a subscriber knows to replace it. */
  sequence?: number
  status?: 'CONFIRMED' | 'TENTATIVE' | 'CANCELLED'
}

/**
 * A Date as an iCalendar UTC stamp: 20260813T140000Z.
 *
 * UTC, always, and never a local time with a TZID. A floating local time would
 * need a VTIMEZONE block naming the rules for Africa/Johannesburg, and getting
 * that wrong shifts every booking by an hour twice a year in half the world.
 * Zulu time is unambiguous everywhere and the subscriber's calendar renders it
 * in whatever timezone the reader is in — which is what a technician wants.
 */
export function toIcsStamp(value: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return (
    `${value.getUTCFullYear()}${p(value.getUTCMonth() + 1)}${p(value.getUTCDate())}` +
    `T${p(value.getUTCHours())}${p(value.getUTCMinutes())}${p(value.getUTCSeconds())}Z`
  )
}

/**
 * Escape a value for a TEXT property.
 *
 * Order matters: the backslash MUST be escaped first, or escaping the others
 * would then double-escape the backslashes this function just added.
 *
 * A customer called "Smith \ Jones" or an address containing a comma are both
 * ordinary, and both break the file without this — a bare comma starts a new
 * value and the rest of the line is silently dropped by the parser.
 */
export function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    // A newline inside a description is a literal \n in the file, not a real
    // line break — a real one would end the property.
    .replace(/\r?\n/g, '\\n')
}

/**
 * Fold a content line to 75 octets, per RFC 5545 section 3.1.
 *
 * Continuation lines begin with a single space, which the parser strips. Long
 * job titles and addresses routinely exceed 75 characters, and some parsers
 * reject an over-long line outright rather than tolerating it.
 *
 * Counted in BYTES rather than characters, because the limit is octets and a
 * customer name with an accent or an emoji costs more than one byte apiece. A
 * naive character count produces lines that are legal by length and illegal by
 * size.
 */
export function foldIcsLine(line: string): string {
  const encoder = new TextEncoder()
  if (encoder.encode(line).length <= 75) return line

  const out: string[] = []
  let current = ''
  let bytes = 0

  // Split on code POINTS, not UTF-16 units, so a surrogate pair is never cut in
  // half — half an emoji is invalid UTF-8 and can take a parser down.
  for (const ch of line) {
    const size = encoder.encode(ch).length
    // 74 not 75 on a continuation, because the leading space costs one octet.
    const limit = out.length === 0 ? 75 : 74
    if (bytes + size > limit) {
      out.push(current)
      current = ch
      bytes = size
    } else {
      current += ch
      bytes += size
    }
  }
  if (current) out.push(current)

  return out.map((part, i) => (i === 0 ? part : ` ${part}`)).join('\r\n')
}

/** One property line, escaped and folded. */
function prop(name: string, value: string): string {
  return foldIcsLine(`${name}:${escapeIcsText(value)}`)
}

/**
 * A whole calendar.
 *
 * `name` becomes the calendar's title in the subscriber's app. X-WR-CALNAME is
 * non-standard but is what Google, Outlook and Apple all actually read — the
 * standard offers no way to name a calendar at all.
 */
export function buildIcs(
  events: readonly IcsEvent[],
  opts: { name: string; stampedAt: Date; prodId?: string },
): string {
  const stamp = toIcsStamp(opts.stampedAt)

  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    prop('PRODID', opts.prodId ?? '-//Odyssey//Job cards//EN'),
    'CALSCALE:GREGORIAN',
    // PUBLISH, not REQUEST: this is a feed somebody subscribed to, not an
    // invitation expecting an RSVP.
    'METHOD:PUBLISH',
    prop('X-WR-CALNAME', opts.name),
    /*
     * How often a subscriber should re-fetch. Both spellings, because Google
     * reads the X- one and everybody else reads REFRESH-INTERVAL.
     *
     * An hour: a job schedule changes during a working day, and a technician
     * whose phone is a day behind will drive to the wrong place.
     */
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H',
  ]

  for (const event of events) {
    lines.push('BEGIN:VEVENT')
    lines.push(prop('UID', event.uid))
    lines.push(`DTSTAMP:${stamp}`)
    lines.push(`DTSTART:${toIcsStamp(event.startsAt)}`)
    lines.push(`DTEND:${toIcsStamp(event.endsAt)}`)
    lines.push(prop('SUMMARY', event.summary))
    if (event.description) lines.push(prop('DESCRIPTION', event.description))
    if (event.location) lines.push(prop('LOCATION', event.location))
    lines.push(`SEQUENCE:${event.sequence ?? 0}`)
    lines.push(`STATUS:${event.status ?? 'CONFIRMED'}`)
    lines.push('END:VEVENT')
  }

  lines.push('END:VCALENDAR')

  // CRLF between lines, and a trailing one. The spec requires CRLF, and some
  // parsers — Outlook among them — reject a file that ends without a final
  // break.
  return lines.join('\r\n') + '\r\n'
}
