# OdysseyAI Back Office

Multi-store point of sale back office. One Next.js app, shipped two ways: a web
deployment and a Windows desktop build wrapped in Electron.

## Stack

| Layer     | Choice                                                          |
| --------- | --------------------------------------------------------------- |
| Frontend  | Next.js 16 App Router, React 19, TypeScript, Tailwind v4, lucide |
| Backend   | Route handlers + server actions in the same process              |
| Data      | `mysql2` straight to MySQL/MariaDB, no ORM                       |
| Auth      | `jose` JWT in an httpOnly cookie, scrypt password hashing        |
| Desktop   | Electron shell running the same Next build (`electron-builder`)  |

Business logic lives in `src/lib/` and is shared by server components, server
actions and route handlers. There is no second repo or separate API server.

## Tenancy

One database, shared by every store. Every business table carries a `store_id`,
and unique keys are composite on `(store_id, …)` — two stores can both use the
product code `MILK-1L`.

Data functions take a `storeId` as their first argument rather than reading the
session themselves. A query that cannot run without being handed a store id
cannot accidentally run unscoped. Pages get that id from `requireStoreId()`.

Users belong to one store. A `platform_admin` has `store_id = NULL` and picks a
store at `/select-store`, which re-issues the session JWT — store users can
never change their own `storeId`.

## Getting started

```bash
npm install
cp .env.example .env      # then fill in DB_PASSWORD and SESSION_SECRET
npm run db:migrate        # creates the database and applies sql/migrations/
npm run db:seed           # demo store, logins, products, customers, suppliers
npm run dev               # http://localhost:4100
```

Seeded logins (password `Odyssey#2026`, override with `SEED_PASSWORD`):

| Email                   | Role           |
| ----------------------- | -------------- |
| `owner@odysseyai.local`   | Store owner    |
| `admin@odysseyai.local`   | Platform admin |

Port 4100 is deliberate — it keeps this app clear of the Odyssey back office on
4000.

## Desktop

```bash
npm run dev:desktop       # Next dev server + Electron, hot reload
npm run dist              # Windows installer into release/
```

The shell boots Next's production server in-process and waits on
`/api/health` before opening a window, so a database outage shows a real error
instead of a hung window.

## Layout

```
sql/migrations/     numbered .sql, applied once each, tracked in schema_migrations
scripts/            migrate, seed, free-port
electron/           desktop shell (main + preload)
src/lib/            all business logic — db, auth, products, customers, suppliers
src/app/(app)/      authenticated pages (dashboard, products, customers, …)
src/app/api/        route handlers (health, signout)
src/components/     shared UI
```

## Conventions

- **Money** is `DECIMAL(12,4)` and comes back from MySQL as a **string**.
  Convert only through `src/lib/decimals.ts` — never let it near a float.
  Quantities are `DECIMAL(12,3)` so weighed goods work.
- **Selling price is VAT-inclusive**, cost price is exclusive. `marginPercent`
  backs the VAT out before comparing.
- **Nothing is hard deleted.** Records deactivate, because history references
  them. Customers with a non-zero balance refuse to deactivate at all.
- **`stock_on_hand` is not editable through the product form** — it moves via
  `adjustStock()` so every change leaves an `activity_log` line.
- Login failures return one generic message, so the form can't be used to
  enumerate accounts.

## Not built yet

Sales/transactions, purchase orders and GRV, stocktakes, reporting, the AI
features (`@anthropic-ai/sdk` is installed but unused), and the offline POS
cache (`dexie` likewise). The schema and lib layer are shaped to take them.
