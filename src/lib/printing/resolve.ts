import { getPrintDoc, type PrinterPaper } from './documents'

/**
 * What a machine does with a document — the resolved answer, and the types the
 * answer is made of.
 *
 * ── CLIENT-SAFE, AND THAT IS THE POINT ────────────────────────────────────
 *
 * No `server-only`, no database import. The till calls `planFor` on a config it
 * cached hours ago, with the shop's server unreachable, and gets the same
 * answer the setup screen showed. A resolution rule that existed only on the
 * server would be one a till could not consult when it most needs to.
 *
 * The transport vocabulary lives here rather than in lib/site/printers.ts for
 * the same reason moduleCatalogue.ts was split out of modules.ts: a client
 * component naming a connection kind must not drag `server-only` into the
 * browser bundle, and the failure when it does is a build error a long way from
 * the import that caused it.
 */

/**
 * How a printer is reached. Chosen once, when it is created.
 *
 *   'queue'    an OS print queue on ONE machine — a USB printer, or a network
 *              one installed in Windows. Picked from a dropdown of that
 *              machine's real queues.
 *   'network'  raw TCP to an address. No driver needed anywhere, and reachable
 *              from every machine at once.
 *
 * There used to be a third state meaning "ask each machine separately". It made
 * every printer ask the connection question twice; see sql/site/247.
 */
export type PrinterConnection = 'queue' | 'network'

/** Which pickers offer a printer. A filter, not a boundary. */
export type PrinterPurpose = 'kitchen' | 'general'

/** What a machine does with a document. */
export type PrintMode = 'printer' | 'pdf' | 'browser' | 'off'

/** One printer, as a machine sees it: already resolved, ready to open. */
export type ConfiguredPrinter = {
  id: number
  name: string
  paper: PrinterPaper
  /** Characters across, from the paper or the printer's own override. */
  columns: number | null
  connection: PrinterConnection
  /** An IP for 'network', an OS queue name for 'queue'. */
  target: string
  /** The Windows share name, for the fallback raw path. Normally blank. */
  shareName: string
  port: number | null
  drawerKick: boolean
}

/**
 * Everything one machine needs to decide where a document goes.
 *
 * Resolved on the server by `printConfigForDevice` and cached by the till, so
 * there is exactly one implementation of the site-answer-versus-machine-answer
 * rule. Two implementations of that rule is how a slip starts coming out of the
 * wrong printer after a change that only one of them understood.
 */
export type DevicePrintConfig = {
  deviceId: string
  pdfDir: string
  printers: ConfiguredPrinter[]
  assignments: { docKey: string; mode: PrintMode; printerId: number | null; copies: number }[]
}

/**
 * What to do with one document, right now.
 *
 * `unreachable` carries the printer's NAME rather than merely saying no,
 * because the difference between "nothing is set up" and "the Grill is not on
 * this machine" is the difference between a shrug and a fix.
 */
export type PrintPlan =
  | { kind: 'printer'; printer: ConfiguredPrinter; copies: number }
  | { kind: 'pdf' }
  | { kind: 'browser' }
  | { kind: 'off' }
  | { kind: 'unreachable'; printerName: string }

/**
 * The plan for one document on this machine.
 *
 * A null config — a browser, an Android till, a machine that has never synced —
 * returns `browser`, which is what every document did before this feature
 * existed. That is what makes the whole thing additive: nothing changes for a
 * document until somebody says where it should go.
 *
 * Inheritance (`defaultsTo`) is applied here as well as in the accessor,
 * because the offline config carries only the rows a shop actually wrote. One
 * hop, never a chain — the catalogue test refuses cycles, so a loop here could
 * only ever be a way to hang a till.
 */
export function planFor(docKey: string, config: DevicePrintConfig | null): PrintPlan {
  if (!config) return { kind: 'browser' }

  const doc = getPrintDoc(docKey)
  if (!doc) return { kind: 'browser' }

  let row = config.assignments.find((a) => a.docKey === docKey)
  if (!row && doc.defaultsTo) {
    row = config.assignments.find((a) => a.docKey === doc.defaultsTo)
  }
  if (!row) return { kind: 'browser' }

  if (row.mode === 'pdf') return { kind: 'pdf' }
  if (row.mode === 'off') return { kind: 'off' }
  if (row.mode === 'browser') return { kind: 'browser' }

  const printer = config.printers.find((p) => p.id === row!.printerId)
  /* `printConfigForDevice` drops printers this machine cannot reach, so a
     dangling id means exactly that — the shop pointed this document somewhere
     this machine has no way to open. Naming it is the whole value of the
     branch: falling back to the browser dialog silently would leave a manager
     believing the assignment took effect. */
  if (!printer) {
    return { kind: 'unreachable', printerName: `printer #${row.printerId ?? 0}` }
  }
  return { kind: 'printer', printer, copies: row.copies }
}

/** Whether a plan can take raw ESC/POS bytes — the offline-safe path. */
export function planTakesRaw(plan: PrintPlan): boolean {
  return plan.kind === 'printer'
}
