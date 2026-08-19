import {
  parseSpec,
  serialiseSpec,
  newBlock,
  blockKindsFor,
  requiredBlockKinds,
  DOC_BLOCK_CATALOG,
  type DocumentSpec,
  type DocBlockKind,
} from './blocks'
import { compileDocument } from './compile'
import { validateTemplate } from './validate'
import { getDocType } from './catalog'
import { DEFAULT_SPECS } from './resolve'

/**
 * Taking a design somewhere else — a copy of it, or the same design on another
 * document.
 *
 * ── WHY THIS IS NOT A ROW CLONE ───────────────────────────────────────────
 *
 * Duplicating an invoice design as another invoice design is a row clone and
 * nothing more. Copying it to a DELIVERY NOTE is not: an invoice carries a VAT
 * summary and banking details, and a delivery note must carry neither — its
 * whole purpose is that it proves what arrived without saying what it cost.
 *
 * So a copy is filtered against the target's own catalog. The good news is that
 * the filter already exists and is already trusted: `parseSpec(json, docType)`
 * drops block kinds the document may not have, tokens it does not know, table
 * columns naming another document's fields and rows pointing at nothing. It is
 * the same pass every stored design goes through on every read, which is
 * exactly why it can be relied on here — a copy is just a read against a
 * different document.
 *
 * ── AND WHY IT REPORTS ────────────────────────────────────────────────────
 *
 * Silence would be the bug. A shop that copies an invoice to a delivery note
 * and is not told the prices were dropped will assume they are still there, and
 * find out from a customer. So the result names what fell out and what had to
 * be added, in the shop's words rather than in block kinds.
 *
 * ── THE MEDIUM IS A HARD WALL ─────────────────────────────────────────────
 *
 * A till slip is an ordered list of lines with no geometry; an A4 page is boxes
 * at x and y. Neither model can express the other, so a copy across that line
 * is refused outright rather than attempted and mostly lost.
 */

export type CopyPlan = {
  ok: true
  /** The spec to save, already filtered for the target. */
  spec: DocumentSpec
  /** A suggested name — the shop can change it before saving. */
  name: string
  /**
   * Blocks the target cannot have, in the shop's words. Empty on a clean copy.
   */
  dropped: string[]
  /**
   * Blocks the target cannot do without that the source had not got, taken
   * from the target's shipped design. Empty when nothing had to be added.
   */
  added: string[]
}

export type CopyRefusal = { ok: false; error: string }

/** What a block is called when telling a shop it went missing. */
function labelOf(kind: DocBlockKind): string {
  return DOC_BLOCK_CATALOG[kind]?.label ?? kind
}

/** What a FIELD is called, for the same sentence. */
function tokenLabel(token: string, docType: string): string {
  const doc = getDocType(docType)
  if (!doc) return token
  const found = [...doc.tokens, ...doc.sections.flatMap((s) => s.tokens)].find(
    (t) => t.key === token,
  )
  return found?.label ?? token
}

/**
 * Plan a copy of `spec` onto `targetDocType`.
 *
 * Pure — it reads the catalogs and returns what would be saved, so the caller
 * can show a shop the consequences before anything is written. The action then
 * hands the result to saveTemplate, which validates it again: this function
 * decides what a copy MEANS, not whether it is allowed.
 */
