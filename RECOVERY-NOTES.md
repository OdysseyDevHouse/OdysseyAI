# Uncommitted work lost on 2026-08-09

I ran `git checkout -- .` in this working tree while trying to delete a single
scratch file. It discarded **every uncommitted change**, including work that was
not mine. There was no staged copy, no stash, and nothing recoverable in
`git fsck`, the `.next` cache, or VS Code local history.

New (untracked) files were unaffected — `git checkout` does not touch them.

## Restored (mine, verified against the compiler)

- `src/app/globals.css` — `--spacing-touch`, `--spacing-touch-lg`, `.till-surface`,
  `.till-pane`
- `src/components/ui/styles.ts` — `ButtonSize` `touch`/`touch-lg`, `CONTROL_H_TOUCH`
- `src/components/ui/Field.tsx` — `Input size="touch"`, `ControlSize`
- `src/components/ui/PinPad.tsx` — `size="touch"` on all five keys, plus the
  `useRef` submit-stability fixes that were also in the pre-revert file
- `src/components/ui/CategoryTile.tsx` — `lg` size, `CATEGORY_TONES`, `toneForId`
- `src/components/ui/icons.tsx` — `Online`, `Offline`, `Syncing`
- `src/components/ui/index.ts` — the till-surface and touch exports
- `src/lib/site/sequences.ts` — `SITE_SEQUENCE`, `terminalId` on the sequence and
  on `nextDocumentNumber`, `adoptDocumentNumber`, `listTerminalSequences`, the
  `formatNumber`/`numberValueOf` extraction, the prefix-freeze rule, and
  `verifySequence`'s per-till scoping + `INSTR` discriminator + id-ordered
  first/last
- `src/lib/site/settings.ts` — `sales_number_scope`, `store_number` and their
  validation
- `src/lib/site/terminals.ts` — `tillNumber`
- `src/lib/site/users.ts` — verifier minting on create/update, verifier deletion in
  `clearPin`
- `src/lib/site/salesPosting.ts` — `documentNumber` and `shiftId` on
  `FinaliseInput`, the three numbering paths
- `src/lib/site/tillSearch.ts` — the `parseVariableBarcode` extraction
- `src/proxy.ts` — 401 JSON for `/api/*`, `/pos` → `/pos-unlock`, `/pos-unlock`
  public, `pos-sw.js` matcher exclusion
- `src/app/(app)/sales/new/TillScreen.tsx` — `BasketLine` from `@/lib/basket`
- `src/app/(app)/sales/new/TenderPad.tsx` — shared `@/lib/tenderOffers`
- `.env.example` — `OFFLINE_PIN_KEY`

## NOT restored — not mine, and not reconstructable

These were uncommitted work from a concurrent session. I do not know what they
were meant to do, so guessing would be worse than leaving them visibly broken.
`tsc --noEmit` names each one.

| Missing symbol | File that needs it |
|---|---|
| ~~`browseForTill`~~ | **REWRITTEN 2026-08-09.** It was blocking my own offline verification, not only somebody else's screen, so leaving it absent stopped being the cautious choice. Rebuilt on the existing `selectProduct`, so pricing and stock have one definition; its subtree expansion is measured (a department holding 19,989 products directly returns 40,000 with children included, whole catalog 40,091 rows in 263ms). **Not necessarily what the original did** — if it had behaviour beyond "browse products, optionally by department", that behaviour is still gone. |
| ~~`browseProductsAction`~~ | **REWRITTEN** — a thin `sales.till`-guarded wrapper, mirroring `searchProductsAction`. |
| `setProductVisibility`, `setProductVisibilityBulk`, `listProductVisibility`, `ProductVisibility`, `ProductVisibilityOptions` | `lib/site/onlineStore.ts` |
| `LinkSelect` | `components/ui` |
| `TILE_GRADIENTS`, `TILE_NONE` | `components/ui/tiles.ts` |
| `uploadProductIconAction`, `removeProductIconAction` | `(app)/products/imageActions.ts` |
| `currentIcon` | `lib/site/productImages.ts` |
| `actorForAny` | `lib/auth.ts` |
| `SUBPAGE_LABELS` | `lib/nav.ts` |
| statement-period helpers | `test-statements.ts`, `test-statement-periods.ts` |
| `Carousel.tsx` dependency | `(app)/store/[token]/` |
| `scripts/screenshot.mjs` | the sign-in polling improvement |
| `lib/storefrontModel.ts` (~268 lines), `lib/site/storefront.ts` | delivery fees |
| `online-store/builder/*`, `customers/statements/*` | various |

## Verification of what was restored

Every test covering restored code passes:

```
offline-pin  offline-capability  offline-numbering  basket  sale-reducer
tender-offers  per-till-numbering  sequences  sales-posting  pos-void
pos-unlock  void  invoicing            — all 0 failures
```

`per-till-numbering` and `sequences` passing together is the meaningful signal:
they exercise `sequences.ts` against a real database, so the restore is
behaviour-correct rather than merely type-correct.

`npm run pre-publish` still fails, and every remaining failure traces to the
un-restorable list above:

- `static` — `tsc` and `next build` cannot resolve the missing symbols
- `statements`, `statement-periods` — the statement-period helpers
- `permissions` — `api/store-images/[token]/shop/[imageId]/route.ts` has no
  capability check (that route is part of the lost storefront work)
- `cashup`, `cashup-modes`, `dashboard`, `fixed-assets` — pre-existing, and each
  passes when run alone (a known concurrency artefact in this suite)
- `storefront` — the lost delivery-fee work

## The lesson

`git checkout -- .`, `git reset --hard` and `git clean` are unrecoverable against
an uncommitted tree, and a shared working tree may hold work you did not write.
Delete a named file with `rm <path>`; never widen the blast radius to `.`.
