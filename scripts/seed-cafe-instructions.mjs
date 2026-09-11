// Odyssey Cafe — test instruction data for the till's question modal.
//
//   node --env-file=.env --env-file=.env.local scripts/seed-cafe-instructions.mjs [--sites 33,45] [--drop]
//
// ── WHY THIS EXISTS ────────────────────────────────────────────────────────
//
// The instructions feature (sql/site/010, 080, 081) had no data on any cafe
// site, so nothing exercised it: not the till modal, not the kitchen ticket
// flags, not the reveal chain. This seeds a menu's worth of questions with a
// deliberate spread of shapes — single-choice, multi-choice, counted, and
// two-level — so each path has something real to run against.
//
// ── WHY IT KEYS ON PRODUCT CODE AND NOT ID ─────────────────────────────────
//
// Every cafe holds its OWN copy of the product file, and the same dish has a
// different id on each: "Full English Breakfast" is 203 on Sea Point, 216 on
// Claremont, 437 on Bloemfontein. A script carrying hardcoded ids would attach
// "How would you like your eggs?" to a coffee mug on nineteen sites out of
// twenty and look perfectly fine on the one it was written against. The CAF
// code is the stable identity, so every link is resolved through it and a code
// that is missing on a site is reported rather than guessed at.
//
// ── RE-RUNNING ─────────────────────────────────────────────────────────────
//
// Groups are matched by name (the table has a UNIQUE key on it), so a second
// run updates in place rather than duplicating. --drop removes only the groups
// this script names, and its options and links by cascade.
import mysql from 'mysql2/promise'
import { decryptSecret } from './lib/controlDb.mjs'

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null
}
const DROP = process.argv.includes('--drop')
const ONLY = arg('sites')
  ? new Set(arg('sites').split(',').map((s) => Number(s.trim())))
  : null

/* ── The questions ─────────────────────────────────────────────────────────
 *
 * `key` is internal, used only to wire reveals together below. `name` is what
 * the UNIQUE index matches on re-run, and what the back office lists.
 *
 * Option shorthand: [name, priceAdjust, productCode|null, extras]
 * `extras` carries the unusual bits — a count ceiling, a default, the print
 * flags, or the groups the answer goes on to ask.
 */