export function planCopy(
  spec: DocumentSpec,
  sourceDocType: string,
  targetDocType: string,
  /** What to call it. The caller usually offers the source's name. */
  name: string,
): CopyPlan | CopyRefusal {
  const source = getDocType(sourceDocType)
  const target = getDocType(targetDocType)
  if (!source) return { ok: false, error: 'That design is for a document we no longer have.' }
  if (!target) return { ok: false, error: 'That document type does not exist.' }

  /*
   * Neither model can express the other — see the header. Refused here rather
   * than filtered, because filtering an A4 page down to what a slip can hold
   * would produce a design that is technically valid and nothing like what the
   * shop asked to copy.
   */
  if (source.medium !== target.medium) {
    return {
      ok: false,
      error:
        target.medium === 'slip'
          ? 'A page design cannot become a till slip — a slip has no columns or positions to put things in.'
          : 'A till slip design cannot become a page — a slip is a list of lines, not a layout.',
    }
  }

  /*
   * THE FILTER IS A RE-READ. Serialising and parsing against the TARGET runs
   * every rule the target has: its block kinds, its tokens, its sections. A
   * hand-rolled filter here would be a second opinion about what a document may
   * carry, and the two would disagree the first time either changed.
   */
  const copied = parseSpec(serialiseSpec(spec), targetDocType)
  if (!copied) return { ok: false, error: 'That design could not be read.' }

  /*
   * ── WORDS THE TARGET CANNOT SAY ─────────────────────────────────────────
   *
   * A `text` block holds what the SHOP typed, and parseSpec deliberately does
   * not edit it — rewriting somebody's words on read would be the worst kind of
   * silent behaviour. But an invoice's "Pay online at {doc.paymentUrl}" copied
   * onto a delivery note names a token that document has never heard of, and
   * the validator refuses to save it: a copy that cannot be saved is not a
   * copy.
   *
   * So a text block naming a token the target lacks is DROPPED WHOLE and
   * reported, rather than being quietly stripped down to "Pay online at". Half
   * a sentence is worse than an absent one, because only one of them is
   * obviously wrong.
   */
  const targetTokens = new Set(
    [...target.tokens, ...target.sections.flatMap((s) => s.tokens)].map((t) => t.key),
  )
  const strandedText: string[] = []
  copied.blocks = copied.blocks.filter((b) => {
    if (!b.text) return true
    const named = [...b.text.matchAll(/\{([a-zA-Z0-9._]+)\}/g)].map((m) => m[1])
    const orphan = named.find((t) => !targetTokens.has(t))
    if (!orphan) return true
    strandedText.push(`your own words naming {${orphan}}`)
    return false
  })

  const keptKinds = new Set(copied.blocks.map((b) => b.kind))
  const sourceKinds = new Set(spec.blocks.map((b) => b.kind))

  const dropped = [
    ...[...sourceKinds].filter((k) => !keptKinds.has(k)).map((k) => labelOf(k as DocBlockKind)),
    ...strandedText,
  ]

  /*
   * ── WHAT THE TARGET CANNOT DO WITHOUT ───────────────────────────────────
   *
   * A tax invoice must show VAT by rate; a delivery note copied onto one
   * arrives without it, and saveTemplate would refuse the result — leaving the
   * shop with an error message instead of a design.
   *
   * ── ASKED OF THE VALIDATOR, NOT OF THE BLOCK CATALOG ────────────────────
   *
   * The first attempt read requiredBlockKinds(target), and it silently did
   * nothing: that list is empty for an invoice, because the legal requirements
   * are expressed as TOKENS ("{totals.vatSummary} must appear") while the block
   * catalog marks required BLOCKS. Two vocabularies for one idea, and reading
   * the wrong one produced a copy that looked fine and would not save.
   *
   * So the question goes to the authority — compile the copy and validate it,
   * exactly as saveTemplate will — and every token it reports missing is traced
   * back to a block that provides it. Whatever the legal rules become, this
   * follows them, because it is asking the thing that enforces them.
   */
  const shipped = DEFAULT_SPECS[targetDocType]
  const added: string[] = []

  const missing = missingTokens(copied, targetDocType)
  for (const token of missing) {
    const kind = blockProviding(token, targetDocType, shipped)
    if (!kind) continue

    /*
     * ── A MISSING TOKEN IS NOT ALWAYS A MISSING BLOCK ───────────────────
     *
     * A delivery note must show {deliverTo}, and that token is not a block of
     * its own — it is one line INSIDE the party block, which an invoice
     * already has under a different heading. Adding a second party block would
     * put "DELIVER TO" on the page twice and leave the shop deleting one.
     *
     * So where the block is already here, the token joins it. Where it is not,
     * the block is grafted in whole, below.
     */
    if (keptKinds.has(kind)) {
      const host = copied.blocks.find((b) => b.kind === kind)
      if (!host) continue
      const tokens = host.tokens ?? []
      if (tokens.includes(token)) continue
      host.tokens = [...tokens, token]
      /*
       * Named as the token rather than as the block: a shop told "Deliver to
       * was added" understands it, where "Name and address was added" would
       * describe something that was already on the page.
       */
      added.push(tokenLabel(token, targetDocType))
      continue
    }

    const fromShipped = shipped?.blocks.find((b) => b.kind === kind)
    copied.blocks.push(
      fromShipped
        ? { ...fromShipped, id: newBlockIdFor(kind, copied) }
        : // newBlock takes the spec so it can place the block BELOW what is
          // already in that band — a block added at 0,0 lands on the letterhead.
          newBlock(kind, copied),
    )
    keptKinds.add(kind)
    added.push(labelOf(kind))
  }

  /*
   * The blocks the CATALOG calls required, for any document that expresses it
   * that way. Both lists are consulted because both exist — a delivery note
   * marks blocks, an invoice marks tokens, and a copy has to satisfy whichever
   * the target uses.
   */
  for (const kind of requiredBlockKinds(targetDocType)) {
    if (keptKinds.has(kind)) continue
    const fromShipped = shipped?.blocks.find((b) => b.kind === kind)
    copied.blocks.push(
      fromShipped ? { ...fromShipped, id: newBlockIdFor(kind, copied) } : newBlock(kind, copied),
    )
    keptKinds.add(kind)
    added.push(labelOf(kind))
  }

  return { ok: true, spec: copied, name, dropped, added }
}

