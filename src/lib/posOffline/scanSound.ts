/**
 * The till's two noises: a scan landed, or it did not.
 *
 * ── WHY THESE ARE SYNTHESISED AND NOT AUDIO FILES ───────────────────────────
 *
 * A file would need fetching, and the one machine that most needs to make this
 * noise is the till that has lost its line. The service worker would have to
 * cache it, the cache would have to survive a version bump, and the failure
 * mode of getting any of that wrong is a silent till — which is exactly the
 * state the shop bought this feature to avoid.
 *
 * WebAudio has none of that. Two oscillators and a gain ramp are a few hundred
 * bytes of code that ship with the bundle, work offline by construction, and
 * cost no round trip at the moment a cashier is waiting.
 *
 * It also makes the two sounds genuinely DISTINGUISHABLE, which is the whole
 * requirement. A success is a short high blip; a failure is a low two-tone
 * buzz, longer, in a register nothing else on the counter occupies. A shop
 * hears which one happened from across the room without looking up.
 *
 * ── WHY EVERY ENTRY POINT SWALLOWS ITS ERRORS ───────────────────────────────
 *
 * Because a beep is feedback about a sale, and it must never BE the thing that
 * goes wrong with one. Audio can fail for reasons that have nothing to do with
 * this code: a browser that has not seen a user gesture yet, a kiosk with sound
 * disabled, an OS with no output device. None of those should turn a scanned
 * item into an exception on the path between a barcode and a basket.
 *
 * ── AND WHY THE CONTEXT IS LAZY AND SHARED ──────────────────────────────────
 *
 * An AudioContext is a real resource — browsers cap them at a few dozen per
 * page and never collect them on their own. A till holds one page open for a
 * whole shift and scans thousands of items across it, so a context per beep
 * would exhaust the cap within the first hour and then fail for the rest of the
 * day. One context, created on the first sound and reused for every one after.
 */

/** The shared context, made on first use. `null` once we know we cannot have one. */
let context: AudioContext | null | undefined

function audioContext(): AudioContext | null {
  if (context !== undefined) return context

  try {
    /* webkitAudioContext for older WebKit — a till may be an iPad, and the
       prefixed name is the only one some of them expose. */
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    context = Ctor ? new Ctor() : null
  } catch {
    context = null
  }
  return context
}

/** One tone: frequency, when it starts relative to now, and how long it lasts. */
type Tone = { hz: number; startsAt: number; seconds: number; volume: number }

function play(tones: Tone[]): void {
  const ctx = audioContext()
  if (!ctx) return

  /*
   * A context created before the page has seen a gesture starts SUSPENDED, and
   * every sound scheduled on it is silently dropped. A till has always been
   * touched by the time anything is scanned, so resuming here costs nothing and
   * covers the case where the first sound would otherwise be swallowed.
   */
  if (ctx.state === 'suspended') void ctx.resume().catch(() => {})

  const now = ctx.currentTime
  for (const tone of tones) {
    const oscillator = ctx.createOscillator()
    const gain = ctx.createGain()

    /* A square wave carries across a noisy shop floor far better than a sine at
       the same volume — it is the sound a barcode scanner's own beeper makes,
       for the same reason. */
    oscillator.type = 'square'
    oscillator.frequency.value = tone.hz

    const start = now + tone.startsAt
    const end = start + tone.seconds

    /*
     * RAMPED, NOT SWITCHED.
     *
     * A gain that jumps from 0 to full produces an audible click — the speaker
     * cone being asked to move instantly — on top of the tone. Ramping over a
     * few milliseconds at each end removes it. `setValueAtTime` first because a
     * ramp needs a starting point on the timeline to ramp FROM.
     */
    gain.gain.setValueAtTime(0.0001, start)
    gain.gain.exponentialRampToValueAtTime(tone.volume, start + 0.008)
    gain.gain.exponentialRampToValueAtTime(0.0001, end)

    oscillator.connect(gain)
    gain.connect(ctx.destination)
    oscillator.start(start)
    oscillator.stop(end + 0.02)
  }
}

/**
 * A product went into the basket.
 *
 * Short and high, so it disappears under the next scan rather than queueing up
 * behind it — a cashier working through a trolley fires this several times a
 * second, and anything longer would smear into one continuous tone.
 */
export function scanOk(): void {
  try {
    play([{ hz: 2100, startsAt: 0, seconds: 0.06, volume: 0.12 }])
  } catch {
    /* Never the reason a scan fails. See the header. */
  }
}

/**
 * Nothing matched, and the till fell back to a search.
 *
 * Deliberately unlike the success in every dimension a person notices: lower,
 * longer, and two falling tones rather than one. The requirement asked for a
 * horn, and a falling pair is what a horn reads as — a single low tone is heard
 * as "a beep that sounded odd", which is exactly the ambiguity that gets an
 * unscanned item put in a bag.
 */
export function scanFailed(): void {
  try {
    play([
      { hz: 320, startsAt: 0, seconds: 0.12, volume: 0.16 },
      { hz: 240, startsAt: 0.13, seconds: 0.18, volume: 0.16 },
    ])
  } catch {
    /* Never the reason a scan fails. See the header. */
  }
}
