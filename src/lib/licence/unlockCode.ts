import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * The offline unlock code: releasing a locked machine over the telephone.
 *
 * ── THE PROBLEM ─────────────────────────────────────────────────────────────
 *
 * A local-backend install locks itself seven days after the last successful
 * licence check. That rule is what stops a machine unplugged from the internet
 * trading forever on a licence nobody can withdraw.
 *
 * But the rule lands on the wrong person. The shop that cannot reach us at
 * 08:00 on a Sunday is usually not a shop dodging its bill — it is a shop with
 * a dead line, and locking its tills costs it a day's takings to punish
 * somebody else's behaviour. Support needs a way to release that machine
 * without either end being online.
 *
 * ── WHY THIS DOES NOT NEED A CONNECTION ─────────────────────────────────────
 *
 * Because a machine that HAS a connection never gets here — it renews its lease
 * automatically and never locks. So the only useful unlock is one that works
 * with nothing but a telephone.
 *
 * The two sides share a secret planted when the machine was last online. The
 * locked screen shows a CHALLENGE derived from that machine's identity and its
 * current state. The supervisor types it into the control panel, which holds
 * the same secret, and reads back a RESPONSE. The machine verifies the response
 * locally. No packet moves between them; the internet is only on our side of
 * the call.
 *
 * ── WHAT MAKES A CODE SAFE ──────────────────────────────────────────────────
 *
 * Machine-specific: the secret is per device, so a code issued for one shop's
 * till is refused by every other machine.
 *
 * Single-use: the redeem counter is an input to the challenge. Redeeming
 * increments it, which changes the next challenge, which invalidates the code
 * just used. A customer cannot bank one code and reuse it each week.
 *
 * Time-boxed: an unlock extends the lease by a fixed window rather than
 * clearing the requirement. The machine must still genuinely reconnect.
 *
 * What it is NOT is a defence against our own support desk. Anyone who can
 * issue codes can keep a non-paying site running a fortnight at a time, and no
 * offline scheme can prevent that — granting access without verifying anything
 * is the entire premise. cp2_unlock_grants is the answer to that, and it is a
 * ledger, not a lock.
 *
 * ── THIS FILE IS A CONTRACT ─────────────────────────────────────────────────
 *
 * Both ends compute the same HMAC. Change the alphabet, the length, the field
 * order or the separator and every machine in the field stops accepting codes
 * from the control panel — with no way to push a fix to a machine that is, by
 * definition, offline and locked. Treat the constants below as frozen.
 */

/**
 * The alphabet, chosen for a bad phone line.
 *
 * No 0/O, no 1/I/L, no 5/S, no 8/B, no 2/Z. Every pair a person reliably
 * mishears or misreads is resolved by having only one of them exist. What
 * remains is 24 characters, so each carries just under 4.6 bits.
 *
 * Uppercase only — the customer is reading it aloud off a screen, and case is
 * one more thing to get wrong. Input is upper-cased before it is checked.
 */
const ALPHABET = 'ACDEFGHJKMNPQRTUVWXY34679'

/**
 * Nine characters, grouped 3-3-3 for reading aloud. Roughly 41 bits against an
 * attacker who must guess in one shot, which is the right shape here: a wrong
 * response is refused, the counter does not move, and there is no oracle to
 * grind against because the machine is not on a network.
 */
const CODE_LENGTH = 9
const GROUP_SIZE = 3

/**
 * The field separator inside the HMAC input.
 *
 * A character that cannot occur in any field, so the joined string is
 * unambiguous: a serial containing the separator would otherwise let two
 * different inputs flatten to the same bytes and share a code. Device serials
 * come from hardware and installers, so a space or a dash is not safe to
 * assume absent.
 *
 * Written as an escape rather than a literal — a raw control character in
 * source is invisible in every editor and makes the file binary to git.
 */
const SEP = '\u0000'

/**
 * How long a granted unlock runs.
 *
 * THE definition — leaseRules re-exports this one rather than declaring its
 * own. It briefly existed in both files: they agreed, but nothing made them,
 * and two copies drifting apart would mean the code an agent reads out promises
 * a fortnight while the machine grants something else, with no error to say so.
 *
 * It lives HERE rather than in leaseRules because this file must stay free of
 * dependencies — it is shared by both ends of the unlock and has to run
 * anywhere. leaseRules imports the module catalogue, which is `server-only`, so
 * pointing this file at that one makes it unloadable in a plain script.
 *
 * Long enough to get an engineer out, short enough that a site living on
 * unlocks shows up in the grants report quickly.
 */
