/**
 * The purchase order we ship — the starting point every custom one forks from.
 *
 * ── IT IS A TEMPLATE, NOT A FALLBACK ──────────────────────────────────────
 *
 * This is the same language a site writes, run through the same renderer, with
 * no privileged path of its own. If the template language cannot express the
 * default document, the language is wrong — so keeping this honest is what
 * stops the designer from being a toy that only handles simple layouts.
 *
 * ── IT MUST LOOK LIKE THE COMPONENT IT REPLACES ───────────────────────────
 *
 * The classes here are the app's own (`text-muted`, `border-border`, the TABLE_*
 * strings from components/ui/styles.ts), because a printed page renders inside
 * the app where those exist. Day one output is therefore the same document as
 * PurchaseOrderDocument.tsx produced, which is what makes this safe to switch
 * on: nobody's paperwork changes until they change it.
 *
 * ── WHAT IS DELIBERATELY ABSENT ───────────────────────────────────────────
 *
 * Received quantities, landed cost, the audit trail. This is the supplier's
 * copy: it is written for someone who does not have the system in front of
 * them, and "3 of 10 received" would be our records rather than their
 * instruction. The catalog will not name those fields and the adapter will not
 * supply them; this template not showing them is the third lock.
 *
 * Cost columns ARE here, and print for whoever holds products.cost. That is the
 * feature: one document, and who is printing decides whether the money shows.
 */
export const PURCHASE_ORDER_DEFAULT = `<style>
/*
 * A labelled row whose value came out empty removes itself.
 *
 * "Reference" against a blank box reads as a reference someone forgot to type,
 * rather than an order that simply has none. Done in CSS instead of with a
 * conditional in the template language: it is one rule that covers every such
 * row, it needs no feature that would then need supporting forever, and a
 * designer who wants the empty row back deletes the rule.
 */
.po-row:has(dd:empty) { display: none; }
/* Same rule for a whole titled block: no notes means no NOTES heading. */
.po-block:has(> p.po-value:empty) { display: none; }
</style>
<article class="mx-auto w-full max-w-[52rem] bg-surface p-8 text-ink">
  <header class="flex items-start justify-between gap-8 border-b border-border pb-5">
    <div>
      {site.logo}
      <h1 class="text-lg font-semibold text-ink">{site.name}</h1>
      <p class="mt-1 text-xs leading-relaxed text-muted">{site.address}</p>
      <p class="mt-1 text-xs text-muted">
        <span class="block">{site.vatLine}</span>
        <span class="block">{site.registrationLine}</span>
        <span class="block">{site.phone}</span>
        <span class="block">{site.email}</span>
      </p>
    </div>
    <div class="text-right">
      <h2 class="text-xl font-semibold tracking-wide text-ink">PURCHASE ORDER</h2>
      <p class="mt-0.5 text-sm font-medium text-ink-2">{doc.number}</p>
      <p class="mt-0.5 text-sm text-muted">{doc.date}</p>
      <p class="mt-1 text-xs font-medium tracking-wide text-warning-ink">{doc.statusBanner}</p>
    </div>
  </header>

  <section class="grid gap-6 border-b border-border py-5 sm:grid-cols-2">
    <div>
      <p class="text-xs font-medium tracking-wide text-muted">TO</p>
      <p class="mt-1 font-medium text-ink">{supplier.name}</p>
      <p class="text-sm text-ink-2">{supplier.contactName}</p>
      <p class="text-sm text-muted">{supplier.address}</p>
      <p class="text-sm text-muted">{supplier.email}</p>
      <p class="text-sm text-muted">{supplier.phone}</p>
      <p class="mt-1 text-xs text-muted">{supplier.accountLine}</p>
    </div>
    <div>
      <p class="text-xs font-medium tracking-wide text-muted">DELIVER TO</p>
      <p class="text-sm text-ink-2">{deliverTo}</p>
      <dl class="mt-3 flex flex-col gap-1 text-sm">
        <div class="po-row flex justify-between gap-6">
          <dt class="text-muted">Required by</dt>
          <dd class="font-medium text-ink">{doc.expectedDate}</dd>
        </div>
        <div class="po-row flex justify-between gap-6">
          <dt class="text-muted">Reference</dt>
          <dd class="text-ink">{doc.reference}</dd>
        </div>
        <div class="po-row flex justify-between gap-6">
          <dt class="text-muted">Terms</dt>
          <dd class="text-ink">{supplier.paymentTermsLine}</dd>
        </div>
        <div class="po-row flex justify-between gap-6">
          <dt class="text-muted">Ordered by</dt>
          <dd class="text-ink">{doc.orderedBy}</dd>
        </div>
      </dl>
    </div>
  </section>

  <section class="py-5">
    <table class="w-full border-collapse text-sm">
      <thead>
        <tr class="border-y border-border bg-surface-2">
          <th class="px-4 pt-3 pb-2.5 text-left align-top text-[13px] font-normal leading-tight text-muted">Item</th>
          <th class="px-4 pt-3 pb-2.5 text-right align-top text-[13px] font-normal leading-tight text-muted">Qty</th>
          <th class="px-4 pt-3 pb-2.5 text-right align-top text-[13px] font-normal leading-tight text-muted">Unit cost</th>
          <th class="px-4 pt-3 pb-2.5 text-right align-top text-[13px] font-normal leading-tight text-muted">Total (excl.)</th>
        </tr>
      </thead>
      <tbody>
        {#each lines}
        <tr class="border-b border-border last:border-b-0">
          <td class="px-4 py-1.5 text-ink-2">
            <div class="text-ink">{line.description}</div>
            <div class="text-xs text-muted">{line.supplierCode}</div>
          </td>
          <td class="px-4 py-1.5 numeric text-right whitespace-nowrap text-ink-2">{line.qty}</td>
          <td class="px-4 py-1.5 numeric text-right whitespace-nowrap text-ink-2">{line.unitCostExcl}</td>
          <td class="px-4 py-1.5 numeric text-right whitespace-nowrap text-ink">{line.totalExcl}</td>
        </tr>
        {/each}
      </tbody>
    </table>
  </section>

  <section class="flex justify-end border-t border-border py-5">
    <div class="w-full max-w-xs">
      <dl class="flex flex-col gap-1.5 text-sm">
        <div class="po-row flex justify-between gap-6">
          <dt class="text-muted">Goods (excl.)</dt>
          <dd class="numeric text-ink">{totals.goodsExcl}</dd>
        </div>
        <div class="po-row flex justify-between gap-6">
          <dt class="text-muted">{{tax}}</dt>
          <dd class="numeric text-ink">{totals.vat}</dd>
        </div>
      </dl>
      <div class="mt-3 flex items-baseline justify-between gap-6 border-t border-border pt-3">
        <span class="font-medium text-ink">Total</span>
        <span class="numeric text-xl font-semibold text-ink">{totals.totalIncl}</span>
      </div>
    </div>
  </section>

  <section class="po-block border-t border-border py-5">
    <p class="mb-2 text-xs font-medium tracking-wide text-muted">NOTES</p>
    <p class="po-value whitespace-pre-line text-sm text-ink-2">{doc.notes}</p>
  </section>

  <footer class="border-t border-border pt-5">
    <p class="text-xs text-muted">
      Please quote {doc.number} on your delivery note and invoice.
      Deliveries not matching this order may be refused.
    </p>
    <p class="mt-2 text-xs text-faint">Printed {doc.printedAt}</p>
  </footer>
</article>`