const GROUPS = [
  /* ── Single choice, required — the classic radio-button question ───────── */
  {
    key: 'eggs',
    name: 'How would you like your eggs?',
    prompt: 'How would you like your eggs?',
    isRequired: true,
    minChoices: 1,
    maxChoices: 1,
    options: [
      ['Fried — sunny side up', 0, null, { isDefault: true }],
      ['Fried — over easy', 0, null, {}],
      ['Scrambled', 0, null, {}],
      ['Poached', 0, null, {}],
      ['Omelette style', 0, null, {}],
      // Costs nothing and the kitchen must see it; the customer's slip need not
      // repeat it. This is the case 080's print flags exist for.
      ['No eggs', -8, null, { printsOnReceipt: false }],
    ],
  },
  {
    key: 'bread',
    name: 'Choice of bread',
    prompt: 'Which bread?',
    isRequired: true,
    minChoices: 1,
    maxChoices: 1,
    options: [
      ['White', 0, null, { isDefault: true }],
      ['Brown', 0, null, {}],
      ['Sourdough', 6, null, {}],
      ['Rye', 6, null, {}],
      ['Ciabatta', 8, null, {}],
      ['Gluten free', 15, 'CAF0257', {}],
    ],
  },
  {
    key: 'toastLevel',
    name: 'How toasted?',
    prompt: 'How would you like it toasted?',
    isRequired: false,
    minChoices: 0,
    maxChoices: 1,
    options: [
      ['Lightly toasted', 0, null, {}],
      ['Medium', 0, null, { isDefault: true }],
      ['Well toasted', 0, null, {}],
      ['Not toasted', 0, null, { printsOnReceipt: false }],
    ],
  },
  {
    key: 'steakTemp',
    name: 'Cooking temperature',
    prompt: 'How would you like it cooked?',
    isRequired: true,
    minChoices: 1,
    maxChoices: 1,
    options: [
      ['Rare', 0, null, {}],
      ['Medium rare', 0, null, {}],
      ['Medium', 0, null, { isDefault: true }],
      ['Medium well', 0, null, {}],
      ['Well done', 0, null, {}],
    ],
  },
  {
    key: 'milk',
    name: 'Choice of milk',
    prompt: 'Which milk?',
    isRequired: false,
    minChoices: 0,
    maxChoices: 1,
    options: [
      ['Full cream', 0, null, { isDefault: true }],
      ['Low fat', 0, null, {}],
      // Worth confirming on the slip, nothing for the kitchen to do.
      ['Almond', 8, 'CAF0243', { printsOnKitchen: true }],
      ['Oat', 8, 'CAF0244', {}],
      ['Soy', 8, 'CAF0245', {}],
      ['Coconut', 8, 'CAF0246', {}],
      ['Lactose free', 8, 'CAF0247', {}],
    ],
  },

  /* ── Multi choice, with counted options ────────────────────────────────── */
  {
    key: 'breakfastExtras',
    name: 'Breakfast extras',
    prompt: 'Anything extra?',
    isRequired: false,
    minChoices: 0,
    maxChoices: 4,
    options: [
      // maxQty above 1 renders a stepper: three rashers is one choice against
      // the group's ceiling of four, not three. That interaction is exactly
      // what 080 warns readers about, so it is worth having live data for.
      ['Extra bacon', 22, 'CAF0253', { maxQty: 3 }],
      ['Extra egg', 12, 'CAF0255', { maxQty: 3 }],
      ['Extra cheese', 10, 'CAF0252', { maxQty: 2 }],
      ['Extra avo', 25, 'CAF0254', { maxQty: 2 }],
      ['Extra halloumi', 28, 'CAF0256', { maxQty: 2 }],
      ['Grilled tomato', 8, null, {}],
      ['Sauteed mushrooms', 14, null, {}],
      ['Baked beans', 10, null, {}],
    ],
  },
  {
    key: 'sandwichExtras',
    name: 'Sandwich extras',
    prompt: 'Add anything?',
    isRequired: false,
    minChoices: 0,
    maxChoices: 3,
    options: [
      ['Extra cheese', 10, 'CAF0252', { maxQty: 2 }],
      ['Extra bacon', 22, 'CAF0253', { maxQty: 2 }],
      ['Extra avo', 25, 'CAF0254', {}],
      ['Extra halloumi', 28, 'CAF0256', {}],
      ['Caramelised onion', 8, null, {}],
      ['Jalapenos', 6, null, {}],
    ],
  },
  {
    key: 'hold',
    name: 'Leave anything out?',
    prompt: 'Leave anything out?',
    isRequired: false,
    minChoices: 0,
    maxChoices: 0, // 0 means no ceiling — tick as many as apply.
    options: [
      // None of these cost anything and none belong on the customer's slip,
      // but every one of them must reach the cook.
      ['No onion', 0, null, { printsOnReceipt: false }],
      ['No tomato', 0, null, { printsOnReceipt: false }],
      ['No mayo', 0, null, { printsOnReceipt: false }],
      ['No butter', 0, null, { printsOnReceipt: false }],
      ['No pickles', 0, null, { printsOnReceipt: false }],
      ['Sauce on the side', 0, null, { printsOnReceipt: false }],
    ],
  },
  {
    key: 'sauces',
    name: 'Sauce on the side',
    prompt: 'Any sauces?',
    isRequired: false,
    minChoices: 0,
    maxChoices: 2,
    options: [
      ['Aioli', 12, 'CAF0258', { maxQty: 2 }],
      ['Peri peri', 12, 'CAF0259', { maxQty: 2 }],
      ['BBQ', 12, 'CAF0260', { maxQty: 2 }],
      ['Mustard', 12, 'CAF0261', { maxQty: 2 }],
      ['Tomato sauce', 0, null, {}],
    ],
  },
  {
    key: 'syrup',
    name: 'Add a syrup',
    prompt: 'Add a syrup?',
    isRequired: false,
    minChoices: 0,
    /* 3 ITEMS, matching the 3 shots any one syrup allows.
       The group cap counts items, so a cap of 2 beneath an option that permits
       3 of itself is a ceiling nobody can reach — the third pump would be
       refused by the group before the option's own limit ever applied. */
    maxChoices: 3,
    options: [
      ['Vanilla', 8, 'CAF0239', { maxQty: 3 }],
      ['Caramel', 8, 'CAF0240', { maxQty: 3 }],
      ['Hazelnut', 8, 'CAF0241', { maxQty: 3 }],
      ['Cinnamon', 8, 'CAF0242', { maxQty: 3 }],
    ],
  },

  /* ── The groups a reveal points AT ─────────────────────────────────────── */
  {
    key: 'sideChoice',
    name: 'Which side?',
    prompt: 'Which side would you like?',
    isRequired: true,
    minChoices: 1,
    maxChoices: 1,
    options: [
      ['Chips', 0, null, { isDefault: true }],
      ['Side salad', 0, null, {}],
      ['Onion rings', 8, null, {}],
      ['Seasonal veg', 0, null, {}],
      ['Sweet potato fries', 12, null, {}],
    ],
  },
  {
    key: 'drinkChoice',
    name: 'Which drink?',
    prompt: 'Which drink would you like?',
    isRequired: true,
    minChoices: 1,
    maxChoices: 1,
    options: [
      ['Coca-Cola', 0, 'CAF0052', {}],
      ['Coke Zero', 0, 'CAF0053', {}],
      ['Fanta Orange', 0, 'CAF0054', {}],
      ['Sprite', 0, 'CAF0055', {}],
      ['Still water', 0, 'CAF0056', {}],
      ['Iced tea', 4, 'CAF0060', {}],
    ],
  },
  {
    key: 'coffeeSize',
    name: 'Which size coffee?',
    prompt: 'Which size?',
    isRequired: true,
    minChoices: 1,
    maxChoices: 1,
    options: [
      ['Small', 0, null, {}],
      ['Regular', 5, null, { isDefault: true }],
      ['Large', 10, null, {}],
    ],
  },

  /* ── Two-level: an answer that asks more questions ─────────────────────── */
  {
    key: 'makeItAMeal',
    name: 'Make it a meal?',
    prompt: 'Make it a meal?',
    isRequired: false,
    minChoices: 0,
    maxChoices: 1,
    options: [
      // One answer opening TWO further questions is the case 081 says a plain
      // reveals_group_id column could not express. This is that case, live.
      ['Yes — add a side and a drink', 45, null, { reveals: ['sideChoice', 'drinkChoice'] }],
      ['No thanks', 0, null, { isDefault: true }],
    ],
  },
  {
    key: 'addCoffee',
    name: 'Add a coffee?',
    prompt: 'Add a coffee to that?',
    isRequired: false,
    minChoices: 0,
    maxChoices: 1,
    options: [
      // Depth 3: breakfast → add a coffee → which size → which milk. That is
      // MAX_REVEAL_DEPTH exactly, so it also proves the cap allows its own
      // limit rather than stopping one short.
      ['Yes — add a coffee', 30, null, { reveals: ['coffeeSize', 'milk'] }],
      ['No thanks', 0, null, { isDefault: true }],
    ],
  },
  {
    key: 'kidsSide',
    name: 'Kids side',
    prompt: 'Which side for the little one?',
    isRequired: true,
    minChoices: 1,
    maxChoices: 1,
    options: [
      ['Chips', 0, null, { isDefault: true }],
      ['Carrot sticks', 0, null, {}],
      ['Cucumber sticks', 0, null, {}],
      ['Fruit', 0, null, {}],
    ],
  },
]

