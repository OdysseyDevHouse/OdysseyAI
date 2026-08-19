/**
 * The shop's menu, and the fallback that keeps a shop working until it makes one.
 *
 * ── WHAT THIS IS GUARDING ────────────────────────────────────────────────
 *
 * One distinction carries the whole feature: a shop that has NEVER made a menu
 * must keep the generated rail, and a shop that made one and then emptied it
 * must get the empty menu it asked for. Reading those two the same way is
 * exactly how a feature launch blanks somebody's navigation — and it would look
 * fine in every test that only checked "does a saved menu render".
 *
 *   npm run test:storefront-menus
 */
import {
  hasMenu,
  menuLinks,
  resolveMenu,
  saveMenu,
  type ResolvedMenuItem,
} from '../src/lib/site/storefrontMenus'
import {
  MAX_MENU_CHILDREN,
  MAX_MENU_ITEMS,
  MENU_TARGETS,
  menuHref,
  safeMenuSlug,
  safeMenuTarget,
} from '../src/lib/storefront/menus'
import { siteExecute, siteQuery } from '../src/lib/siteDb'

const SITE = 1
const BASE = '/store/TESTTOKEN'

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

/** What the shop draws when it has no menu of its own. */
const generated = async (): Promise<ResolvedMenuItem[]> => [
  { label: 'Generated', href: `${BASE}/c/1`, imageId: null, children: [] },
]