export const UNLOCK_GRANT_DAYS = 14

export type UnlockChallengeInput = {
  siteId: number
  /** cp2_devices.serial_number. Null on a machine that never claimed a spot. */
  deviceSerial: string | null
  /** licence_lease.unlock_counter — what makes the code single-use. */
  unlockCounter: number
}

/**
 * Turn HMAC bytes into readable characters.
 *
 * Rejection sampling rather than `byte % 24`: the modulo of a 256-value byte by
 * 24 favours the first 16 characters by a sixth. That bias would not be
 * exploitable at this length, but a skewed alphabet is the kind of detail that
 * is impossible to change later — every machine in the field would have to
 * agree to change it at the same moment — so it is worth getting right once.
 */
function encode(mac: Buffer, length: number): string {
  const limit = Math.floor(256 / ALPHABET.length) * ALPHABET.length
  let out = ''
  for (let i = 0; i < mac.length && out.length < length; i++) {
    const b = mac[i]
    if (b >= limit) continue // biased tail — discard and take the next byte
    out += ALPHABET[b % ALPHABET.length]
  }
  /* A 32-byte SHA-256 mac yields ~31 usable bytes after rejection, so nine
     characters is never short in practice. Re-hashing rather than padding
     keeps the function total instead of returning a code of the wrong length. */
  if (out.length < length) {
    return encode(createHmac('sha256', mac).update('extend').digest(), length)
  }
  return out
}

/** ACD-EFG-HJK. Grouping is presentation only — it is stripped before use. */
function group(code: string): string {
  const parts: string[] = []
  for (let i = 0; i < code.length; i += GROUP_SIZE) parts.push(code.slice(i, i + GROUP_SIZE))
  return parts.join('-')
}

/**
 * Strip everything that is not alphabet, and upper-case.
 *
 * Someone reading a code back will include the dashes, or spaces, or neither.
 * Normalising both ends of the comparison means none of that is a failed
 * unlock and a second phone call.
 */
export function normaliseCode(raw: string): string {
  const upper = raw.toUpperCase().replace(/\s|-/g, '')
  return upper
    .split('')
    .filter((c) => ALPHABET.includes(c))
    .join('')
}

/**
 * The challenge the locked machine displays.
 *
 * Derived, not random: the machine cannot store a challenge it invented,
 * because the whole point is that it may be restarted, and a machine that
 * forgets its challenge between the customer reading it out and the agent
 * answering has wasted the call. Deriving it from state both sides know means
 * the same challenge appears every time until the counter moves.
 *
 * The secret is included so a challenge cannot be predicted from the site id
 * and serial alone — otherwise anyone could enumerate challenges for a site
 * and ask support to "confirm" one.
 */
export function challengeFor(secret: string, input: UnlockChallengeInput): string {
  const mac = createHmac('sha256', Buffer.from(secret, 'base64'))
    .update(
      [
        'odyssey-unlock-challenge-v1',
        String(input.siteId),
        input.deviceSerial ?? '',
        String(input.unlockCounter),
      ].join(SEP),
    )
    .digest()
  return group(encode(mac, CODE_LENGTH))
}

/**
 * The response the control panel reads back.
 *
 * Over the NORMALISED challenge, so that what the agent typed and what the
 * machine displayed cannot differ by a dash and produce a code that is refused
 * for a reason nobody on the call can see.
 */
export function responseFor(secret: string, challenge: string): string {
  const mac = createHmac('sha256', Buffer.from(secret, 'base64'))
    .update(['odyssey-unlock-response-v1', normaliseCode(challenge)].join(SEP))
    .digest()
  return group(encode(mac, CODE_LENGTH))
}

/**
 * Does this response release the machine?
 *
 * Constant-time, though the practical value is small — an attacker at the
 * keyboard of a locked till has no oracle worth timing. It costs one function
 * call and removes the need for anyone to reason about whether it matters.
 */
export function verifyResponse(secret: string, challenge: string, supplied: string): boolean {
  const expected = normaliseCode(responseFor(secret, challenge))
  const given = normaliseCode(supplied)
  if (expected.length !== given.length || expected.length === 0) return false
  return timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(given, 'utf8'))
}
