---
description: Run the full pre-publish check on the back office and triage what broke
---

Run the full pre-publish check and report whether the back office is safe to publish.

## Run it

```
node --env-file=.env --env-file=.env.local scripts/pre-publish.mjs --json .pre-publish/report.json
```

Arguments the user gave: $ARGUMENTS

Pass them through when they map onto a flag the runner takes:

- `--skip=smoke` / `--gate=domain` — run a subset. "quick", "fast" or "no browser" means `--skip=smoke`.
- `--concurrency=N` — parallel domain tests, default 4.
- `--allow-remote-db` — only if the user explicitly says the target is a disposable
  remote database. Never add this on your own initiative; the guard exists because
  every gate below writes real rows.

This takes several minutes with the smoke gate and about a minute without. Run it in
the background and read `.pre-publish/report.json` when it finishes, rather than
piping the output — a pipe buffers the per-test lines and you see nothing until the end.

## What the gates mean

| Gate | Checks | A failure means |
|---|---|---|
| `static` | `tsc --noEmit`, `next build`, design-system rules | Will not compile or breaks the UI kit |
| `migrations` | `sql/site/*.sql` on every active site | Schema is behind; later gates cannot be trusted |
| `domain` | all 65 `scripts/test-*.ts` | Business logic is wrong — money, stock, posting |
| `smoke` | all 123 back-office screens in a real browser | A page 500s at request time despite compiling |

## Then triage — this is the part that matters

Do not just relay the list. Read `.pre-publish/report.json` and work out what is
actually broken, because the raw list overstates it in two specific ways this suite
is known to produce:

**Cascades.** One root cause shows up as several failures. If a test that seeds data
fails, everything downstream of it fails too. Report the cause, and say which
failures follow from it, rather than listing each as a separate problem.

**Order-dependent flakes.** Roughly a third of the domain tests end by asserting a
site-wide invariant — `reconcileStock` finds no drift anywhere, every issued document
number has a document behind it. The runner already gives those a `[solo]` pass so
they do not fail each other, but a few (`cashup`, `fixed-assets` have both done this)
still fail after a full suite run and pass when run alone, because an earlier test
left data behind that they read as drift.

Before reporting any reconciliation or invariant failure as a real bug, re-run that
test on its own:

```
node node_modules/tsx/dist/cli.mjs --conditions=react-server --env-file=.env scripts/test-<name>.ts
```

If it passes alone, it is a test-isolation problem, not a product bug — say so
plainly and separate it from the real findings. Do not report it as "the GL is
broken" when the GL reconciles cleanly at rest.

**A degraded dev server, in the smoke gate.** If a smoke failure mentions
`Jest worker encountered N child process exceptions`, that is Next's worker pool
falling over, not the page. A long-running dev server reaches this state and then
500s every route it compiles afterwards — the first full crawl here reported 19
such routes and every one passed against a freshly started server. The gate now
restarts the server itself, so this should not recur; if it does, re-check the
route on a clean server before reporting it:

```
node scripts/free-port.mjs 4100 && node node_modules/next/dist/bin/next dev -p 4100
node --env-file=.env --env-file=.env.local scripts/smoke-routes.mjs --only <fragment>
```

The tell is the shape of the failure list: real bugs cluster by feature, this
clusters by *when in the crawl the route was reached*.

**Do not fix anything unless the user asks.** The job of this command is to report an
accurate picture of what is broken. Offer to fix, and let them choose.

## Reporting back

Lead with the verdict — safe to publish, or not, and why. Then:

- **Real failures**, most serious first, each with the file and what actually breaks
  for a user. Money, stock and posting bugs outrank cosmetic ones.
- **Flakes and cascades**, named as such, with the evidence (passes alone / follows
  from X).
- **Skipped smoke routes.** These were NOT checked — a screen skipped for want of a
  row in its table is unverified, not passing. Say how many, and never fold them into
  the pass count.

Keep it to what the user needs in order to decide. A wall of green PASS lines is not
a report.