async function main() {
  /*
   * This suite writes to a live site's navigation, so whatever was there is
   * restored at the end — a menu left behind would silently replace a shop's
   * rail for the next person to look at it.
   */
  const before = await resolveMenu(SITE, 'main')

  console.log('\n— A shop that has never made one —')
  {
    await siteExecute(SITE, `DELETE FROM storefront_menus WHERE slug = 'main'`)
    ok('resolves to null, not an empty list', (await resolveMenu(SITE, 'main')) === null)
    ok('and has no menu', !(await hasMenu(SITE, 'main')))

    const links = await menuLinks(SITE, 'main', BASE, generated)
    ok('so the shop keeps its generated rail', links.length === 1 && links[0].label === 'Generated')
  }

  console.log('\n— A shop that made one and emptied it —')
  {
    await saveMenu(SITE, 'main', [])
    /*
     * The opposite answer from the same-looking state. An owner who removed
     * every item meant it, and falling back here would put links they deleted
     * back on their shop.
     */
    ok('resolves to an empty list, not null', JSON.stringify(await resolveMenu(SITE, 'main')) === '[]')
    ok('and the shop shows nothing', (await menuLinks(SITE, 'main', BASE, generated)).length === 0)
    ok('but it does have a menu', await hasMenu(SITE, 'main'))
  }

  console.log('\n— What a shop can point at —')
  {
    const [dept] = await siteQuery<{ id: number }>(
      SITE,
      `SELECT id FROM departments ORDER BY id LIMIT 1`,
    )
    await saveMenu(SITE, 'main', [
      { label: 'Front', targetKind: 'home', targetId: null, targetUrl: '', imageId: null },
      { label: 'Aisle', targetKind: 'department', targetId: dept?.id ?? 1, targetUrl: '', imageId: null },
      { label: 'Saved', targetKind: 'wishlist', targetId: null, targetUrl: '', imageId: null },
      { label: 'Outside', targetKind: 'url', targetId: null, targetUrl: 'https://example.com/x', imageId: null },
    ])
    const links = await menuLinks(SITE, 'main', BASE, generated)
    ok('every kind resolves to a link', links.length === 4, String(links.length))
    ok('the front page is the base itself', links[0]?.href === BASE, links[0]?.href)
    ok('a department carries its id', links[1]?.href === `${BASE}/c/${dept?.id ?? 1}`, links[1]?.href)
    ok('an outside link is kept whole', links[3]?.href === 'https://example.com/x', links[3]?.href)
  }

  console.log('\n— Nothing broken reaches a masthead —')
  {
    await saveMenu(SITE, 'main', [
      { label: 'Fine', targetKind: 'home', targetId: null, targetUrl: '', imageId: null },
      // A label nobody can click.
      { label: '   ', targetKind: 'home', targetId: null, targetUrl: '', imageId: null },
      // A department that was deleted, or never chosen.
      { label: 'Gone', targetKind: 'department', targetId: null, targetUrl: '', imageId: null },
      // Stored XSS, on every page of a shop that takes payments.
      { label: 'Nasty', targetKind: 'url', targetId: null, targetUrl: 'javascript:alert(1)', imageId: null },
      // A blank address is not a link either.
      { label: 'Blank', targetKind: 'url', targetId: null, targetUrl: '', imageId: null },
    ])
    const links = await menuLinks(SITE, 'main', BASE, generated)
    ok('only the usable one draws', links.length === 1 && links[0].label === 'Fine', String(links.length))

    // And the hostile one did not even reach the column.
    const rows = await siteQuery<{ target_url: string }>(
      SITE,
      `SELECT i.target_url FROM storefront_menu_items i
         JOIN storefront_menus m ON m.id = i.menu_id
        WHERE m.slug = 'main' AND i.label = 'Nasty'`,
    )
    ok('a javascript: link is not even stored', (rows[0]?.target_url ?? '') === '', rows[0]?.target_url)
  }

  console.log('\n— One level of nesting, and no more —')
  {
    await saveMenu(SITE, 'main', [
      {
        label: 'Parent',
        targetKind: 'home',
        targetId: null,
        targetUrl: '',
        imageId: null,
        children: [
          { label: 'Child', targetKind: 'home', targetId: null, targetUrl: '', imageId: null },
          // A grandchild in the input. The write path does not recurse, so this
          // cannot become a third level however the payload is shaped.
          {
            label: 'Also a child',
            targetKind: 'home',
            targetId: null,
            targetUrl: '',
            imageId: null,
            children: [{ label: 'Grandchild', targetKind: 'home', targetId: null, targetUrl: '', imageId: null }],
          } as never,
        ],
      },
    ])
    const stored = await resolveMenu(SITE, 'main')
    ok('the parent keeps its children', stored?.[0]?.children.length === 2, String(stored?.[0]?.children.length))
    ok(
      'and no child has children of its own',
      (stored?.[0]?.children ?? []).every((c) => c.children.length === 0),
    )

    // A cycle here would be an infinite render, so depth is structural.
    const depths = await siteQuery<{ n: number }>(
      SITE,
      `SELECT COUNT(*) AS n FROM storefront_menu_items child
         JOIN storefront_menu_items parent ON parent.id = child.parent_id
        WHERE parent.parent_id IS NOT NULL`,
    )
    ok('nothing in the table is two levels deep', Number(depths[0]?.n) === 0, String(depths[0]?.n))
  }

  console.log('\n— Caps and coercion —')
  {
    const many = Array.from({ length: MAX_MENU_ITEMS + 10 }, (_, i) => ({
      label: `Item ${i}`,
      targetKind: 'home',
      targetId: null,
      targetUrl: '',
      imageId: null,
    }))
    await saveMenu(SITE, 'main', many)
    const stored = await resolveMenu(SITE, 'main')
    ok('the item cap holds', (stored?.length ?? 0) === MAX_MENU_ITEMS, String(stored?.length))

    ok('an unknown target kind reads as a url', safeMenuTarget('teleport') === 'url')
    ok('every declared kind survives its own check', MENU_TARGETS.every((t) => safeMenuTarget(t) === t))
    ok('an unknown menu slug reads as main', safeMenuSlug('sidebar') === 'main')

    // menuHref answers null rather than a plausible href: an item that cannot
    // resolve must not be DRAWN, and '#' would put a dead link in a masthead.
    ok(
      'an id-less department has no href',
      menuHref({ targetKind: 'department', targetId: null, targetUrl: '' }, BASE) === null,
    )
    ok(
      'a page is resolved by the caller, not here',
      menuHref({ targetKind: 'page', targetId: 3, targetUrl: '' }, BASE) === null,
    )
    ok('the child cap is declared', MAX_MENU_CHILDREN > 0 && MAX_MENU_CHILDREN <= MAX_MENU_ITEMS)
  }

  console.log('\n— Cleanup —')
  {
    await siteExecute(SITE, `DELETE FROM storefront_menus WHERE slug = 'main'`)
    if (before !== null) {
      await saveMenu(
        SITE,
        'main',
        before.map((i) => ({
          label: i.label,
          targetKind: i.targetKind,
          targetId: i.targetId,
          targetUrl: i.targetUrl,
          imageId: i.imageId,
          children: i.children.map((c) => ({
            label: c.label,
            targetKind: c.targetKind,
            targetId: c.targetId,
            targetUrl: c.targetUrl,
            imageId: c.imageId,
          })),
        })),
      )
    }
    const after = await resolveMenu(SITE, 'main')
    ok(
      'the shop is left as it was found',
      (before === null) === (after === null) && (before?.length ?? 0) === (after?.length ?? 0),
    )
  }

  console.log(fails ? `\n${fails} FAILED.` : '\nAll menu checks passed.')
  process.exit(fails ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
