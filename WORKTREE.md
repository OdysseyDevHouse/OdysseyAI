# Worktree: multi-store online storefront

Working copy for the multi-store online store plan. **Not the main tree.**

| | Main tree | This worktree |
|---|---|---|
| Path | `C:\Users\tiaan\Documents\Github\OdysseyAI` | `C:\Users\tiaan\Documents\Github\OdysseyAI-multistore` |
| Branch | `main` | `multi-store-online` |
| Port | 4100 | **4101** |
| Branched from | — | `302d0a4` (Billing: the modules now actually gate) |

Plan: `C:\Users\tiaan\.claude\plans\i-want-to-create-greedy-nygaard.md`

## Running it

```powershell
cd C:\Users\tiaan\Documents\Github\OdysseyAI-multistore
npx next dev -p 4101
```

**Never `npm run dev` here.** `package.json` hardcodes `-p 4100`, which would fight the
main tree's server. `package.json` is deliberately left unedited so it doesn't show up as
a diff on this branch — pass the port on the command line instead.

`.env` here has `PORT=4101` / `APP_URL=http://localhost:4101`. Env files are gitignored,
so that change is local to this worktree and cannot leak into a commit.

Point verification scripts at this port:

```powershell
$env:APP_URL = "http://localhost:4101"
$env:TEST_BASE = "http://localhost:4101"
```

## Why a worktree

Two sessions editing one folder means one copy of every file on disk — last write wins,
silently, and git never sees the intermediate state to conflict over. Two worktrees means
two copies. A collision becomes a merge conflict you get shown, instead of an overwrite
you don't.

It shares the same `.git`, so both trees see the same commits and branches. What it does
**not** share is the working tree: the main tree's uncommitted files were left completely
alone when this was created, and stay that way.

## Rules for this tree

- **Commit early and often.** Branches only protect *committed* work. Uncommitted edits
  are one careless command from gone.
- **Never** `git checkout .`, `git stash`, `git reset --hard`, or `sed -i` on a shared
  file. Each of those has destroyed work in this repo before, and each one targets
  uncommitted changes specifically.
- `node_modules` is a real `npm install`, not a junction — Turbopack breaks on a link.
- Migrations are applied, not suggested: run `site-migrate.mjs` for every active site
  before calling any phase done.

## When it's finished

```powershell
cd C:\Users\tiaan\Documents\Github\OdysseyAI
git merge multi-store-online
```

Different files, or different parts of a file → merges automatically. Same lines changed
in both → git stops and shows the conflict rather than picking a winner.

Then remove it:

```powershell
git worktree remove C:\Users\tiaan\Documents\Github\OdysseyAI-multistore
git branch -d multi-store-online
```