/* ── Which products ask what ───────────────────────────────────────────────
 *
 * Keyed by CAF code. The spread is deliberate: some dishes ask one question,
 * some ask four, so the till modal is exercised at both ends.
 */
const LINKS = {
  /* Breakfast — the heaviest, several with a reveal chain */
  CAF0091: ['eggs', 'bread', 'breakfastExtras', 'addCoffee'], // Full English
  CAF0092: ['eggs', 'bread', 'breakfastExtras'], // Vegetarian Breakfast
  CAF0093: ['bread', 'breakfastExtras'], // Eggs Benedict
  CAF0094: ['bread', 'breakfastExtras'], // Eggs Florentine
  CAF0095: ['bread', 'hold'], // Shakshuka
  CAF0096: ['bread', 'breakfastExtras'], // Avo on Sourdough
  CAF0097: ['bread', 'breakfastExtras'], // Avo & Feta on Rye
  CAF0098: ['eggs', 'bread'], // Scrambled Eggs on Toast
  CAF0099: ['breakfastExtras', 'hold'], // Omelette
  CAF0100: ['eggs', 'hold'], // Bacon & Egg Roll
  CAF0101: ['eggs', 'breakfastExtras', 'hold'], // Breakfast Wrap
  CAF0102: ['addCoffee'], // French Toast — single question
  CAF0103: ['addCoffee'], // Buttermilk Pancakes — single question
  CAF0107: ['addCoffee'], // Croissant & Jam — a pastry, so no egg question
  CAF0108: ['eggs', 'hold'], // Boerewors & Egg Roll

  /* Sandwiches & toasties */
  CAF0109: ['bread', 'sandwichExtras', 'hold'], // Chicken Mayo Sandwich
  CAF0110: ['bread', 'hold'], // Tuna Mayo Sandwich
  CAF0111: ['bread', 'toastLevel', 'sandwichExtras', 'hold'], // Ham & Cheese Toastie
  CAF0112: ['bread', 'toastLevel', 'sandwichExtras'], // Cheese & Tomato Toastie
  CAF0113: ['bread', 'toastLevel', 'sandwichExtras', 'hold'], // Chicken Mayo Toastie
  CAF0114: ['bread', 'toastLevel'], // Bacon Brie & Fig
  CAF0115: ['bread', 'sandwichExtras', 'hold', 'makeItAMeal'], // Club Sandwich
  CAF0116: ['bread', 'steakTemp', 'sandwichExtras'], // Steak Sandwich
  CAF0117: ['hold', 'sauces'], // Falafel Wrap
  CAF0118: ['hold', 'sauces'], // Chicken Caesar Wrap
  CAF0119: ['hold', 'sauces'], // Halloumi Wrap
  CAF0120: ['sandwichExtras', 'sauces'], // Pulled Pork Roll
  CAF0121: ['toastLevel', 'hold'], // Roast Veg Panini
  CAF0122: ['toastLevel', 'hold'], // Caprese Panini
  CAF0123: ['toastLevel', 'hold'], // Reuben

  /* Salads — mostly single, some none */
  CAF0124: ['hold'], // Greek Salad
  CAF0125: ['hold'], // Caesar Salad
  CAF0126: ['hold', 'sauces'], // Chicken Caesar Salad
  CAF0128: ['hold'], // Poke Bowl — Salmon
  CAF0129: ['hold'], // Poke Bowl — Chicken

  /* Burgers & mains — the meal reveal lives here */
  CAF0135: ['steakTemp', 'sandwichExtras', 'hold', 'makeItAMeal'], // Cafe Burger
  CAF0136: ['steakTemp', 'sandwichExtras', 'hold', 'makeItAMeal'], // Cheese Burger
  CAF0137: ['steakTemp', 'sandwichExtras', 'hold', 'makeItAMeal'], // Bacon & Cheese
  CAF0138: ['steakTemp', 'sandwichExtras', 'hold'], // Mushroom Swiss
  CAF0139: ['sandwichExtras', 'hold', 'makeItAMeal'], // Chicken Burger
  CAF0140: ['sandwichExtras', 'hold'], // Veggie Burger
  CAF0141: ['sandwichExtras', 'hold'], // Halloumi Burger
  CAF0142: ['sauces'], // Fish & Chips
  CAF0143: ['sauces', 'makeItAMeal'], // Chicken Schnitzel
  CAF0150: ['steakTemp', 'sauces', 'makeItAMeal'], // Steak & Chips
  CAF0152: ['kidsSide'], // Kids Chicken Strips
  CAF0153: ['kidsSide'], // Kids Burger
  CAF0154: ['kidsSide'], // Kids Pasta

  /* A few drinks, so the espresso bar has something too */
  CAF0017: ['milk', 'syrup'], // Cappuccino (Regular)
  CAF0020: ['milk', 'syrup'], // Latte (Regular)
  CAF0014: ['milk'], // Flat White (Regular)
  CAF0023: ['milk', 'syrup'], // Mocha (Regular)
  CAF0026: ['milk'], // Americano (Regular)
  CAF0035: ['milk'], // Hot Chocolate (Regular)
  CAF0063: ['milk', 'syrup'], // Iced Latte
}

