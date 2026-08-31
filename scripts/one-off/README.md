# One-off scripts

Repairs that were written for a specific mess, run once, and kept only because
the mess can recur and rewriting them from scratch would be worse. They are
**not** part of any suite and nothing calls them.

Kept here rather than in `scripts/` proper so that a directory listing does not
put a script that deletes rows next to `test-variants.ts`, and rather than in
the repo root — where they were, named `tmp-*.mjs`, one tab-completion away from
being run by accident.

## Read this before running any of them

Two of these **destroy data** and neither asks for confirmation:

| Script | What it does | Safe to re-run? |
| --- | --- | --- |
| `check-cashup-orphans.mjs` | Counts cashup journal batches whose shift is gone. Read-only. | Yes |
| `list-sites.mjs` | Prints active site ids from the control database. Read-only. | Yes |
| `sweep-cashup-orphans.mjs` | **DELETES** those orphaned batches and their journal lines, then repairs balances. | Yes, but see below |
| `repair-layby-seq.mjs` | **RENUMBERS** surviving lay-by documents contiguously and resets the sequence. | **No — see below** |

`repair-layby-seq.mjs` is the dangerous one. It rewrites document numbers that
have already been issued, which is forbidden on any site with real customers:
an issued number is a promise to somebody outside the business, and a document
that changes its number is one that cannot be reconciled against a statement or
produced for SARS. Its own header says "dev sites only", and that was true when
it was written because the system had no live sites yet
(`sql/` has no migration story for renumbering, deliberately).

**The database names are hardcoded.** Both cashup scripts loop over
`ody10000_master` and `ody10001_master` literally. On any other estate they will
either fail to connect or, worse, connect to something they were not written
for. Read the loop before running.

Both destructive scripts also depend on `.env` for credentials and
`ENCRYPTION_KEY` for the per-site secret, so they must be run as
`node --env-file=.env scripts/one-off/<name>.mjs`.

## Provenance

Recovered from `worktree-gap-closing-run` (`f667ef2`), where they sat in the
repo root as `tmp-*.mjs`. The six `.screenshots-wt/*.png` files in that same
commit were verification output and were deliberately not carried over —
`.screenshots/` is gitignored for exactly that reason.
