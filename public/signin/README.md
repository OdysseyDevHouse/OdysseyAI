# Till sign-in backdrops

The photographs behind the PIN pad on the till's sign-in screen — the one screen
in the product a **customer** looks at rather than an operator. One per kind of
shop, picked from `cp2_sites.site_type_id`.

The mapping lives in `src/lib/site/posSignInArt.ts` (`STOCK_BY_SITE_TYPE`). It is
keyed on the site type's **id**, not its name, so renaming a type in the control
panel does not blank the picture on those tills.

## Ordering

1. The shop's own upload (Setup → Terminals → Till sign-in screen) — always wins.
2. The file below matching its site type.
3. `bottle-store.webp`, for a shop with no site type set, a type with no picture
   yet, or a type id that no longer exists.

A **missing file needs no handling**: `PosSignInArt` paints the brand gradient
under every backdrop, so a picture that fails to load leaves the screen looking
deliberate. That is what makes it safe for this folder to be incomplete.

A tint is applied over whatever loads — `.signin-scrim` in `src/app/globals.css`,
a fixed dark gradient that is heavier at the foot where the specials board sits.
Do not darken these files themselves; tune that one class.

## Files

Filenames are exact and lower-case. `.webp` only — the URL is built from the slug.

| Site type id | Type in the control panel | File                    | Present |
| ------------ | ------------------------- | ----------------------- | ------- |
| 1            | Bakery                    | `bakery.webp`           | yes     |
| 2            | Bar                       | `bar.webp`              | yes     |
| 3            | Beauty Salon              | `beauty-salon.webp`     | yes     |
| 4            | Biltong Deli              | `biltong-deli.webp`     | yes     |
| 5            | Bottle Store              | `bottle-store.webp`     | yes     |
| 6            | Boutique                  | `boutique.webp`         | yes     |
| 7            | Butchery                  | `butchery.webp`         | yes     |
| 8            | Clothing/Shoes            | `clothing-shoes.webp`   | yes     |
| 9            | Coffee Shop               | `coffee-shop.webp`      | yes     |
| 10           | Cosmetics                 | `cosmetics.webp`        | yes     |
| 11           | Cycling Shop              | `cycling-shop.webp`     | yes     |
| 12           | Electronics               | `electronics.webp`      | yes     |
| 13           | Fast Food Cafe            | `fast-food-cafe.webp`   | yes     |
| 14           | General Retailer          | `general-retailer.webp` | yes     |
| 15           | Golf Club/Shop            | `golf-club-shop.webp`   | yes     |

`bottle-store.webp` is the only one that is genuinely required — every failure
lands on it.

## Still to come

These types have no picture yet and fall back to the bottle store. Add the file,
then add its id to `STOCK_BY_SITE_TYPE`:

| Id | Type              | Suggested file           |
| -- | ----------------- | ------------------------ |
| 16 | Gun Shop          | `gun-shop.webp`          |
| 17 | Hardware Store    | `hardware-store.webp`    |
| 18 | Hotel / Lodge     | `hotel-lodge.webp`       |
| 19 | LifeStyle         | `lifestyle.webp`         |
| 20 | Office Automation | `office-automation.webp` |
| 21 | Restaurant        | `restaurant.webp`        |
| 22 | Service Station   | `service-station.webp`   |
| 23 | Supermarket       | `supermarket.webp`       |
| 24 | Tavern            | `tavern.webp`            |
| 25 | Venue             | `venue.webp`             |
| 26 | Wholesalers       | `wholesalers.webp`       |

## Shape and size

The panel is a **tall** frame beside the PIN pad — roughly portrait on a counter
display, and `object-cover`, so the left and right edges of a wide photograph are
cropped away. Keep the subject central and leave the top third quiet: the shop's
logo sits on a light disc in the middle, and the specials board covers the bottom
third.

These ship with every installation and are served by the till's own Next server,
so they work with the line down. Keep them compressed — a till paints this screen
every time a cashier signs out.