/* ── Connect ───────────────────────────────────────────────────────────── */

const DB = {
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: decryptSecret(process.env.DB_PASSWORD),
}

const control = await mysql.createConnection({ ...DB, database: process.env.DB_NAME })

const [sites] = await control.query(
  `SELECT s.id, s.trading_name, d.database_name
     FROM cp2_sites s
     JOIN cp2_site_databases d ON d.site_id = s.id AND d.purpose = 'master'
    WHERE s.site_code LIKE 'ODY-CAFE-%' AND s.status = 'active' AND d.status = 'active'
    ORDER BY s.id`,
)
await control.end()

const targets = sites.filter((s) => !ONLY || ONLY.has(s.id))
if (!targets.length) {
  console.error('No matching cafe sites.')
  process.exit(1)
}

console.log(`${DROP ? 'Dropping from' : 'Seeding'} ${targets.length} cafe site(s)\n`)

let totalGroups = 0
let totalOptions = 0
let totalLinks = 0
let totalReveals = 0

for (const site of targets) {
  const db = await mysql.createConnection({ ...DB, database: site.database_name })
  const label = `  ${String(site.id).padEnd(3)} ${site.trading_name}`

  if (DROP) {
    const [res] = await db.query(
      `DELETE FROM instruction_groups WHERE name IN (${GROUPS.map(() => '?').join(',')})`,
      GROUPS.map((g) => g.name),
    )
    console.log(`${label} — removed ${res.affectedRows} group(s)`)
    await db.end()
    continue
  }

  // Product code → id, for this site's own copy of the product file.
  const [products] = await db.query(
    'SELECT id, code FROM products WHERE is_archived = 0',
  )
  const idByCode = new Map(products.map((p) => [p.code, p.id]))

  await db.beginTransaction()
  try {
    /* 1. Groups. Matched by name so a re-run updates rather than duplicates. */
    const groupIdByKey = new Map()
    for (const [i, g] of GROUPS.entries()) {
      const [[existing]] = await db.query(
        'SELECT id FROM instruction_groups WHERE name = ? LIMIT 1',
        [g.name],
      )
      if (existing) {
        await db.execute(
          `UPDATE instruction_groups
              SET prompt = ?, is_required = ?, min_choices = ?, max_choices = ?,
                  sort_order = ?, is_active = 1
            WHERE id = ?`,
          [g.prompt, g.isRequired ? 1 : 0, g.minChoices, g.maxChoices, i + 1, existing.id],
        )
        groupIdByKey.set(g.key, existing.id)
      } else {
        const [res] = await db.execute(
          `INSERT INTO instruction_groups
             (name, prompt, is_required, min_choices, max_choices, sort_order, is_active)
           VALUES (?,?,?,?,?,?,1)`,
          [g.name, g.prompt, g.isRequired ? 1 : 0, g.minChoices, g.maxChoices, i + 1],
        )
        groupIdByKey.set(g.key, res.insertId)
        totalGroups++
      }
    }

    /* 2. Options. Replaced wholesale, exactly as replaceOptions() does. */
    const optionIdByRef = new Map()
    for (const g of GROUPS) {
      const groupId = groupIdByKey.get(g.key)
      await db.execute('DELETE FROM instruction_options WHERE group_id = ?', [groupId])

      for (const [i, [name, price, code, extra]] of g.options.entries()) {
        const productId = code ? (idByCode.get(code) ?? null) : null
        if (code && productId === null) {
          console.warn(`${label} — no product ${code} for "${name}", left unlinked`)
        }
        const isDefault = extra.isDefault ? 1 : 0
        const [res] = await db.execute(
          `INSERT INTO instruction_options
             (group_id, name, price_adjust, product_id, quantity, is_default,
              max_qty, min_qty, default_qty, prints_on_kitchen, prints_on_receipt,
              sort_order, is_active)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1)`,
          [
            groupId,
            name,
            price.toFixed(4),
            productId,
            (1).toFixed(3),
            isDefault,
            extra.maxQty ?? 1,
            extra.minQty ?? 0,
            // A pre-ticked answer at a count of nothing is not a state anybody
            // means — resolved here the same way the app resolves it.
            isDefault ? Math.max(1, extra.defaultQty ?? 1) : (extra.defaultQty ?? 0),
            extra.printsOnKitchen === false ? 0 : 1,
            extra.printsOnReceipt === false ? 0 : 1,
            i,
          ],
        )
        optionIdByRef.set(`${g.key}:${name}`, res.insertId)
        totalOptions++
      }
    }

    /* 3. Reveals — the answers that go on to ask more questions. */
    for (const g of GROUPS) {
      for (const [name, , , extra] of g.options) {
        if (!extra.reveals?.length) continue
        const optionId = optionIdByRef.get(`${g.key}:${name}`)
        for (const [j, key] of extra.reveals.entries()) {
          await db.execute(
            `INSERT INTO instruction_option_reveals (option_id, group_id, sort_order)
             VALUES (?,?,?)`,
            [optionId, groupIdByKey.get(key), j],
          )
          totalReveals++
        }
      }
    }

    /* 4. Which products ask what. */
    let linked = 0
    const missing = []
    for (const [code, keys] of Object.entries(LINKS)) {
      const productId = idByCode.get(code)
      if (!productId) {
        missing.push(code)
        continue
      }
      await db.execute('DELETE FROM product_instruction_groups WHERE product_id = ?', [productId])
      for (const [i, key] of keys.entries()) {
        await db.execute(
          `INSERT INTO product_instruction_groups (product_id, group_id, sort_order)
           VALUES (?,?,?)`,
          [productId, groupIdByKey.get(key), i],
        )
        totalLinks++
      }
      linked++
    }

    await db.commit()
    console.log(
      `${label} — ${GROUPS.length} questions, ${linked} products` +
        (missing.length ? ` (${missing.length} code(s) not on this site: ${missing.join(', ')})` : ''),
    )
  } catch (err) {
    await db.rollback()
    console.error(`${label} — FAILED, rolled back: ${err.message}`)
    throw err
  } finally {
    await db.end()
  }
}

if (!DROP) {
  console.log(
    `\nCreated ${totalGroups} new group(s), ${totalOptions} options, ` +
      `${totalReveals} reveals, ${totalLinks} product links.`,
  )
}