/**
 * The tokens the target's legal rules demand and this design does not carry.
 *
 * Compiled and validated exactly as saveTemplate will do it, because the point
 * is to predict that call rather than to have an opinion about it.
 */
function missingTokens(spec: DocumentSpec, docType: string): string[] {
  const check = validateTemplate(docType, compileDocument(spec, docType))
  if (check.ok) return []
  return check.errors
    .filter((e) => e.kind === 'missing-required' && e.token)
    .map((e) => e.token as string)
}

/**
 * Which block kind would put `token` on the page.
 *
 * Found by asking the TARGET'S SHIPPED DESIGN — the one document guaranteed to
 * be both legal and typical. A hard-coded token→block map here would be a third
 * place that knows which block carries the VAT summary, and the first to go
 * stale.
 *
 * Falls back to compiling each candidate block on its own and seeing whether
 * the token appears, for a target that ships no design.
 */
function blockProviding(
  token: string,
  docType: string,
  shipped: DocumentSpec | undefined,
): DocBlockKind | null {
  if (shipped) {
    /*
     * Compiling asks the real question — "would this block put the token on the
     * page" — and it catches both shapes at once: a block that IS the token
     * (the VAT summary) and a block that merely LISTS it among others (the
     * party block carrying deliverTo). A structural check for `tokens.includes`
     * would find the second and miss the first.
     */
    for (const b of shipped.blocks) {
      if (compileDocument({ version: 1, blocks: [b] }, docType).includes(`{${token}}`)) {
        return b.kind
      }
    }
  }

  for (const kind of blockKindsFor(docType)) {
    const probe = newBlock(kind, null)
    if (compileDocument({ version: 1, blocks: [probe] }, docType).includes(`{${token}}`)) {
      return kind
    }
  }
  return null
}

/**
 * An id for a block being grafted in, that nothing already in the design uses.
 *
 * Two blocks sharing an id share a React key and a drag handle, so dragging one
 * moves the other — parseSpec re-identifies duplicates for exactly this reason,
 * and a block added after that pass has to look after itself.
 */
function newBlockIdFor(kind: DocBlockKind, spec: DocumentSpec): string {
  const taken = new Set(spec.blocks.map((b) => b.id))
  let id = `${kind}-copied`
  let n = 2
  while (taken.has(id)) id = `${kind}-copied-${n++}`
  return id
}

/**
 * The sentence a shop reads after a copy.
 *
 * One place, so the wording cannot drift between the action's result and
 * whatever the screen decides to say. Names the blocks rather than counting
 * them: "two blocks were left behind" invites the question this answers.
 */
export function describeCopy(plan: CopyPlan, targetLabel: string): string {
  const parts: string[] = [`Copied to ${targetLabel}.`]

  if (plan.dropped.length > 0) {
    parts.push(
      plan.dropped.length === 1
        ? `${plan.dropped[0]} was left behind — a ${targetLabel.toLowerCase()} has no place for it.`
        : `${plan.dropped.length} blocks were left behind: ${plan.dropped.join(', ')} — a ${targetLabel.toLowerCase()} has no place for them.`,
    )
  }

  if (plan.added.length > 0) {
    parts.push(
      plan.added.length === 1
        ? `${plan.added[0]} was added, because a ${targetLabel.toLowerCase()} cannot print without it.`
        : `These were added, because a ${targetLabel.toLowerCase()} cannot print without them: ${plan.added.join(', ')}.`,
    )
  }

  if (plan.dropped.length === 0 && plan.added.length === 0) {
    parts.push('Everything carried across.')
  }

  return parts.join(' ')
}
