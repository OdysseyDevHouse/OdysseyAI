<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Use the OdysseyAI design system — always

Every screen in this app is built from one shared kit. This is not a preference;
it is the thing that lets a single edit restyle the whole product. Before
writing or changing **any** UI, invoke the `odyssey-ui` skill for the full
reference, and follow these rules:

1. **Import from `@/components/ui`.** Buttons, inputs, tables, tabs, menus,
   badges, toasts, cards and empty states already exist. Never hand-roll one.
2. **Never write a raw colour.** No hex values, no `rgb()`, and none of
   Tailwind's stock palette (`bg-blue-600`, `text-gray-500`, `border-slate-200`).
   Use the tokens: `bg-brand`, `text-muted`, `border-border`, `bg-success-soft`,
   `rounded-card`, `h-control`, `shadow-pop`, …
3. **Tokens live in `src/app/globals.css`** and nowhere else. Shared class
   strings live in `src/components/ui/styles.ts`. Restyling the app means
   editing one of those two files — if a change needs edits in more than one
   screen, it is being done in the wrong place.
4. **Icons come from `@/components/ui/icons`**, never straight from
   `lucide-react`.
5. **Extend the kit, don't bypass it.** If a screen needs something the kit
   lacks, add it to `src/components/ui/`, show it on the Style Guide page, and
   then use it — rather than styling it inline "just this once".

The live reference is `/setup/style-guide`
(`src/app/(app)/setup/style-guide/page.tsx`). It imports the real components, so
whatever it renders is what the app looks like today. Anything added to the kit
gets added there too.
