'use client'

import { useEffect, useMemo, useRef, useState, useTransition, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import {
  Badge,
  type BadgeTone,
  Button,
  Card,
  CardBody,
  CardHeader,
  CurrencyInput,
  EmptyState,
  Field,
  Icons,
  Input,
  Modal,
  NumberInput,
  PageBody,
  PageHeader,
  type PickableReason,
  ReasonPicker,
  Select,
  SummaryList,
  SummaryRow,
  SummaryTotal,
  Textarea,
  useToast,
  usePrintDocument,
  TABLE,
  TABLE_HEAD_ROW,
  TABLE_NUMERIC,
  TABLE_ROW,
  TABLE_TD,
  TABLE_TD_INPUT,
  TABLE_TH,
} from '@/components/ui'
import {
  formatMoney,
  formatQty,
  round,
  roundQty,
  qtyDecimalsOf,
  DEFAULT_QTY_DECIMALS,
} from '@/lib/decimals'
import { deviceId } from '@/lib/deviceId'
import { documentTotals, lineTotals } from '@/lib/documentMath'
import {
  computeSpecials,
  effectiveDiscountPct,
  type Special,
  type RewardProduct,
} from '@/lib/specialsEngine'
import type { SalesDocument } from '@/lib/site/salesDocuments'
import type { PriceStructure, SalesRep } from '@/lib/site/lookups'
import type { TenderType } from '@/lib/site/tenderTypes'
import type { TillCustomer } from '@/lib/site/tillCustomers'
import type { TillProduct } from '@/lib/site/tillSearch'
import {
  scanAction,
  searchProductsAction,
  voidSaleAction,
  creditWholeSaleAction,
} from '@/app/(app)/sales/actions'
import { EmailInvoiceDialog } from '@/app/(app)/sales/EmailInvoiceDialog'
import ProductSearchModal, {
  type ProductSearchPick,
} from '@/components/products/ProductSearchModal'
import { AskDetailsModal } from '@/app/(pos)/pos/AskDetailsModal'
/* The till's unit picker, borrowed whole rather than reimplemented — the same
   way AskDetailsModal above is. "Which one of these am I handing over" is the
   same question at a counter as at a till, and two copies of it would be two
   places for the scan box to drift. */
import { SerialModal } from '@/app/(pos)/pos/SerialModal'
/* The till's supervisor pad, borrowed whole for the same reason the two modals
   above are. "Fetch a manager" is one interaction, and `tillOverrideAction`
   behind it needs only the till cookie — which this window mints itself (see
   (invoicing)/pinActions.ts), so a counter clerk reaches it exactly as a
   cashier does, audit row and all. */
import OverrideModal from '@/app/(pos)/pos/OverrideModal'
import type { SerialCaptureMode } from '@/lib/serialStatus'
import {
  finaliseInvoiceAction,
  getInvoiceCustomerAction,
  invoiceSerialsAction,
  saleRecordAction,
  saveInvoiceAction,
  type InvoicePayload,
} from '../actions'
import { SaleRecord } from '@/app/(app)/sales/[id]/SaleRecord'
import type { SaleRecordSnapshot } from '@/lib/site/saleRecord'
import TenderPad from './TenderPad'
import { issueQuoteAction } from '@/app/(invoicing)/invoicing/quotes/actions'
import CustomerBar from './CustomerBar'

/**
 * The editable invoice grid.
 *
 * Every figure a user can change lives in component state and is recomputed
 * locally through documentMath, so the totals panel tracks typing without a
 * round trip. The server recomputes all of it on save — this is a preview of
 * the answer, never the source of it.
 */

type EditorLine = {
  key: string
  productId: number | null
  productCode: string | null
  description: string
  productType: string
  departmentId: number | null
  salesRepUserId: number | null
  qty: number
  unitPriceIncl: number
  discountPct: number
  vatRatePct: number
  unitCostExcl: number
  /**
   * The product's discount ceiling. Null when there is no product to consult.
   *
   * On the LINE rather than looked up on demand, for the same reason
   * `allowFractions` is: the grid has to be able to judge a keystroke without
   * a round trip, and the till carries the identical field on every basket
   * line (see `BasketLine.maxDiscountPct`). Read through `discountCeilingOf`,
   * never directly — zero and null mean opposite things here.
   */
  maxDiscountPct: number | null
  /**
   * WHICH individual unit this line sells, on a serial-tracked product (235).
   *
   * On the LINE rather than gathered at finalise, matching the till and for the
   * reason migration 235 gives: a value that exists only at finalise cannot
   * survive a save, and an invoice is captured, saved and reopened across
   * several sittings far more often than a till sale is. A draft that has
   * promised a particular laptop has to still know which one tomorrow morning.
   *
   * `serialLabel` rides beside it so the grid can SHOW the number without
   * re-reading the units — the id is what posts, the label is what a person
   * checks against the box in their hand.
   *
   * Null on every ordinary line, and on a serial line that has not been asked
   * yet — which the save guard below is what stops reaching the server.
   */
  serialId: number | null
  serialLabel: string | null
  /**
   * Whether this product may be sold in fractions, and to how many places.
   *
   * Both carried on the LINE rather than looked up per keystroke, exactly as
   * `BasketLine` carries them: the grid re-renders on every character typed
   * into any cell, and a rule that had to be fetched would either block the
   * keystroke or arrive after it.
   *
   * Read through `qtyDecimalsOf`, never directly — `qtyDecimals` is meaningless
   * while `allowFractions` is off, and is deliberately left at whatever the
   * shop last chose so switching fractions off and on again does not lose it.
   *
   * A line with no product — free text on a quote — gets the permissive pair:
   * there is no product file to ask, and a typed description has never had a
   * quantity rule to break.
   */
  allowFractions: boolean
  qtyDecimals: number
  /**
   * Priced as a percentage of the rest of the document (006) — the same pair
   * `BasketLine` carries, for the same reason and with the same meaning.
   *
   * `unitPriceIncl` holds the recomputed MONEY so every total, VAT figure and
   * export reads this line like any other; `chargePct` holds the rate the money
   * is derived from. A line with no product is never one of these.
   */
  chargePctSubtotal?: boolean
  chargePct?: number
  /**
   * The special that PUT this line here — a product given away rather than
   * discounted. See the same field on BasketLine for why a reward has to be a
   * line rather than a percentage.
   *
   * It also marks the line as the ENGINE's rather than the typist's, which is
   * what lets the reconciliation below add and remove rewards without ever
   * touching a line somebody entered by hand.
   */
  rewardSpecialId?: number
}

let keySeq = 0
const nextKey = () => `line-${++keySeq}`

/*
 * Local until sales/status.ts exists. Never print the raw enum: a "draft" is
 * unfinished typing, a "saved" invoice is waiting to be finalised — the words
 * and tones have to keep those apart.
 */
/**
 * The discount ceiling to hold a line to, or null for "do not hold it to one".
 *
 * ── WHY ZERO AND NULL CANNOT BE THE SAME ANSWER ──────────────────────────
 *
 * `products.max_discount_pct` defaults to 0, and 0 means "this product may not
 * be discounted by a cashier" — the reading `checkPricing` enforces at save,
 * and the one the specials engine's `respectMaxDiscount` guard applies. A
 * ceiling is opted into per product; it is not an unset field.
 *
 * Null is the different fact that there is no product file to consult: a
 * free-text line on a quote, or a line whose product has since been deleted.
 * `checkPricing` SKIPS those — `if (!line.productId) continue`, then a `byId`
 * miss — so the grid must skip them too. Reading absence as a zero ceiling
 * would refuse in the browser what the server is perfectly happy to save.
 */
function discountCeilingOf(line: EditorLine): number | null {
  return line.productId === null ? null : line.maxDiscountPct
}

const STATUS_LABELS: Record<SalesDocument['status'], string> = {
  draft: 'Draft',
  saved: 'Saved',
  issued: 'Issued',
  finalised: 'Finalised',
  cancelled: 'Cancelled',
}
const STATUS_TONE: Record<SalesDocument['status'], BadgeTone> = {
  draft: 'neutral',
  saved: 'warning',
  issued: 'brand',
  finalised: 'success',
  cancelled: 'neutral',
}

/**
 * One cell of the document's header strip — a glyph beside a field.
 *
 * The left hairline belongs to the CELL rather than to the strip. Tailwind's
 * `divide-x` puts a border on every child but the first, which the strip's own
 * `gap` then holds away from anything, so the rules were drawn floating in the
 * gutter instead of between the columns.
 *
 * Dropped below `lg`, where the cells stack into a single column and a
 * left-hand border would be drawing an edge that is no longer there.
 *
 * Exported so the quote screen's "Valid until" can be shaped identically —
 * a cell that came from another file has to match its neighbours exactly, and
 * a second copy of these classes is how that quietly stops being true.
 *
 * ── WHY BOTH A MIN AND A MAX ──────────────────────────────────────────────
 *
 * `flex-1` from `min-w-56` lets the cells share the row and wrap in step
 * rather than each demanding a fixed width and shoving one sibling onto a line
 * of its own — which is what the fifth cell did on a quote at 1280px.
 *
 * `max-w-72` is the other half of that. A cell that DOES wrap ends up alone on
 * its row, where `flex-1` would stretch it edge to edge and print a date box
 * the width of the page. Bounded, a wrapped cell keeps the same size it had
 * beside its siblings.
 */
export const HEADER_CELL =
  'flex min-w-56 max-w-72 flex-1 items-start gap-3 lg:border-l lg:border-border lg:pl-5 lg:ml-5'

export default function InvoiceEditor({
  document,
  structures,
  reps,
  defaultRepUserId = null,
  tenders,
  cashRounding,
  serialCapture,
  customer: initialCustomer,
  editable,
  canOverrideDiscount,
  canOverridePrice,
  canOverrideQty,
  scanFocus = 'scan',
  operatorName,
  showCost,
  specials,
  extraStatus = null,
  voidReasons = [],
  returnReasons = [],
  canVoid = false,
  canCredit = false,
  depositHeld = 0,
  detailsSlot = null,
  hasSectionsBelow = false,
}: {
  document: SalesDocument
  structures: PriceStructure[]
  reps: SalesRep[]
  /**
   * Whoever is capturing, pre-selected on every new line. Null when they are
   * not a selectable rep, in which case lines start unattributed as before.
   */
  defaultRepUserId?: number | null
  tenders: TenderType[]
  cashRounding: number
  /** Whether the unit picker may list what is on hand, or insists on the number. */
  serialCapture: SerialCaptureMode
  /** The attached account's credit position, or null for a once-off. */
  customer: TillCustomer | null
  editable: boolean
  canOverrideDiscount: boolean
  canOverridePrice: boolean
  /**
   * Whether this person may sell other than one of whatever was scanned.
   *
   * Without it the quantity cell still TAKES a number — see the note beside it
   * — and a supervisor's PIN is what lets the number stick.
   */
  canOverrideQty: boolean
  /**
   * Where the cursor goes once a line has been added: back to the entry box, or
   * into the new line's quantity. The shop's `invoicing_scan_focus`.
   */
  scanFocus?: 'scan' | 'qty'
  /**
   * Whoever is at the counter, for the audit row a supervisor override writes.
   * The server never trusts it for identity — it names the CASHIER being
   * approved, while the manager comes from the PIN.
   */
  operatorName?: string
  /** The shop's live promotions. See the note on lineSpecials below. */
  specials: Special[]
  /** Whether this person may see cost and margin. */
  showCost: boolean
  /**
   * An extra badge for the header row, from the screen that owns the document.
   *
   * An order has TWO states and they answer different questions: `Draft` is
   * "has this been saved", which the editor knows, and `Open` is "has any of it
   * been delivered", which only the order screen does. Both belong on the same
   * line as the title — a status floating on its own above a heading reads as
   * something that fell off.
   *
   * Rendered first, so the fulfilment state leads and the document state sits
   * beside the buttons that change it.
   */
  extraStatus?: ReactNode
  /**
   * The site's reason lists, for the dialog shown once this invoice posts.
   *
   * Empty by default so the back-office editor — which has a document viewer
   * one click away — is unchanged by this.
   */
  voidReasons?: PickableReason[]
  returnReasons?: PickableReason[]
  /** Whether this ROLE may cancel / credit. Both re-checked by the actions. */
  canVoid?: boolean
  canCredit?: boolean
  /**
   * Money already held against this document, so the tender pad asks for the
   * balance rather than the whole total. Zero for a document with no deposit,
   * which is the overwhelming majority. See TenderPad's `depositHeld`.
   */
  depositHeld?: number
  /**
   * Extra fields for the details card, from the screen that owns the document.
   *
   * A quote's "Valid until" is one of the things you set while capturing the
   * header — same breath as the date and the customer's reference — so it
   * belongs in the same card as those, not in a panel below the lines. The
   * editor cannot own it (an invoice has no validity), so the quote screen
   * hands the field down and the editor just gives it the last cell.
   */
  detailsSlot?: ReactNode
  /**
   * Whether the owning screen renders more sections below this editor.
   *
   * The editor's PageBody normally ends the page and so carries `pb-10`. On
   * the invoice, quote and order screens it does not — a deposit panel, an
   * outcome panel and proof of delivery follow it — and that trailing 40px
   * doubled the seam under the grid. Set it where those sections exist; the
   * screen that sets it owns the real bottom padding instead.
   */
  hasSectionsBelow?: boolean
}) {
  const toast = useToast()
  /* Named `printDoc` because this file already has a `printDocument` function
     that saves first and then calls this. */
  const printDoc = usePrintDocument()
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  /*
   * This machine, so a saved invoice records the till it was captured on.
   *
   * Read after mount because `deviceId()` returns null during SSR by design —
   * it reads the desktop shell's machine id or localStorage, neither of which
   * exists on the server. The value is sent as-is and the SERVER decides which
   * terminal it belongs to; nothing here picks a till, and there is no control
   * for one. Null until the effect runs, which only matters for a save fired in
   * the first frame — and that save would have carried no till before this
   * existed either.
   */
  const [device, setDevice] = useState<string | null>(null)
  useEffect(() => setDevice(deviceId()), [])

  /* The "name this sale" prompt. Only ever opened by Save (draft) on a
     document with no customer — see save(). */
  const [namingSale, setNamingSale] = useState(false)
  const [customerId, setCustomerId] = useState(document.customerId)
  const [customerName, setCustomerName] = useState(document.customerName ?? '')
  /*
   * ── A DOCUMENT WITH NO PRICE STRUCTURE FALLS BACK TO THE SHOP'S DEFAULT ──
   *
   * A null structure prices everything at zero: `selectProduct` left-joins
   * `product_prices` on the structure it is given, so with none there is no
   * row to join and every product resolves at 0.00. `createBlankDocument`
   * fixed that for documents made from then on, but it only runs at CREATION
   * — every draft, quote and order started before it, and any document
   * written by an older importer or automation, still carries NULL and is
   * still unpriceable.
   *
   * Worse, nothing on screen said so. The Select below renders one option per
   * structure and no blank, so a null value matched nothing and the browser
   * drew the FIRST option: the header read "Retail" while this state held
   * null. Picking Retail out of the list could not fix it either, because
   * Retail was already what the box showed and choosing it fires no change.
   * "It says Retail and everything adds at R0.00" is that.
   *
   * The shop's own default is what an unattached walk-in is charged
   * everywhere else — the same figure `createBlankDocument` reaches for — and
   * `structures` is already in hand, filtered to the active ones, so this
   * costs no query. Only while the document may still change: a finalised
   * invoice is a record, and a record with no structure should read as one
   * (see the placeholder option on the Select).
   */
  const [priceStructureId, setPriceStructureId] = useState(
    document.priceStructureId ??
      (editable ? (structures.find((s) => s.isDefault) ?? structures[0])?.id ?? null : null),
  )
  const [reference, setReference] = useState(document.reference ?? '')
  const [documentDate, setDocumentDate] = useState(document.documentDate)
  const [notes, setNotes] = useState(document.notes ?? '')

  const [lines, setLines] = useState<EditorLine[]>(() =>
    document.lines.map((l) => ({
      key: nextKey(),
      productId: l.productId,
      productCode: l.productCode,
      description: l.description,
      productType: l.productType,
      departmentId: l.departmentId,
      /* A line that already names someone keeps them — reopening a draft must
         not quietly re-attribute a colleague's work to whoever opened it. The
         default only fills a gap, and only while the document can still be
         changed: a finalised invoice is a record, not a form. */
      salesRepUserId: l.salesRepUserId ?? (editable ? defaultRepUserId : null),
      /* The unit a saved line already promised, carried straight back. Without
         this a draft reopened tomorrow would come back having forgotten which
         laptop it named, and the save guard would ask for it again — on a line
         the customer has already been quoted. */
      serialId: l.serialId,
      serialLabel: l.serialNumber,
      qty: l.qty,
      unitPriceIncl: l.unitPriceIncl,
      discountPct: l.discountPct,
      vatRatePct: l.vatRatePct,
      unitCostExcl: l.unitCostExcl,
      /* Joined fresh by getDocument, like the quantity rule below, and
         carrying the same null-vs-zero distinction — see `discountCeilingOf`. */
      maxDiscountPct: l.maxDiscountPct,
      /* Joined fresh from the product by getDocument, not snapshotted onto the
         line — so reopening a draft honours the rule as it stands now. The
         stored `qty` is deliberately NOT re-rounded to it: what was captured is
         a fact about this document, and silently altering a saved quantity on
         open would change a figure somebody may already have quoted. A tightened
         rule bites on the next EDIT, which is where the person is looking. */
      allowFractions: l.allowFractions,
      qtyDecimals: l.qtyDecimals,
    })),
  )

  const [entry, setEntry] = useState('')
  const entryRef = useRef<HTMLInputElement>(null)

  /*
   * The quantity cells, by line key, so a new line can be focused on arrival
   * under `invoicing_scan_focus: 'qty'`.
   *
   * A Map in a ref rather than state: registering a cell must not re-render the
   * grid, and the ref is read one tick later by the effect below, by which time
   * every row has mounted and populated it.
   */
  const qtyRefs = useRef(new Map<string, HTMLInputElement | null>())

  /*
   * The key of the line most recently appended.
   *
   * A ref rather than state because `addProduct` reads it in the same tick it
   * appended — inside the transition, before any re-render — and state would
   * still hold the previous line's key there. `appendLine` mints the key, so
   * this is the only way the caller can learn it without `appendLine` changing
   * shape for the several other callers that do not care.
   */
  const lastKeyRef = useRef<string | null>(null)

  /*
   * The line whose quantity should take focus, or null.
   *
   * Set by `appendLine` and consumed by an effect rather than focused inline,
   * because at the moment the line is appended its input does not exist yet —
   * React has not rendered the row. The effect runs after it has.
   */
  const [focusQtyKey, setFocusQtyKey] = useState<string | null>(null)

  useEffect(() => {
    if (!focusQtyKey) return
    const input = qtyRefs.current.get(focusQtyKey)
    /* Selected, not merely focused. The cell already holds 1, and a clerk who
       lands there is about to replace it — leaving the caret after the digit
       turns a typed 3 into 13. */
    input?.focus()
    input?.select()
    setFocusQtyKey(null)
  }, [focusQtyKey])

  /*
   * A quantity a supervisor is being asked about.
   *
   * Held until the PIN lands: the cell shows the typed figure meanwhile, and
   * `onAuthorised` is what writes it into the line. Cancelling puts the old
   * figure back, so a refused approval leaves the document as it was rather
   * than as it was mid-keystroke.
   */
  const [qtyApproval, setQtyApproval] = useState<{
    key: string
    description: string
    from: number
    to: number
  } | null>(null)

  /*
   * The lines a supervisor has already approved a quantity on.
   *
   * Without this the pad reappears every time the cell is left — tabbing
   * through the grid to check a figure would ask for a PIN again on a line the
   * manager stood there and approved thirty seconds ago. The approval is for
   * THIS line on THIS document, and it dies with the page.
   *
   * Keyed by line key rather than by quantity, so nudging an approved 12 to 13
   * does not re-ask. That is deliberate: the manager approved "this clerk may
   * set a quantity on this line", and re-prompting on each adjustment of an
   * already-authorised line is the kind of friction that gets a supervisor to
   * hand out their PIN.
   */
  const [approvedQtyKeys, setApprovedQtyKeys] = useState<ReadonlySet<string>>(new Set())

  /**
   * A quantity leaving its cell: rounded, and approved if it needs approving.
   *
   * ── WHY ONE IS THE LINE THAT NEEDS NO PERMISSION ─────────────────────────
   *
   * Because one is what a scan PUTS there. `appendLine` opens every line at 1,
   * so a counter that scans each item individually never touches this at all,
   * and the only way to reach any other figure is to have typed it. That makes
   * "not 1" a precise description of the act the shop is withholding, and it
   * needs no memory of what the line started as — which matters, because a
   * remembered starting figure is a claim the client would be making about
   * itself.
   *
   * Typing a line back DOWN to 1 is therefore always free: it is the undo of
   * the act, and refusing it would trap a clerk who fat-fingered a 2 with no
   * way back that does not involve a manager.
   */
  function commitQty(line: EditorLine) {
    const rounded = roundQty(line.qty, line)

    /* Rounded BEFORE the comparison. A 3-decimal product holding 0.9999 from a
       float is a 1, and asking a manager to approve it would be the app
       apologising for its own arithmetic. */
    if (rounded !== line.qty) patch(line.key, { qty: rounded })

    if (canOverrideQty) return
    if (rounded === 1) return
    if (approvedQtyKeys.has(line.key)) return

    /* Zero is not sent for approval. It is refused outright at save by the
       existing line validation, and a manager approving "nothing of this
       product" would be approving a line that cannot be saved either way. */
    if (rounded === 0) return

    setQtyApproval({
      key: line.key,
      description: line.description,
      from: 1,
      to: rounded,
    })
  }

  /*
   * The product search dialog.
   *
   * The entry box below the grid only resolves an exact code or barcode, which
   * is the right tool with the product in your hand and the wrong one when the
   * customer says "the blue one, 20 mil". This is how you look without knowing
   * the code.
   *
   * The dialog itself is the SHARED one — components/products/ProductSearchModal
   * — rather than a picker belonging to this screen. It used to be a search box
   * over a flat list of 500 rows with a department picker beside it, which
   * answered "what is this called" and nothing else. The shared one is the
   * products grid: sortable columns, the advanced filter, a column picker of
   * its own, and tick boxes for adding several at once.
   *
   * Kept out of `pending`: that transition disables the whole invoice while a
   * save is in flight, and a search that greys out the grid behind it would
   * make the dialog feel like it was committing something.
   */
  const [searchOpen, setSearchOpen] = useState(false)
  /** A product waiting for its typed description and/or price (006). */
  const [askingDetails, setAskingDetails] = useState<{
    product: TillProduct
    description: boolean
    price: boolean
  } | null>(null)

  /**
   * A serial product waiting for somebody to say WHICH unit (235).
   *
   * `product` is what the answer gets appended as; `line` names an EXISTING
   * line when the picker was opened from the grid to change or fill in its
   * unit, and is null when a new line is being added. One piece of state for
   * both because only one picker can be open at a time, and the two differ
   * only in what happens when it confirms.
   */
  const [askingSerial, setAskingSerial] = useState<{
    product: TillProduct | null
    line: string | null
    productId: number
    description: string
  } | null>(null)
  const [serialUnits, setSerialUnits] = useState<
    { id: number; serial: string; receivedAt: string | null }[]
  >([])
  const [serialsLoading, setSerialsLoading] = useState(false)
  /* The description/price answers, held while the unit question is asked after
     them. A product can want all three, and the first two would otherwise be
     lost between the two dialogs. */
  const [pendingAnswers, setPendingAnswers] = useState<{
    description: string
    price: number
  } | null>(null)

  /**
   * Opens the unit picker and fetches what is on the shelf.
   *
   * The units are read on every open rather than cached: an invoice sits open
   * for a long time and another counter may have sold one in the meantime, so
   * a cached list is how two documents promise the same laptop. `checkSellable`
   * at post time is the real guard, but asking fresh means the usual case is
   * answered correctly rather than caught.
   */
  function askForSerial(
    found: TillProduct | null,
    existing?: { key: string; productId: number; description: string },
  ) {
    const productId = existing?.productId ?? found?.id ?? null
    if (productId === null) return

    setAskingSerial({
      product: found,
      line: existing?.key ?? null,
      productId,
      description: existing?.description ?? found?.description ?? 'this product',
    })
    setSerialUnits([])
    setSerialsLoading(true)
    /* The DEVICE, not a terminal: this screen never picks a till and cannot
       name one, so the server resolves the room from the machine exactly as
       every save on this screen already does. An unclaimed machine comes back
       empty, which the picker reads as "none on hand here". */
    void invoiceSerialsAction(productId, device)
      .then((rows) => setSerialUnits(rows))
      .catch(() => setSerialUnits([]))
      .finally(() => setSerialsLoading(false))
  }

  const [tendering, setTendering] = useState(false)
  const [receipt, setReceipt] = useState<{
    documentId: number
    number: string
    change: number
  } | null>(null)

  /*
   * The posted invoice as a RECORD, for the dialog to show.
   *
   * Read back from the server rather than assembled from what is on screen: the
   * capture form holds what was typed, and what matters now is what was STORED
   * — the numbers the posting engine settled on, the tenders it wrote, the
   * document number it allocated. Null while it loads, which is the one beat
   * between the dialog opening and the record arriving.
   */
  const [record, setRecord] = useState<SaleRecordSnapshot | null>(null)

  /*
   * The finalised dialog's two destructive paths.
   *
   * Kept as a 'which face is showing' value rather than nested modals: a
   * <dialog> inside an open <dialog> is a stacking problem, and the counter is
   * answering one question at a time — print it, or cancel it, or credit it.
   * `null` is the ordinary face with the four buttons.
   */
  const [finalisedFace, setFinalisedFace] = useState<'void' | 'credit' | null>(null)
  const [emailingPosted, setEmailingPosted] = useState(false)
  const [postedReasonId, setPostedReasonId] = useState<number | null>(null)
  const [postedNote, setPostedNote] = useState("")

  /**
   * Cancelling the invoice that was just posted, without leaving the counter.
   *
   * Same action the back-office viewer calls, so the same rules apply: it
   * re-resolves the operator, re-checks `sales.void`, and refuses anything that
   * is not same-day. A refusal is shown as a toast and the dialog stays open on
   * the reason face, because the counter still has a customer in front of them
   * and needs to know what happened.
   */
  function voidPosted() {
    if (!receipt || postedReasonId === null) return
    startTransition(async () => {
      const result = await voidSaleAction(receipt.documentId, {
        reasonId: postedReasonId,
        note: postedNote.trim() || null,
      })
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(`${receipt.number} cancelled. The stock has been returned.`)
      leaveFinalised()
    })
  }

  /** Crediting it in full — the after-today answer to the same mistake. */
  function creditPosted() {
    if (!receipt || postedReasonId === null) return
    startTransition(async () => {
      const result = await creditWholeSaleAction(receipt.documentId, {
        reasonId: postedReasonId,
        note: postedNote.trim() || null,
      })
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(`${receipt.number} credited in full.`)
      leaveFinalised()
    })
  }

  /** Closes the dialog and leaves the counter ready for the next customer. */
  function leaveFinalised() {
    setReceipt(null)
    setRecord(null)
    setFinalisedFace(null)
    setPostedReasonId(null)
    setPostedNote("")
    /* Back to the register rather than the back office: this window is where
       the next customer is served, and the list re-reads so the invoice just
       posted is on it. */
    router.push('/invoicing')
  }

  /*
   * The credit position of whoever is attached right now.
   *
   * Re-fetched when the customer changes rather than derived from the picker's
   * row, because the tender pad refuses the account tender on balance and limit
   * — and the balance moves while this invoice is being captured.
   */
  const [customer, setCustomer] = useState<TillCustomer | null>(initialCustomer)

  useEffect(() => {
    if (customerId === null) {
      setCustomer(null)
      return
    }
    if (customerId === customer?.id) return

    let cancelled = false
    getInvoiceCustomerAction(customerId).then((fresh) => {
      if (cancelled) return
      setCustomer(fresh)
      /*
       * The account's OWN structure (customer → group, resolved server-side)
       * takes over when one is set and the document may still change. The
       * dropdown stays as the manual override — this only moves the default
       * when a different account is attached. Lines already on the document
       * keep their prices: checkPricing re-reads the structure at save, so a
       * price that no longer matches is refused there with the reason, which
       * beats silently rewriting figures under the person's cursor.
       */
      if (fresh?.priceStructureId && editable && fresh.priceStructureId !== priceStructureId) {
        setPriceStructureId(fresh.priceStructureId)
        toast.info(`Pricing follows ${fresh.name}'s structure for new lines.`)
      }
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- priceStructureId
    // is read for the comparison only; reacting to it would loop the adopt.
  }, [customerId, customer?.id])

  /* ── Totals ──────────────────────────────────────────────────────────── */

  /*
   * ── What each line is entitled to ──────────────────────────────────────
   *
   * Recomputed when the lines change, and DELIBERATELY NOT on a timer — unlike
   * the till. A till is worked in seconds and a slip must match the shelf edge
   * right now; an invoice is edited over minutes, and re-pricing it under
   * someone's cursor while they type would be worse than a figure that is a
   * few minutes stale. It refreshes on the next edit or reload.
   */
  /**
   * The lines as the engine should see them.
   *
   * A reward the engine granted goes in at quantity zero: it keeps its slot so
   * the results stay index-aligned, but it must not count towards anything.
   * Feeding a granted line back in inflates the deal count, and since this
   * recomputes on every edit that inflation would compound.
   */
  const engineLines = useMemo(
    () =>
      lines.map((l) => ({
        productId: l.productId ?? -1,
        departmentId: l.departmentId ?? null,
        priceIncl: l.unitPriceIncl,
        // A credit line earns nothing — see the engine's note on refunds.
        qty: l.rewardSpecialId !== undefined ? 0 : Math.max(l.qty, 0),
        // For the margin guards. An invoice line carries its cost the same way
        // a till line does, so a special that refuses to sell below cost holds
        // on both screens rather than only at the counter.
        costExcl: l.unitCostExcl,
        /*
         * And for the `respectMaxDiscount` guard, for exactly the same reason.
         *
         * The engine SKIPS that guard when the field is absent rather than
         * guessing at it (see `BasketLine.maxDiscountPct`) — which is right for
         * the storefront, but meant a special marked "honour the product's
         * maximum discount" was honoured at the till and ignored here. The
         * same promotion has to reduce a line by the same amount on both
         * screens or the invoice does not match the slip.
         *
         * `undefined` on a line with no product, which is the case the engine's
         * skip is actually for.
         */
        maxDiscountPct: discountCeilingOf(l) ?? undefined,
      })),
    [lines],
  )

  /**
   * Who the invoice is for, so a targeted promotion knows whether to fire.
   *
   * The customer is already state here, re-fetched whenever it changes. There
   * is no loyalty member concept on this screen, so `isMember` is false and a
   * members-only special correctly does not apply to an invoice.
   */
  const pricingContext = useMemo(
    () => ({
      accountType: customer?.accountType ?? null,
      groupId: customer?.groupId ?? null,
      isMember: false,
      channel: 'in_store' as const,
    }),
    [customer],
  )

  /**
   * The first line discounted past what its product allows, or null.
   *
   * ── WHY THIS EXISTS AT ALL, AND WHY IT IS NOT THE ENFORCEMENT ────────
   *
   * `checkPricing` refuses the save with this same sentence, and that is the
   * thing that actually stops it — a server action is a public endpoint and the
   * client composes the request. This is the courtesy: without it a typist
   * discounts six lines, presses Finalise with a customer at the counter, and
   * only then learns that line one was never allowed. The till marks the
   * breach as it is typed (see LineEditModal's `refusal`); so does this.
   *
   * Judged on the TYPED percentage rather than the effective one a special
   * produces. A promotion's contribution is not in any cell, so refusing the
   * save over it would be a dead end with nothing to correct — the server
   * still has the last word on the effective figure, which is where a
   * promotion that overshoots surfaces.
   *
   * Nothing to say for somebody holding `sales.discount_override`: the
   * capability is precisely permission to exceed the ceiling ("Discount beyond
   * the product limit"), so for them there is no breach to report.
   */
  const discountRefusal = useMemo(() => {
    if (canOverrideDiscount) return null
    for (const [index, line] of lines.entries()) {
      const ceiling = discountCeilingOf(line)
      if (ceiling === null) continue
      /* The same cent of tolerance `checkPricing` allows, for the same reason:
         a rounding artefact is not an override. */
      if (line.discountPct <= ceiling + 0.01) continue
      const where = line.description.trim() || `Line ${index + 1}`
      return ceiling > 0
        ? `${where}: ${line.discountPct}% is more than the ${ceiling}% this product allows. A supervisor can authorise it.`
        : `${where}: this product cannot be discounted. A supervisor can authorise it.`
    }
    return null
  }, [lines, canOverrideDiscount])

  const lineSpecials = useMemo(() => {
    if (specials.length === 0) return lines.map(() => undefined)
    return computeSpecials(engineLines, specials, new Date(), pricingContext).lineSpecials
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `lines` only for
    // the empty-specials shortcut above; engineLines already tracks it.
  }, [engineLines, specials, pricingContext])

  /**
   * The products this invoice has EARNED, put on it.
   *
   * The same reconciliation the till does, and for the same reasons — see the
   * SYNC_REWARDS action and `withRewards`. An effect rather than part of the
   * memo above, because a reward CHANGES the lines and a render must not write
   * state. It settles in one pass: nothing earned and nothing granted returns
   * early, and an unchanged answer produces an identical array.
   */
  useEffect(() => {
    if (specials.length === 0) return
    const rewards = computeSpecials(engineLines, specials, new Date(), pricingContext).rewards
    if (rewards.length === 0 && !lines.some((l) => l.rewardSpecialId !== undefined)) return

    const described = new Map<number, RewardProduct>()
    for (const special of specials) {
      for (const product of special.rewardProducts ?? []) described.set(product.productId, product)
    }

    setLines((current) => {
      const own = current.filter((l) => l.rewardSpecialId === undefined)
      const existing = new Map(
        current
          .filter((l) => l.rewardSpecialId !== undefined)
          .map((l) => [`${l.rewardSpecialId}-${l.productId}`, l]),
      )

      const granted: EditorLine[] = []
      for (const reward of rewards) {
        if (reward.qty <= 0) continue
        const already = existing.get(`${reward.specialId}-${reward.productId}`)
        if (already) {
          granted.push(already.qty === reward.qty ? already : { ...already, qty: reward.qty })
          continue
        }
        const product = described.get(reward.productId)
        // A reward naming a product that cannot be described is not granted —
        // better a deal that quietly does not pay than a blank line.
        if (!product) continue
        granted.push({
          key: nextKey(),
          productId: product.productId,
          productCode: product.code,
          description: product.description,
          productType: product.productType,
          departmentId: product.departmentId,
          salesRepUserId: null,
          /* A promotion cannot name a unit — nobody chose this line, the deal
             put it here. A serial product given away therefore lands needing
             its unit answered like any other, which `refuseMissingSerial`
             catches before the sale posts. */
          serialId: null,
          serialLabel: null,
          qty: reward.qty,
          // Free, not marked down: a discount is something a person chose to
          // give, while this is the promotion paying out as it was set up.
          unitPriceIncl: 0,
          discountPct: 0,
          vatRatePct: product.vatRatePct,
          // Costed even though free, so the giveaway shows against the margin.
          unitCostExcl: product.costExcl,
          /* Zero, not null: a line the promotion gave away is not a line to
             discount further, and the reward payload carries no ceiling to
             consult. The till's granted lines say the same (see PosShell). */
          maxDiscountPct: 0,
          /* Whole units, matching the till's reward lines (see `describe` in
             PosShell). A reward is a count of things given away, decided by the
             engine rather than typed — and the describe payload carries no
             fraction rule to consult, so this fails closed rather than
             inventing permission the product may not grant. */
          allowFractions: false,
          qtyDecimals: DEFAULT_QTY_DECIMALS,
          rewardSpecialId: reward.specialId,
        })
      }

      /*
       * The SAME array back when nothing moved, so React bails out of the
       * re-render and this effect settles rather than looping.
       *
       * "Nothing moved" has to mean every granted line is the very object that
       * was already there, in the same order, with no line dropped — comparing
       * only the counts would loop forever the first time a reward's quantity
       * changed, since a new object with the same length looks identical.
       */
      const unchanged =
        own.length + granted.length === current.length &&
        granted.every((line, index) => current[own.length + index] === line)
      return unchanged ? current : [...own, ...granted]
    })
  }, [engineLines, specials, lines, pricingContext])

  /**
   * Percentage-charge lines re-derived from the rest of the document (006).
   *
   * The till does this inside its reducer, which every line change passes
   * through; this editor has no reducer, so it is an effect over `lines` —
   * the same shape as the reward reconciliation above, and settling the same
   * way: an unchanged answer returns the very same array, React bails out of
   * the re-render, and the effect does not loop.
   *
   * The base is the ORDINARY lines only, and it is taken AFTER discounts, for
   * both of the reasons set out on `repriceCharges`: charges must not compound
   * on one another, and a service charge is taken on what the customer actually
   * pays. `effectiveDiscountPct` is used so the base matches the figure the
   * totals below are built from rather than a second opinion about it.
   */
  useEffect(() => {
    if (!lines.some((l) => l.chargePctSubtotal)) return

    const base = lines.reduce(
      (sum, l, i) =>
        l.chargePctSubtotal
          ? sum
          : sum +
            lineTotals({
              qty: l.qty,
              unitPriceIncl: l.unitPriceIncl,
              discountPct: effectiveDiscountPct(l.discountPct, lineSpecials[i]),
              vatRatePct: l.vatRatePct,
            }).lineTotalIncl,
      0,
    )

    setLines((current) => {
      let moved = false
      const next = current.map((l) => {
        if (!l.chargePctSubtotal) return l
        const whole = round(base * ((l.chargePct ?? 0) / 100), 2)
        const unit = l.qty === 0 ? 0 : round(whole / l.qty, 2)
        if (unit === l.unitPriceIncl) return l
        moved = true
        return { ...l, unitPriceIncl: unit }
      })
      return moved ? next : current
    })
  }, [lines, lineSpecials])

  const computed = useMemo(() => {
    const per = lines.map((l, i) =>
      lineTotals({
        qty: l.qty,
        unitPriceIncl: l.unitPriceIncl,
        // The better of the special and any discount typed by hand. They never
        // compound — see effectiveDiscountPct.
        discountPct: effectiveDiscountPct(l.discountPct, lineSpecials[i]),
        vatRatePct: l.vatRatePct,
      }),
    )
    const totals = documentTotals(
      per.map((t, i) => ({ ...t, vatRatePct: lines[i].vatRatePct })),
    )

    // Cost is EXCLUSIVE, so margin must be measured against the exclusive
    // selling figure. Comparing cost to an inclusive total would report a
    // margin the VAT is paying for.
    const costTotal = round(
      lines.reduce((sum, l) => sum + l.unitCostExcl * l.qty, 0),
      2,
    )
    const gpValue = round(totals.subtotalExcl - costTotal, 2)
    const gpPct = totals.subtotalExcl === 0 ? 0 : round((gpValue / totals.subtotalExcl) * 100, 2)

    return { per, totals, costTotal, gpValue, gpPct }
  }, [lines])

  /* ── Line entry ──────────────────────────────────────────────────────── */

  /**
   * Puts a resolved product on the invoice.
   *
   * Separate from the lookup below because there are two ways to arrive here —
   * typing a code, and choosing from the search dialog — and only the first has
   * anything to resolve. The dialog already holds the product.
   */
  /**
   * Adds a product, asking first for anything its file says is typed here (006).
   *
   * Both entry paths — the search dialog and the typed code — converge on
   * `appendLine`, so the prompt sits in front of it rather than in each caller.
   * Same reason the till puts its version in `add()`.
   */
  function addWithPrompts(found: TillProduct) {
    const wantsDescription = found.changeDescription
    const wantsPrice = found.askPriceAtSale
    if (wantsDescription || wantsPrice) {
      setAskingDetails({ product: found, description: wantsDescription, price: wantsPrice })
      return
    }
    /*
     * WHICH unit, on a serial-tracked product (235).
     *
     * Asked HERE, at the moment the line is created, rather than gathered at
     * finalise the way job-card invoicing supplies its units. Two reasons, and
     * the first is the bug this closes: nothing on this screen ever asked, so a
     * serial product could be captured, saved, and was refused at ISSUE with
     * "choose 1 serial number — 0 selected" — the same shape of failure the
     * till had before 235, on a document that may by then have been quoted to
     * the customer.
     *
     * The second is that an invoice is reopened far more than a till sale is.
     * A unit named at finalise would have to be re-chosen every sitting; one
     * named on the line is saved with it.
     *
     * After the description/price prompt rather than before, so a product that
     * asks all three asks in the order the answers are needed — the unit is the
     * last question because it is the only one about a physical object.
     */
    if (found.productType === 'serial') {
      askForSerial(found)
      return
    }
    appendLine(found)
  }

  function appendLine(
    found: TillProduct,
    answers?: { description: string; price: number },
    /* The unit, when one has just been picked. Passed in rather than read from
       state because the picker closes as it confirms, and a line built from
       state a render later would be built from a cleared one. */
    unit?: { id: number; serial: string } | null,
  ) {
    /* Minted here rather than inside the updater, so the caller can learn which
       line it just added — `addProduct` focuses its quantity under
       `invoicing_scan_focus: 'qty'`. An updater runs later and may run twice
       under StrictMode, which would leave the ref naming a key that never
       reached the grid. */
    const key = nextKey()
    lastKeyRef.current = key

    setLines((current) => [
      ...current,
      {
        key,
        productId: found.id,
        productCode: found.code,
        description: answers?.description ?? found.description,
        productType: found.productType,
        departmentId: found.departmentId,
        // Inherits the line above, which is nearly always right when one
        // assistant is capturing a whole order; otherwise whoever is signed in.
        // Inheritance wins so that deliberately re-attributing one line carries
        // down the rest of the order rather than snapping back.
        salesRepUserId: current[current.length - 1]?.salesRepUserId ?? defaultRepUserId,
        serialId: unit?.id ?? null,
        serialLabel: unit?.serial ?? null,
        qty: 1,
        /* A percentage charge opens at nothing: its stored figure is the RATE,
           and the reprice effect turns that into money against the rest of the
           document. Otherwise a typed price wins over the shelf one. */
        unitPriceIncl: found.chargePctSubtotal ? 0 : (answers?.price ?? found.priceIncl),
        chargePctSubtotal: found.chargePctSubtotal,
        /* WHAT A TYPED FIGURE MEANS ON A PERCENTAGE CHARGE.
           "Ask for the price" and "charge % of subtotal" are contradictory
           settings — one says the money is typed, the other says the money is
           derived — and a product can carry both. The typed figure is taken as
           the RATE, because that is the only reading under which it changes
           anything: treating it as money would be overwritten by the very next
           reprice. Typing 12 on a charge product therefore means 12%. */
        chargePct: found.chargePctSubtotal ? (answers?.price ?? found.priceIncl) : 0,
        /*
         * The account's standing discount is the DEFAULT, capped at the
         * product's own ceiling: checkPricing refuses a line above
         * max_discount_pct for anyone without the override right, and a
         * back-office setting must never brick the capture. Still editable —
         * a default, not a mandate.
         *
         * ── AND A CEILING OF ZERO IS A CEILING ───────────────────────────
         *
         * This read `found.maxDiscountPct > 0 ? found.maxDiscountPct : 100`,
         * i.e. zero means "no ceiling set". `checkPricing` reads the same zero
         * as "no discount allowed on this product", and since the column
         * DEFAULTS to zero that covers most of the catalogue. So attaching an
         * account with a standing 5% and adding an ordinary product handed a
         * cashier a 5% line they never typed and could not clear — the cell was
         * disabled — and then refused the save with "this product cannot be
         * discounted". The two readings of the same column have to agree, and
         * the guard that actually refuses the save is the one that decides.
         *
         * Only for somebody who cannot override: a supervisor is allowed past
         * the ceiling, so holding their default under it would be the app
         * withholding a discount the account is entitled to.
         */
        discountPct: customer
          ? canOverrideDiscount
            ? customer.discountPct
            : Math.min(customer.discountPct, found.maxDiscountPct)
          : 0,
        vatRatePct: found.vatRatePct,
        unitCostExcl: found.costExcl,
        /* Straight off the product, as the till's `lineFromProduct` does. Zero
           is a real ceiling meaning "not discountable" — see
           `discountCeilingOf` — so it is carried as it stands. */
        maxDiscountPct: found.maxDiscountPct,
        /* From the product, like the till's `lineFromProduct` does. The search
           and scan actions have always returned these — the editor simply threw
           them away here, which is why an invoice would take 0.5 of a product
           the till refuses to sell in halves. */
        allowFractions: found.allowFractions,
        qtyDecimals: found.qtyDecimals ?? DEFAULT_QTY_DECIMALS,
      },
    ])
  }

  /**
   * A product chosen in the search dialog, added to the invoice.
   *
   * ── WHY THE PICK IS RE-RESOLVED ──────────────────────────────────────────
   *
   * The dialog hands back a plain product — id, code, description, shelf price
   * — because it is the shared picker and knows nothing about invoicing. This
   * screen needs a TillProduct: the price for THIS customer's structure, the
   * "ask for a description" and "ask for a price" flags, the fraction rules,
   * the stock note. So the code goes through `scanAction`, which is the same
   * path the entry box below the grid already uses.
   *
   * The alternative — teaching the picker about price structures — would make
   * every screen that opens it pass one, including the several that have no
   * customer at all. The round trip is one query against a product the user
   * has already waited for the list of.
   */
  function pickFromSearch(product: ProductSearchPick) {
    startTransition(async () => {
      const found = await scanAction(product.code, priceStructureId)
      if (!found) {
        /* Name the product, not the code. It was just clicked in a list, so
           "Nothing found for ABC123" reads as though the click missed. */
        toast.error(`Could not add ${product.description}.`)
        return
      }
      addWithPrompts(found)
      toast.success(`Added ${found.description}.`)
    })
  }

  /**
   * Several products, ticked in the dialog and added together.
   *
   * Resolved in ORDER and one at a time rather than in parallel: `appendLine`
   * inherits the sales rep from the line above it, so the lines have to land in
   * the order they were picked or the inheritance chains off whichever query
   * happened to answer first.
   *
   * A product that asks for a description or a price still stops and asks. That
   * makes a bulk add of ten interruptible, which is right — the alternative is
   * ten lines silently carrying a price of zero.
   */
  function pickManyFromSearch(products: ProductSearchPick[]) {
    startTransition(async () => {
      let added = 0
      const missing: string[] = []

      for (const product of products) {
        const found = await scanAction(product.code, priceStructureId)
        if (!found) {
          missing.push(product.code)
          continue
        }
        addWithPrompts(found)
        added += 1
      }

      /* Name the refusals. "8 added" with nothing about the other two leaves
         the user unable to tell which of the ten they still have to find. */
      if (missing.length > 0) {
        toast.info(
          `${added} added, ${missing.length} could not be — ${missing.slice(0, 3).join(', ')}`,
        )
      } else if (added > 0) {
        toast.success(`Added ${added} product${added === 1 ? '' : 's'}.`)
      }
    })
  }


  function addProduct(code: string) {
    const term = code.trim()
    if (!term) return

    startTransition(async () => {
      const scanned = await scanAction(term, priceStructureId)
      const found = scanned ?? (await searchProductsAction(term, priceStructureId))[0] ?? null

      if (!found) {
        toast.error(`Nothing found for "${term}".`)
        return
      }

      addWithPrompts(found)
      setEntry('')
      /*
       * Where the cursor goes next is the shop's choice — `invoicing_scan_focus`.
       *
       * Under 'qty' the entry box is deliberately NOT refocused first: two focus
       * calls in one tick race, and the loser is whichever the browser applies
       * second. The effect that consumes `focusQtyKey` is the only mover in that
       * mode.
       *
       * The key is read off the lines AFTER the append rather than captured
       * before it, because `appendLine` mints it — see `nextKey`.
       */
      if (scanFocus === 'qty') setFocusQtyKey(lastKeyRef.current)
      else entryRef.current?.focus()
    })
  }

  function patch(key: string, changes: Partial<EditorLine>) {
    setLines((current) => current.map((l) => (l.key === key ? { ...l, ...changes } : l)))
  }

  function removeLine(key: string) {
    setLines((current) => current.filter((l) => l.key !== key))
  }

  /* ── Saving ──────────────────────────────────────────────────────────── */

  /**
   * The document as the screen currently has it.
   *
   * `requireName` is passed only by the draft save. Print, Finalise and Issue
   * quote all save through here too, and each of them either allocates a
   * document number or is about to — so none of them may be blocked on a blank
   * name. See the flag's own note in the action.
   */
  function payload(requireName = false): InvoicePayload {
    return {
      documentId: document.id,
      requireName,
      deviceId: device,
      customerId,
      customerName: customerName.trim() || null,
      priceStructureId,
      documentDate,
      reference: reference.trim() || null,
      notes: notes.trim() || null,
      lines: lines.map((l, i) => ({
        productId: l.productId,
        productCode: l.productCode,
        description: l.description,
        productType: l.productType,
        departmentId: l.departmentId,
        salesRepUserId: l.salesRepUserId,
        qty: l.qty,
        unitPriceIncl: l.unitPriceIncl,
        // What the screen showed, so the saved invoice matches it.
        discountPct: effectiveDiscountPct(l.discountPct, lineSpecials[i]),
        /* A granted line records the special that PUT it here. It carries no
           discount of its own — it is free rather than reduced — so without
           this the one line the promotion actually gave away would be the one
           line with no trace of which promotion gave it. */
        specialId: l.rewardSpecialId ?? lineSpecials[i]?.specialId ?? null,
        vatRatePct: l.vatRatePct,
        unitCostExcl: l.unitCostExcl,
        /* The unit this line promises. Whitelisted like everything else here,
           and the cost of forgetting it is the same one the till's
           `salePayloadLines` warns about: not a lost note, but a sale refused
           at the tender pad with the customer already waiting. */
        serialId: l.serialId,
      })),
    }
  }

  /**
   * Stops a save the discount ceiling would refuse, and says why.
   *
   * In front of every path that writes rather than inside `payload`, which is
   * also called by reads. `checkPricing` refuses the same document with the
   * same sentence — this only saves the round trip and, on the paths that save
   * BEFORE doing something else (print, take payment), stops the something
   * else being set up for a document that was never going to be written.
   *
   * Returns true when it refused, so each caller reads as one line.
   */
  function refuseOverCeiling(): boolean {
    if (!discountRefusal) return false
    toast.error(discountRefusal)
    return true
  }

  /**
   * Stops a FINALISE whose serial lines have not said which unit (235).
   *
   * `finaliseDocument` refuses the same document with almost the same sentence.
   * This is in front of it for the reason `refuseOverCeiling` is: the refusal
   * arrives at the TENDER PAD otherwise — money already being counted out — and
   * the customer is standing there while somebody works out which laptop the
   * invoice meant. Caught here it is a toast on the grid, next to the line that
   * needs answering, with the picker one click away.
   *
   * Only on the paths that POST. A draft is allowed to be half-captured — that
   * is what a draft is for, and an order taken over the phone is often written
   * up before anybody walks to the shelf. The unit is required at the moment
   * stock actually moves, which is finalise.
   *
   * Returns true when it refused, matching its neighbour.
   */
  function refuseMissingSerial(): boolean {
    const missing = lines.filter((l) => l.productType === 'serial' && !l.serialId)
    if (missing.length === 0) return false

    /* Name the first one rather than counting them. "2 lines need a serial
       number" makes somebody hunt; the description is what they scan the grid
       for, and the rest are found the same way once this one is answered. */
    toast.error(
      missing.length === 1
        ? `${missing[0].description}: choose which unit is going out.`
        : `${missing[0].description} and ${missing.length - 1} other line${
            missing.length === 2 ? '' : 's'
          } need a serial number.`,
    )
    return true
  }

  /**
   * Save (draft).
   *
   * ── WHY THIS ASKS ─────────────────────────────────────────────────────
   *
   * A draft has no document number — the number is allocated at issue — so the
   * only handle anyone has on it is what it is CALLED. Saved with nothing, it
   * lands in the register as a row with a dash where its identity should be,
   * and finding it again means opening documents until you recognise the lines.
   *
   * An ATTACHED CUSTOMER already answers the question, so this does not ask:
   * their name is the sale's name, and making somebody retype it would be a
   * dialog whose only correct answer is the one already on screen. The prompt
   * is for the walk-in case, where nothing else has named the sale.
   *
   * The name is stored as `customer_name`, NOT as the reference. The reference
   * is the customer's own number for the job — their PO, their job card — and
   * it is theirs to use for whatever they use it for. Spending it on a name the
   * shop invented would take the field away from what it is for.
   */
  function save() {
    if (refuseOverCeiling()) return
    if (!customerName.trim()) {
      setNamingSale(true)
      return
    }
    saveNamed(customerName)
  }

  /**
   * The save itself, once there IS a name.
   *
   * Takes the name rather than reading it off state: the dialog calls this in
   * the same tick as its own `setCustomerName`, so state still holds the old
   * value — the same reason the till's `nameTab` passes its label through to
   * `park()` instead of letting it re-read.
   */
  function saveNamed(name: string) {
    const named = name.trim()
    if (!named) return
    if (refuseOverCeiling()) return
    setCustomerName(named)
    setNamingSale(false)
    startTransition(async () => {
      const result = await saveInvoiceAction({ ...payload(true), customerName: named })
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(`${named} saved.`)
      router.refresh()
    })
  }

  /**
   * Saves the document, then opens its printable copy in a new tab.
   *
   * ── SAVING FIRST IS THE WHOLE POINT ───────────────────────────────────
   *
   * The print route renders from the STORED document, because paper that
   * disagrees with the database is worse than no paper. Every figure in this
   * editor lives in component state until a save, so printing a pro forma with
   * an unsaved line on screen would hand a customer a document missing the
   * item they just asked for. Same reasoning as takePayment below.
   *
   * A FINALISED document has nothing to save — it is immutable, and
   * saveInvoiceAction would refuse — so that case prints straight away.
   *
   * ── NO TAB, AND THEREFORE NO POPUP DANCE ──────────────────────────────
   *
   * This used to open a tab up front and point it at the route after the save,
   * because a popup blocker only allows `window.open` inside the gesture that
   * asked for it. Printing through a hidden frame removes the popup entirely,
   * so the frame can simply be pointed at the route once the save lands — and
   * a failed save now leaves nothing behind to close.
   *
   * The button says "Print", so it prints: the reader has already decided.
   */
  function printDocument() {
    const href = `/sales/${document.id}/document`

    if (!editable) {
      printDoc(href)
      return
    }
    if (refuseOverCeiling()) return

    startTransition(async () => {
      const saved = await saveInvoiceAction(payload())
      if (!saved.ok) {
        toast.error(saved.error)
        return
      }
      printDoc(href)
      router.refresh()
    })
  }

  /**
   * Saves the draft, then asks for payment.
   *
   * Saving first is not a nicety: the tender pad settles against a total, and
   * the total that matters is the one the server will recompute from the stored
   * lines. Opening the pad on an unsaved edit would take payment against a
   * figure the posting engine is about to disagree with.
   */
  function takePayment() {
    if (refuseOverCeiling()) return
    /* Before the pad OPENS, which is the whole point: this is the moment the
       old refusal arrived, with the customer's card already out. */
    if (refuseMissingSerial()) return
    startTransition(async () => {
      const saved = await saveInvoiceAction(payload())
      if (!saved.ok) {
        toast.error(saved.error)
        return
      }
      setTendering(true)
    })
  }

  function finalise(taken: { tenderTypeId: number; amount: number; reference?: string | null }[]) {
    if (refuseOverCeiling()) return
    /* Again here, not only in takePayment: finalise is reachable without the
       pad (a zero-total invoice, an account sale), and this is the last gate
       before stock moves. */
    if (refuseMissingSerial()) return
    startTransition(async () => {
      const result = await finaliseInvoiceAction(payload(), taken)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      setTendering(false)
      setReceipt({
        documentId: result.documentId,
        number: result.documentNumber,
        change: result.change,
      })
      /* Opened first, filled a moment later: the dialog must appear the instant
         the sale posts — the counter is waiting on it — so the record is read
         behind it rather than held up in front of it. */
      setRecord(null)
      void saleRecordAction(result.documentId).then(setRecord)
    })
  }

  /**
   * Issues a quote to the customer.
   *
   * Saves and stamps it issued — no tender pad, no stock, no ledger, because a
   * quote is an offer rather than a sale. It becomes a real document only when
   * the customer accepts it and it converts to an invoice.
   */
  function issueQuote() {
    if (refuseOverCeiling()) return
    startTransition(async () => {
      const saved = await saveInvoiceAction(payload())
      if (!saved.ok) {
        toast.error(saved.error)
        return
      }
      const issued = await issueQuoteAction(document.id)
      if (!issued.ok) {
        toast.error(issued.error)
        return
      }
      toast.success(issued.message)
      router.refresh()
    })
  }

  /* ── Render ──────────────────────────────────────────────────────────── */

  /*
   * ── WHAT THIS DOCUMENT IS CALLED, AND HOW IT ENDS ─────────────────────
   *
   * Three kinds now share this editor, and only one of them takes money. A
   * quote is an offer, an order is a promise, an invoice is the sale — same
   * lines, same prices, same grid, three different last steps:
   *
   *   quote    → Issue quote      (sent to the customer)
   *   order    → Save order       (delivered later, from its own screen)
   *   invoice  → Finalise         (opens the tender pad)
   *
   * Written as a lookup rather than a chain of ternaries because there is now
   * a third, and a fourth would go the same way — DOC_TYPES already has
   * credit_sale in it.
   */
  const isQuote = document.docType === 'quote'
  const isOrder = document.docType === 'sales_order'
  const noun = isQuote ? 'Quote' : isOrder ? 'Order' : 'Invoice'
  const title = document.documentNumber ?? `${noun} #${document.id}`

  /*
   * ── STATE ON THE LEFT, ACTIONS ON THE RIGHT ───────────────────────────
   *
   * The two status badges used to sit in the same row as Save and Finalise,
   * which put what this document IS inside the group of things you can DO to
   * it — and left the buttons reading as a four-item row where only two were
   * pressable. PageHeader has a `status` slot between the title and subtitle
   * built for precisely this, so the state now sits against the name it
   * describes and the right-hand side is buttons only.
   *
   * The owning screen's own state first — see `extraStatus`. On an order that
   * is "Open" or "Part delivered", which is a different question from the
   * "Draft" beside it.
   */
  const status = (
    <>
      {extraStatus}
      <Badge tone={STATUS_TONE[document.status]}>{STATUS_LABELS[document.status]}</Badge>
    </>
  )

  /*
   * What the Print button will actually put on paper.
   *
   * Named rather than left as a bare "Print" because the four documents this
   * editor produces are not interchangeable: somebody handing a customer a
   * PRO FORMA needs to know that is what came out, and the difference between
   * that and a tax invoice is the whole reason the route decides the heading
   * from status. The button says the same word the paper does.
   *
   * Kept in step with printKindFor in lib/site/salesDocumentKind — that function is
   * the authority, this only labels the button that opens it.
   */
  const printLabel = isQuote
    ? 'Print quote'
    : isOrder
      ? 'Print order'
      : document.status === 'finalised'
        ? 'Print invoice'
        : 'Print pro forma'

  const actions = (
    <>
      {/* Outside the `editable` gate: a finalised invoice is exactly the one
          you most often need on paper, and it was the only state with no way
          to print an A4 copy at all. Nothing to print on an empty document,
          which is why the line count still gates it. */}
      <Button
        variant="ghost"
        onClick={printDocument}
        disabled={pending || lines.length === 0}
      >
        <Icons.Printer size={16} />
        {printLabel}
      </Button>

      {editable && (
        <>
          <Button variant="secondary" onClick={save} disabled={pending || lines.length === 0}>
            <Icons.Save size={16} />
            Save (draft)
          </Button>
          {/* A quote takes no payment — it is an offer, not a sale — and an
              order takes none either, because the goods have not gone anywhere
              yet. Only an invoice opens the tender pad. Everything above this
              point is identical for all three, which is the whole reason one
              editor serves them. */}
          {isQuote ? (
            <Button onClick={issueQuote} disabled={pending || lines.length === 0}>
              <Icons.Check size={16} />
              Issue quote
            </Button>
          ) : isOrder ? (
            <Button onClick={save} disabled={pending || lines.length === 0}>
              <Icons.Check size={16} />
              Save order
            </Button>
          ) : (
            <Button onClick={takePayment} disabled={pending || lines.length === 0}>
              <Icons.Check size={16} />
              Finalise
            </Button>
          )}
        </>
      )}
    </>
  )

  return (
    <>
      <PageHeader
        title={title}
        status={status}
        subtitle={`${customerName || 'No customer'} · ${documentDate}`}
        /* Back to the register this document belongs to. It always said
           "invoicing", which sent somebody editing a quote to the wrong list. */
        backHref={isQuote ? '/invoicing/quotes' : isOrder ? '/invoicing/orders' : '/invoicing'}
        backLabel={isQuote ? 'Back to quotes' : isOrder ? 'Back to orders' : 'Back to invoicing'}
        action={actions}
      />

      {/*
        `flush` when the owning screen has more to put below the editor.

        PageBody ends in `pb-10` because it is normally the last thing on a
        page — but on the invoice, quote and order screens it is not: a deposit
        panel, an outcome panel and proof of delivery all follow. That trailing
        40px then landed on top of the next section's own spacing, making the
        seam under the grid three times the `gap-5` between every other card,
        which is what made the screen look like it came apart there.

        The screens that follow the editor supply their own `pb-10` at the true
        bottom of the page, so nothing ends flush against the window.
      */}
      <PageBody flush={hasSectionsBelow}>
        {/*
          ── WHO, AND ON WHAT TERMS — ONE BAND ────────────────────────────

          The customer and the document's terms (price type, their reference,
          the date, a quote's validity) answer one question between them, and
          they were being read as two: a customer card, then a details card,
          then the grid. Three separate boxes for what is really one header.

          So they share a strip, divided rather than boxed. Each terms cell
          draws its OWN left hairline (see CELL below) rather than the strip
          using `divide-x`: Tailwind's divide utility puts the border on every
          child but the first, which a `gap` then holds away from anything —
          the rules were there and invisible, floating in the gutter. A border
          that belongs to the cell sits against the cell.

          Chrome, so it is roomy: this is touched once per document, unlike
          the grid below it which is scanned line by line.
        */}
        <Card>
          {/* items-START. One cell can carry a hint under its field ("Blank
              means it does not expire") and the others cannot, so centring
              floated the taller cell's glyph and label above its neighbours'.
              Aligned at the top, every glyph and every label sits on one line
              and the hint hangs below where it belongs.

              data-accent-rule marks the card's left edge the way CardHeader
              does — see globals.css. This strip IS the card's header, it just
              has no heading text, so it was the one card on the screen without
              the rule down its edge while Products, Comment and Summary all
              had one. The attribute is what the CSS looks for, not the
              component, so saying it directly is the whole fix. */}
          <div data-accent-rule className="flex flex-wrap items-start gap-y-4 px-5 py-4">
            <CustomerBar
              customerId={customerId}
              customerName={customerName}
              editable={editable}
              operatorName={operatorName ?? ''}
              onPick={(picked) => {
                setCustomerId(picked?.id ?? null)
                setCustomerName(picked?.name ?? '')
              }}
            />

            {/* Each term is its own cell and owns the hairline on its left, so
                the rule sits against the content rather than floating in a
                gap. Dropped below `lg`, where the cells stack and a left-hand
                border would be drawing a column that is no longer there. */}
            <div className={HEADER_CELL}>
              <span className="flex size-9 shrink-0 items-center justify-center rounded-control bg-brand-soft text-brand">
                <Icons.Tag size={18} />
              </span>
              <Field label="Price type" className="min-w-0 flex-1">
                <Select
                  value={priceStructureId ?? ''}
                  disabled={!editable}
                  onChange={(e) =>
                    setPriceStructureId(e.target.value ? Number(e.target.value) : null)
                  }
                >
                  {/* Only when there is genuinely no structure — a finalised
                      document that was captured without one. Without it the
                      box would point at the first structure and claim a price
                      type the document never had. */}
                  {priceStructureId === null && <option value="">—</option>}
                  {structures.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>

            {/* The CUSTOMER's own reference — their purchase-order number, their job
                number, whatever they quote back at you. "Invoice order number"
                read oddly on a quote, and templating the noun in produced
                "Order order number" on an order. It is one thing whatever the
                document is, so it is named for what it IS. */}
            <div className={HEADER_CELL}>
              <span className="flex size-9 shrink-0 items-center justify-center rounded-control bg-brand-soft text-brand">
                <Icons.Contact size={18} />
              </span>
              <Field label="Customer reference" className="min-w-0 flex-1">
                <Input
                  value={reference}
                  disabled={!editable}
                  maxLength={64}
                  onChange={(e) => setReference(e.target.value)}
                />
              </Field>
            </div>

            <div className={HEADER_CELL}>
              <span className="flex size-9 shrink-0 items-center justify-center rounded-control bg-brand-soft text-brand">
                <Icons.Calendar size={18} />
              </span>
              <Field label={`${noun} date`} className="min-w-0 flex-1">
                <Input
                  type="date"
                  value={documentDate}
                  disabled={!editable}
                  onChange={(e) => setDocumentDate(e.target.value)}
                />
              </Field>
            </div>

            {/* A quote's "Valid until", passed down by the quote screen. It
                brings its own glyph so the cell matches its neighbours. */}
            {detailsSlot}
          </div>
        </Card>

        <Card>
          {/* The grid says what it is. It was the one unlabelled card on the
              screen — a bare "Add product" button floating above a table —
              while every other section carried a heading. */}
          <CardHeader
            icon={<Icons.ShoppingCart size={18} />}
            title="Products & line items"
            action={
              /* Not the primary — Finalise is. Opens the search dialog, because
                 the dashed entry box below already covers the case where the
                 code is known; this is for when it is not.

                 Just the flag: the dialog clears its own search, filters and
                 selection every time it opens, so there is nothing to reset
                 from out here. */
              <Button
                variant="secondary"
                onClick={() => setSearchOpen(true)}
                disabled={!editable || pending}
              >
                <Icons.Plus size={16} />
                Add product
              </Button>
            }
          />

          <div className="overflow-x-auto">
            <table className={TABLE}>
              {/* Fixed widths so every box in a column is the same size and the
                  numbers line up down the grid. Product takes what is left. */}
              <colgroup>
                <col />
                <col className="w-40" />
                <col className="w-24" />
                <col className="w-28" />
                <col className="w-28" />
                <col className="w-28" />
                <col className="w-28" />
                <col className="w-12" />
              </colgroup>
              {/* No column headings over an empty grid. Seven labels above
                  nothing describe a table that is not there, and they sat
                  between the code box and the "No lines yet" state that is
                  supposed to be the thing you read. */}
              <thead hidden={lines.length === 0}>
                <tr className={TABLE_HEAD_ROW}>
                  <th className={TABLE_TH}>Product</th>
                  {/* "Salesperson", not "Clerk": this decides who earns
                      commission on the line, which is a different question from
                      who captured the document. */}
                  <th className={TABLE_TH}>Salesperson</th>
                  <th className={`${TABLE_TH} text-right`}>Qty</th>
                  <th className={`${TABLE_TH} text-right`}>Selling excl</th>
                  <th className={`${TABLE_TH} text-right`}>Selling incl</th>
                  <th className={`${TABLE_TH} text-right`}>Disc %</th>
                  <th className={`${TABLE_TH} text-right`}>Line total</th>
                  <th className={TABLE_TH} aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {lines.map((line, index) => {
                  const totals = computed.per[index]
                  const excl =
                    line.vatRatePct > 0
                      ? round(line.unitPriceIncl / (1 + line.vatRatePct / 100), 2)
                      : line.unitPriceIncl
                  /* Per row, so the offending cell is the one that goes red
                     rather than the whole grid. The same test `discountRefusal`
                     makes above — and, like it, silent for a supervisor. */
                  const ceiling = canOverrideDiscount ? null : discountCeilingOf(line)
                  const overCeiling = ceiling !== null && line.discountPct > ceiling + 0.01

                  return (
                    <tr key={line.key} className={TABLE_ROW}>
                      <td className={TABLE_TD}>
                        <div className="font-medium text-ink">{line.description}</div>
                        {line.productCode && (
                          <div className="text-xs text-muted">{line.productCode}</div>
                        )}
                        {/*
                          WHICH unit this line promises (235).

                          Under the description rather than in a column of its
                          own: only serial lines have one, and a column would be
                          empty on every row of an ordinary invoice while taking
                          width from the descriptions that are the point of the
                          grid. It sits with the product code because it is the
                          same kind of fact — what this line IS, rather than a
                          figure about it.

                          Always shown on a serial line, including when nothing
                          has been chosen. A line quietly missing its unit until
                          the tender pad refuses it is the bug being fixed; a
                          line that says "Choose a unit" in warning colours is
                          the fix.
                        */}
                        {line.productType === 'serial' && (
                          <div className="mt-1">
                            {line.serialLabel ? (
                              <button
                                type="button"
                                disabled={!editable}
                                onClick={() =>
                                  askForSerial(null, {
                                    key: line.key,
                                    productId: line.productId ?? 0,
                                    description: line.description,
                                  })
                                }
                                className="numeric text-xs text-brand underline-offset-2 hover:underline disabled:no-underline disabled:text-muted"
                              >
                                {line.serialLabel}
                              </button>
                            ) : (
                              <button
                                type="button"
                                disabled={!editable}
                                onClick={() =>
                                  askForSerial(null, {
                                    key: line.key,
                                    productId: line.productId ?? 0,
                                    description: line.description,
                                  })
                                }
                                className="text-xs font-medium text-warning-ink underline-offset-2 hover:underline disabled:no-underline disabled:text-muted"
                              >
                                Choose a unit
                              </button>
                            )}
                          </div>
                        )}
                      </td>

                      <td className={TABLE_TD_INPUT}>
                        {/* Writes salesRepUserId, not salesRepId: commission is
                            paid to a user (047), and this picker deciding who
                            gets paid is the whole point of it being per line. */}
                        <Select
                          aria-label={`Salesperson for ${line.description}`}
                          value={line.salesRepUserId ?? ''}
                          disabled={!editable}
                          onChange={(e) =>
                            patch(line.key, {
                              salesRepUserId: e.target.value ? Number(e.target.value) : null,
                            })
                          }
                        >
                          <option value="">—</option>
                          {reps.map((r) => (
                            <option key={r.id} value={r.id}>
                              {r.name}
                            </option>
                          ))}
                        </Select>
                      </td>

                      <td className={TABLE_TD_INPUT}>
                        <NumberInput
                          /* Registered so a freshly scanned line can be focused
                             here under `invoicing_scan_focus: 'qty'`. Cleared on
                             unmount so a removed line does not hold its node. */
                          ref={(node) => {
                            if (node) qtyRefs.current.set(line.key, node)
                            else qtyRefs.current.delete(line.key)
                          }}
                          /* Names the rule, so a typist who watches 1.5 become 2
                             knows why. The till's line editor labels it the same
                             way. The quantity right is named too when it is
                             missing — somebody about to be asked for a PIN should
                             know that before they type, not after. */
                          aria-label={`Quantity for ${line.description}${
                            qtyDecimalsOf(line) === 0
                              ? ' — whole units only'
                              : ` — up to ${qtyDecimalsOf(line)} decimals`
                          }${canOverrideQty ? '' : ' — a supervisor approves anything but 1'}`}
                          value={line.qty}
                          /* The product's own places, not a hardcoded 2. At 2 a
                             legitimate 1.125kg line displayed as 1.13 while
                             state still held 1.125 — the box lied about the
                             number it was holding. */
                          precision={qtyDecimalsOf(line)}
                          /*
                           * ── NOT DISABLED WITHOUT THE RIGHT ──────────────
                           *
                           * Deliberately, and it is the whole shape of this
                           * permission. A greyed box tells a clerk "no" and
                           * stops there; the shop's actual rule is "not on your
                           * own", and a supervisor standing right there must be
                           * able to make it happen without the clerk first
                           * having to guess that the cell would be typeable for
                           * somebody else.
                           *
                           * So the number goes in as it always did, and the
                           * PIN pad is what decides whether it stays. Same
                           * reasoning as the discount cell above, which was
                           * once disabled for exactly the people the ceiling
                           * was written for.
                           */
                          disabled={!editable}
                          onChange={(e) =>
                            patch(line.key, { qty: Number(String(e.target.value).replace(',', '.')) || 0 })
                          }
                          /*
                           * Rounded when the cell is LEFT, not per keystroke.
                           *
                           * `precision` only formats what is shown — it never
                           * writes back — so without this the grid displayed a
                           * rounded figure over unrounded state and SAVED the
                           * unrounded one. Rounding on blur makes the two agree.
                           *
                           * Not per keystroke because that would fight the
                           * caret: "1.2" on a two-decimal product would settle
                           * to 1.2 and the next digit could never reach 1.25.
                           *
                           * The approval is asked for HERE, on the way out, for
                           * the same reason: a pad thrown up per keystroke would
                           * fire on the 1 of 12 and be unusable.
                           */
                          onBlur={() => commitQty(line)}
                        />
                      </td>

                      {/* Editable, and it writes back through the VAT rate to the
                          inclusive price — which stays the stored figure. Someone
                          quoting a trade price ex-VAT types here; the shelf price
                          follows. */}
                      <td className={TABLE_TD_INPUT}>
                        <CurrencyInput
                          aria-label={`Selling price excluding VAT for ${line.description}`}
                          value={excl}
                          disabled={!editable || !canOverridePrice}
                          onChange={(e) => {
                            const typed = Number(String(e.target.value).replace(',', '.')) || 0
                            patch(line.key, {
                              unitPriceIncl: round(typed * (1 + line.vatRatePct / 100), 4),
                            })
                          }}
                        />
                      </td>

                      <td className={TABLE_TD_INPUT}>
                        <CurrencyInput
                          aria-label={`Selling price including VAT for ${line.description}`}
                          value={line.unitPriceIncl}
                          disabled={!editable || !canOverridePrice}
                          onChange={(e) =>
                            patch(line.key, {
                              unitPriceIncl: Number(String(e.target.value).replace(',', '.')) || 0,
                            })
                          }
                        />
                      </td>

                      <td className={TABLE_TD_INPUT}>
                        {/*
                          ── ENABLED FOR EVERYONE THE DOCUMENT IS EDITABLE BY ──

                          This cell was `disabled={!editable || !canOverrideDiscount}`,
                          which inverted the rule it was meant to carry. The
                          product's ceiling is described to the shopkeeper as
                          "the highest discount a cashier may apply", and the
                          capability beside it as "Discount BEYOND the product
                          limit" — so an ordinary assistant may discount up to
                          the ceiling, and only past it needs a supervisor.

                          Disabling the cell for anyone without the override
                          right gave the opposite of both halves: a cashier
                          could not discount at all, while the only people who
                          could were the ones the ceiling never applied to. The
                          setting could therefore not bite on this screen no
                          matter what a shop typed into it — the till has
                          always worked the other way (see LineEditModal).
                        */}
                        <NumberInput
                          /* Names the ceiling, like the till's numpad label, so
                             somebody watching the cell go red knows what the
                             limit is rather than guessing at it. */
                          aria-label={
                            canOverrideDiscount || discountCeilingOf(line) === null
                              ? `Discount for ${line.description}`
                              : `Discount for ${line.description} — up to ${discountCeilingOf(line)}% without a supervisor`
                          }
                          value={line.discountPct}
                          precision={2}
                          disabled={!editable}
                          /* The kit's own way of marking a refused field; it
                             also sets aria-invalid, so the breach is announced
                             rather than only coloured. */
                          invalid={overCeiling}
                          icon={<span className="text-xs text-faint">%</span>}
                          onChange={(e) =>
                            patch(line.key, {
                              discountPct: Number(String(e.target.value).replace(',', '.')) || 0,
                            })
                          }
                        />
                      </td>

                      <td className={`${TABLE_TD} ${TABLE_NUMERIC} font-medium text-ink`}>
                        {formatMoney(totals.lineTotalIncl)}
                      </td>

                      <td className={`${TABLE_TD} text-right`}>
                        <Button
                          variant="danger-ghost"
                          size="sm"
                          iconOnly
                          aria-label={`Remove ${line.description}`}
                          disabled={!editable}
                          onClick={() => removeLine(line.key)}
                        >
                          <Icons.Trash size={15} />
                        </Button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {/* Says WHICH line and WHY, under the grid where the eye already is
              after typing. The red cell above says where; this says what to do
              about it. One at a time — the first breach, like the server's
              refusal — because a list of six repeats one sentence six times. */}
          {discountRefusal && (
            <div className="flex items-start gap-2 border-t border-border bg-danger-soft px-4 py-3 text-sm text-danger">
              <Icons.StatusWarning size={16} className="mt-px shrink-0" />
              <span>{discountRefusal}</span>
            </div>
          )}

          {editable && (
            <div className="px-4 py-3">
              <Input
                ref={entryRef}
                value={entry}
                placeholder="Type a product code or barcode, then Tab or Enter to add…"
                aria-label="Add a product by code or barcode"
                disabled={pending}
                className="border-dashed"
                onChange={(e) => setEntry(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === 'Tab') {
                    if (!entry.trim()) return
                    e.preventDefault()
                    addProduct(entry)
                  }
                }}
              />
            </div>
          )}

          {lines.length === 0 && (
            <EmptyState
              icon={<Icons.Barcode size={22} />}
              title="No lines yet"
              hint="Scan or search to add the first line."
            />
          )}
        </Card>

        <div className="grid gap-5 lg:grid-cols-2">
          <Card>
            <CardHeader
              icon={<Icons.MessageSquare size={18} />}
              title="Comment"
              description="Printed on the invoice."
            />
            <CardBody>
              <Textarea
                rows={5}
                value={notes}
                disabled={!editable}
                maxLength={2000}
                aria-label="Comment printed on the invoice"
                onChange={(e) => setNotes(e.target.value)}
              />
            </CardBody>
          </Card>

          {/* The working figures stay quiet; the one number the panel exists to
              state is the inclusive total. GP goes danger when the sale would
              lose money. */}
          <Card>
            <CardHeader icon={<Icons.Calculator size={18} />} title="Summary" />
            <CardBody>
              <SummaryList>
                {/* What the shop paid and what it makes are a different
                    question from what the customer owes — a counter assistant
                    capturing an order has no business seeing either. */}
                {showCost && (
                  <>
                    <SummaryRow
                      label="Cost"
                      value={formatMoney(computed.costTotal)}
                      tone="muted"
                    />
                    <SummaryRow
                      label={`GP ${computed.gpPct.toFixed(2)}%`}
                      value={formatMoney(computed.gpValue)}
                      tone={computed.gpValue < 0 ? 'danger' : 'muted'}
                    />
                  </>
                )}
                <SummaryRow
                  label="Discount"
                  value={formatMoney(computed.totals.discountTotal)}
                  tone="muted"
                />
                <SummaryRow
                  label="Total exclusive"
                  value={formatMoney(computed.totals.subtotalExcl)}
                  tone="muted"
                />
                <SummaryRow
                  label="VAT"
                  value={formatMoney(computed.totals.vatTotal)}
                  tone="muted"
                />
                <SummaryTotal label="Total inclusive" value={formatMoney(computed.totals.totalIncl)} />
              </SummaryList>
            </CardBody>
          </Card>
        </div>

        {/* The till's own tender pad, not a copy of it. Same buttons, same
            split-payment rules, same credit refusals — an invoice paid by card
            must behave exactly as it would at the counter. */}
        <TenderPad
          open={tendering}
          onClose={() => setTendering(false)}
          tenders={tenders}
          totalIncl={computed.totals.totalIncl}
          cashRounding={cashRounding}
          customer={customer}
          /* What is already paid comes off what the pad asks for — the posting
             engine adds it back as a DEPOSIT tender of its own. See the prop's
             docblock in TenderPad. */
          depositHeld={depositHeld}
          pending={pending}
          onFinalise={finalise}
        />

        {/* Only mounted while a product is being asked about, so its state
            starts fresh each time — see the same note on the till's copy. */}
        {askingDetails && (
          <AskDetailsModal
            product={askingDetails.product}
            askDescription={askingDetails.description}
            askPrice={askingDetails.price}
            onCancel={() => setAskingDetails(null)}
            onConfirm={(answers) => {
              const { product } = askingDetails
              setAskingDetails(null)
              /* A serial product that ALSO asks for a description or a price
                 asks for its unit next, rather than landing on the invoice
                 without one — `addWithPrompts` returns before reaching the
                 serial check when it opens this dialog, so the second question
                 has to be asked on the way out of it. */
              if (product.productType === 'serial') {
                setPendingAnswers(answers)
                askForSerial(product)
                return
              }
              appendLine(product, answers)
            }}
          />
        )}

        {/*
          WHICH unit is going out (235).

          The till's own picker, not a copy of it: same scan box, same list, and
          the same `serial_capture_mode` setting deciding whether the list is
          offered at all — a shop that stopped its cashiers picking off a list
          did so because of what that habit costs, and the habit is no better in
          the back office.
        */}
        {askingSerial && (
          <SerialModal
            product={
              (askingSerial.product ?? {
                id: askingSerial.productId,
                description: askingSerial.description,
              }) as TillProduct
            }
            units={serialUnits}
            capture={serialCapture}
            loading={serialsLoading}
            onCancel={() => {
              setAskingSerial(null)
              setPendingAnswers(null)
            }}
            onConfirm={(unit) => {
              const asking = askingSerial
              const answers = pendingAnswers
              setAskingSerial(null)
              setPendingAnswers(null)

              /* Filling in or changing an EXISTING line's unit, rather than
                 adding one. The line keeps everything else it had — only the
                 unit it promises changes. */
              if (asking.line) {
                setLines((current) =>
                  current.map((l) =>
                    l.key === asking.line
                      ? { ...l, serialId: unit.id, serialLabel: unit.serial }
                      : l,
                  ),
                )
                return
              }

              if (asking.product) appendLine(asking.product, answers ?? undefined, unit)
            }}
          />
        )}

        {/*
          The shared product picker — the products grid in a dialog.

          Both gestures are wired, because capturing an order is both kinds of
          job: clicking a name adds that one and closes, which is what happens
          when the customer asks for a specific thing; ticking a run of rows and
          pressing Add puts them all on at once, which is what happens with an
          order sheet in hand.
        */}
        <ProductSearchModal
          open={searchOpen}
          onClose={() => setSearchOpen(false)}
          onPick={pickFromSearch}
          onPickMany={pickManyFromSearch}
          title="Add a product"
          description="Search, filter and sort the catalogue. Click a name to add one, or tick several and add them together."
          confirmLabel="Add"
        />

        {/*
          The supervisor pad for a quantity this clerk may not set alone.

          Mounted only while one is pending, so its state starts fresh each time
          — the till mounts its own the same way, and for the same reason a kept
          pad would carry the last refusal's error onto the next line.
        */}
        {qtyApproval && (
          <OverrideModal
            open
            /* Never read: `online` is true, so the offline branch — the only
               thing that consults siteId — cannot run. The counter has no
               offline store of its own (see the note on `serialCapture` in
               page.tsx), which is exactly why it is hard-coded rather than
               threaded through three pages to be ignored. */
            siteId={0}
            online
            capability="sales.qty_override"
            actionLabel={`Quantity ${formatQty(qtyApproval.to)} on ${qtyApproval.description}`}
            documentId={document.id}
            cashierName={operatorName ?? ''}
            onClose={() => {
              /* Declined, or dismissed. The quantity goes back to the one the
                 clerk is entitled to rather than staying as typed — leaving the
                 figure on screen after a refused approval would read as though
                 it had been allowed, and it is the figure that would be saved. */
              patch(qtyApproval.key, { qty: qtyApproval.from })
              setQtyApproval(null)
            }}
            onAuthorised={() => {
              /* The typed figure is already in the line — the cell wrote it on
                 the way out. What the approval adds is permission for it to
                 STAY, and for this line to be adjusted again without fetching
                 the manager back. */
              setApprovedQtyKeys((current) => new Set(current).add(qtyApproval.key))
              setQtyApproval(null)
            }}
          />
        )}

        {/*
          WHAT NOW — answered HERE, not in the back office.

          This used to offer one button that navigated to /sales/[id], which
          left the invoicing window entirely: the counter lost its chrome, its
          offline shell and its place in the queue, to reach four buttons. The
          four buttons now come to it — and so does the record itself.

          The record is the point. "Finalised" as a line of text asks the
          operator to take the system's word for it; showing the SALE — what was
          rung, what it came to, how it was paid — lets them check it against
          the customer standing in front of them before anyone walks off. It is
          the same <SaleRecord> the /sales/[id] screen renders, so the two can
          never disagree about a sale.

          Everything destructive is still re-checked server-side — voidSaleAction
          and creditWholeSaleAction each resolve the operator and their role for
          themselves — so these buttons decide what is EASY, never what is
          permitted.
        */}
        <Modal
          open={receipt !== null}
          onClose={leaveFinalised}
          title={
            finalisedFace === 'void'
              ? 'Cancel this invoice'
              : finalisedFace === 'credit'
                ? 'Credit this invoice'
                : (receipt?.number ?? 'Invoice finalised')
          }
          description={
            finalisedFace !== null
              ? (receipt?.number ?? undefined)
              : record
                ? `${record.docLabel} · ${record.documentDate}`
                : 'Finalised'
          }
          /* The reason face is one question with a reason list; the record is a
             three-column layout. They are not the same dialog size. */
          size={finalisedFace === null ? 'xl' : 'sm'}
          /* And as tall as the screen allows. The record face is a full sale —
             header, lines, tenders, totals — which is the shape the 60vh cap
             gets most wrong, because the lines are the middle and scrolled away
             from both ends. The buttons stay in the footer for the reason
             below; a grown body still scrolls on a long enough invoice. */
          bodyGrows
          footer={
            finalisedFace === null ? (
              /* The four buttons live in the FOOTER now, not in the body: the
                 body is a scrolling record, and an action row that scrolls out
                 of reach is an action row the counter cannot find. */
              <>
                {canVoid && (
                  <Button variant="danger-ghost" onClick={() => setFinalisedFace('void')}>
                    <Icons.Close size={15} />
                    Cancel sale
                  </Button>
                )}

                {canCredit && (
                  <Button variant="ghost" onClick={() => setFinalisedFace('credit')}>
                    <Icons.Reverse size={15} />
                    Credit sale
                  </Button>
                )}

                <Button variant="ghost" onClick={() => setEmailingPosted(true)}>
                  <Icons.Mail size={15} />
                  Email
                </Button>

                {/* Print leads: on a posted invoice it is what most of these
                    dialogs are for. Rendered into a hidden frame so the printed
                    page is the DOCUMENT — window.print() here would print the
                    capture screen behind the dialog — and so the counter gets
                    the print dialog rather than a tab to dismiss first.

                    The A4 route, not the slip, and for the same reason the
                    toolbar's Print above uses it: this screen writes invoices
                    for account customers, and what they file needs the banking
                    block, VAT number and terms that only the A4 document
                    carries. The 80mm slip belongs to a retail or hospitality
                    till, where the customer is standing at the counter.

                    No recordPrintAction: that route counts a finalised
                    invoice's print server-side, so calling it here as well
                    would count one print twice and make the COPY banner on the
                    next one wrong. */}
                <Button
                  variant="secondary"
                  onClick={() => {
                    if (!receipt) return
                    printDoc(`/sales/${receipt.documentId}/document`)
                  }}
                >
                  <Icons.Printer size={15} />
                  Print
                </Button>

                <Button variant="primary" onClick={leaveFinalised}>
                  Done
                </Button>
              </>
            ) : (
              <>
                <Button
                  variant="secondary"
                  disabled={pending}
                  onClick={() => {
                    setFinalisedFace(null)
                    setPostedReasonId(null)
                    setPostedNote('')
                  }}
                >
                  Back
                </Button>
                <Button
                  variant="danger"
                  disabled={pending || postedReasonId === null}
                  onClick={finalisedFace === 'void' ? voidPosted : creditPosted}
                >
                  {finalisedFace === 'void' ? 'Cancel the invoice' : 'Credit it in full'}
                </Button>
              </>
            )
          }
        >
          {finalisedFace === null ? (
            <div className="flex flex-col gap-4">
              {/* Change first and loudest: it is the one thing on this dialog
                  that is owed to a person rather than filed. */}
              {receipt !== null && receipt.change > 0 && (
                <p className="rounded-card bg-success-soft px-4 py-3 text-sm text-success-ink">
                  Change due{' '}
                  <span className="numeric font-semibold">{formatMoney(receipt.change)}</span>
                </p>
              )}

              {record ? (
                <SaleRecord sale={record} linkCredits={false} />
              ) : (
                /* The one beat before the record lands. It says what is known
                   for certain already — the sale posted — rather than an empty
                   panel that reads like something went wrong. */
                <p className="text-sm text-muted">
                  {formatMoney(computed.totals.totalIncl)} posted. Stock has moved and the payment
                  is recorded against this sale.
                </p>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <p className="text-sm text-muted">
                {finalisedFace === 'void'
                  ? 'The invoice is reversed and the stock goes back. Same-day only — after today, credit it instead.'
                  : 'Every line is credited and the stock comes back. The invoice stays on file as issued.'}
              </p>
              <ReasonPicker
                reasons={finalisedFace === 'void' ? voidReasons : returnReasons}
                value={postedReasonId}
                onChange={setPostedReasonId}
                note={postedNote}
                onNoteChange={setPostedNote}
              />
            </div>
          )}
        </Modal>

        <NameSaleModal
          open={namingSale}
          noun={noun.toLowerCase()}
          onClose={() => setNamingSale(false)}
          onSave={saveNamed}
          busy={pending}
        />

        {/* The same dialog the back office and the register use. */}
        {receipt !== null && (
          <EmailInvoiceDialog
            open={emailingPosted}
            onClose={() => setEmailingPosted(false)}
            documentId={receipt.documentId}
            documentNumber={receipt.number}
            /* The till customer record carries CREDIT facts, not contact
               details, so there is no address to prefill here — the dialog asks
               for one, which is also what a walk-in needs. */
            defaultTo=""
            lastEmailedNote={null}
          />
        )}
      </PageBody>
    </>
  )
}

/**
 * "Name this sale" — the prompt Save (draft) raises on a document with no
 * customer.
 *
 * ── WHY IT IS A DIALOG AND NOT A RED FIELD ────────────────────────────────
 *
 * The alternative was to mark the header field and refuse the save. That tells
 * somebody they have done something wrong; this asks them a question, which is
 * what is actually happening — the sale is fine, it just has no name yet. It
 * also puts the cursor in the right box without them hunting for it.
 *
 * Nothing is captured but the name. A customer picker belongs to the header
 * (attach a real account there and this dialog never opens), and a second way
 * to attach one would be a second thing to keep in step.
 */
function NameSaleModal({
  open,
  noun,
  busy = false,
  onClose,
  onSave,
}: {
  open: boolean
  /** "invoice", "quote", "order" — so the dialog says what is being saved. */
  noun: string
  busy?: boolean
  onClose: () => void
  onSave: (name: string) => void
}) {
  const [name, setName] = useState('')

  /* Fresh every time. A dialog that remembers the last name silently saves this
     sale under the previous one's identity — and the two would be close enough
     in a day's work that nobody would spot it. */
  useEffect(() => {
    if (!open) return
    setName('')
  }, [open])

  const named = name.trim() !== ''

  function submit() {
    if (!named || busy) return
    onSave(name)
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Name this sale"
      description={`A draft ${noun} has no number yet, so the name is how you find it again.`}
      size="sm"
      /* Half-typed work: a stray tap on the backdrop must not lose the name
         somebody is partway through entering. Same rule as the till's own
         naming dialog. */
      closeOnBackdrop={false}
      footer={
        <>
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={busy || !named} onClick={submit}>
            <Icons.Save size={16} />
            {busy ? 'Saving…' : 'Save draft'}
          </Button>
        </>
      }
    >
      <Field
        label="Sale name"
        hint="A customer's name, a job, a phone number — whatever you will look for."
      >
        <Input
          autoFocus
          value={name}
          maxLength={120}
          placeholder="Who or what is this sale for?"
          onChange={(e) => setName(e.target.value)}
          /* Enter saves. This dialog has one field and one answer, and reaching
             for the mouse to confirm a name you have just typed is a step with
             no purpose. */
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              submit()
            }
          }}
        />
      </Field>
    </Modal>
  )
}
