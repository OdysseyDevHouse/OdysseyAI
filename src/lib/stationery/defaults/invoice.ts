/**
 * The invoice we ship — the starting point every custom one forks from.
 *
 * ── IT CARRIES WHAT THE LAW ASKS FOR ──────────────────────────────────────
 *
 * The words TAX INVOICE (via {doc.heading}, which says INVOICE for a business
 * that is not a VAT vendor), both parties' names, the supplier's VAT number, a
 * serial number, the date, and VAT shown by rate. Section 20(4) of the VAT Act.
 * validate.ts refuses to save a fork that drops any of them, so a shop can
 * redesign this freely without being able to produce paperwork a customer
 * cannot claim against.
 *
 * ── WHAT IS NOT ON IT ─────────────────────────────────────────────────────
 *
 * Cost, margin, the internal note, the sales rep, the terminal. See the
 * adapter: the catalog does not name them and nothing supplies them, so no
 * redesign can put what the shop paid on the customer's copy.
 *
 * ── THE EMAILED INVOICE IS A DIFFERENT DOCUMENT, FOR NOW ──────────────────
 *
 * This designs the PRINTED invoice. An invoice emailed to a customer still
 * renders through lib/invoices/pdf.ts, which is hand-drawn with pdfkit and
 * reads no template. A shop that redesigns this and then emails an invoice
 * gets the standard layout, and the setup screen says so — a known gap, stated
 * rather than discovered.
 */
export const INVOICE_DEFAULT = `<style>
/* A labelled row or block whose value came out empty removes itself, so an
   invoice with no reference does not print "Reference" over a blank. */
.inv-row:has(dd:empty) { display: none; }
.inv-block:has(> p.inv-value:empty) { display: none; }
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
      <h2 class="text-xl font-semibold tracking-wide text-ink">{doc.heading}</h2>
      <p class="mt-0.5 text-sm font-medium text-ink-2">{doc.number}</p>
      <p class="mt-0.5 text-sm text-muted">{doc.date}</p>
    </div>
  </header>

  <section class="grid gap-6 border-b border-border py-5 sm:grid-cols-2">
    <div>
      <p class="text-xs font-medium tracking-wide text-muted">BILL TO</p>
      <p class="mt-1 font-medium text-ink">{customer.name}</p>
      <p class="text-sm text-muted">{customer.address}</p>
      <p class="text-sm text-muted">{customer.phone}</p>
      <p class="text-sm text-muted">{customer.vatNumber}</p>
    </div>
    <div>
      <dl class="flex flex-col gap-1 text-sm">
        <div class="inv-row flex justify-between gap-6">
          <dt class="text-muted">Account</dt>
          <dd class="text-ink">{customer.code}</dd>
        </div>
        <div class="inv-row flex justify-between gap-6">
          <dt class="text-muted">Due</dt>
          <dd class="font-medium text-ink">{doc.dueDate}</dd>
        </div>
        <div class="inv-row flex justify-between gap-6">
          <dt class="text-muted">Reference</dt>
          <dd class="text-ink">{doc.reference}</dd>
        </div>
        <div class="inv-row flex justify-between gap-6">
          <dt class="text-muted">Served by</dt>
          <dd class="text-ink">{doc.soldBy}</dd>
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
          <th class="px-4 pt-3 pb-2.5 text-right align-top text-[13px] font-normal leading-tight text-muted">Unit price</th>
          <th class="px-4 pt-3 pb-2.5 text-right align-top text-[13px] font-normal leading-tight text-muted">Amount</th>
        </tr>
      </thead>
      <tbody>
        {#each lines}
        <tr class="border-b border-border last:border-b-0">
          <td class="px-4 py-1.5 text-ink-2">
            <div class="text-ink">{line.description}</div>
            <div class="text-xs text-muted">{line.productCode}</div>
          </td>
          <td class="px-4 py-1.5 numeric text-right whitespace-nowrap text-ink-2">{line.qty}</td>
          <td class="px-4 py-1.5 numeric text-right whitespace-nowrap text-ink-2">{line.unitPriceIncl}</td>
          <td class="px-4 py-1.5 numeric text-right whitespace-nowrap text-ink">{line.totalIncl}</td>
        </tr>
        {/each}
      </tbody>
    </table>
  </section>

  <section class="flex justify-end border-t border-border py-5">
    <div class="w-full max-w-xs">
      <dl class="flex flex-col gap-1.5 text-sm">
        <div class="inv-row flex justify-between gap-6">
          <dt class="text-muted">Subtotal (excl.)</dt>
          <dd class="numeric text-ink">{totals.goodsExcl}</dd>
        </div>
        <div class="inv-row flex justify-between gap-6">
          <dt class="text-muted">Discount</dt>
          <dd class="numeric text-ink">{totals.discountIncl}</dd>
        </div>
        <div class="inv-row flex justify-between gap-6">
          <dt class="text-muted">VAT</dt>
          <dd class="numeric text-ink">{totals.vat}</dd>
        </div>
        <div class="inv-row flex justify-between gap-6">
          <dt class="text-muted">Rounding</dt>
          <dd class="numeric text-ink">{totals.roundingAdj}</dd>
        </div>
      </dl>
      <div class="mt-3 flex items-baseline justify-between gap-6 border-t border-border pt-3">
        <span class="font-medium text-ink">Total</span>
        <span class="numeric text-xl font-semibold text-ink">{totals.totalIncl}</span>
      </div>
    </div>
  </section>

  <section class="border-t border-border py-5">
    <p class="mb-2 text-xs font-medium tracking-wide text-muted">VAT SUMMARY</p>
    <p class="whitespace-pre-line text-sm text-ink-2">{totals.vatSummary}</p>
  </section>

  <section class="inv-block border-t border-border py-5">
    <p class="mb-2 text-xs font-medium tracking-wide text-muted">BANKING DETAILS</p>
    <p class="inv-value whitespace-pre-line text-sm text-ink-2">{banking}</p>
  </section>

  <section class="inv-block border-t border-border py-5">
    <p class="mb-2 text-xs font-medium tracking-wide text-muted">NOTES</p>
    <p class="inv-value whitespace-pre-line text-sm text-ink-2">{doc.notes}</p>
  </section>

  <footer class="border-t border-border pt-5">
    <p class="text-xs text-muted">{doc.closing}</p>
    <p class="mt-2 text-xs text-faint">Printed {doc.printedAt}</p>
  </footer>
</article>`
