/**
 * Department visibility and review moderation, against a live site database.
 *
 * Both decide what the PUBLIC sees, which is why they are tested together and
 * why the checks lean on the same question: can something reach the storefront
 * that nobody approved?
 *
 *   npm run test:online-content
 */
import { siteExecute, siteQuery, siteQueryOne } from '../src/lib/siteDb'
import {
  getPublishCounts,
  listDepartmentVisibility,
  setDepartmentVisibility,
} from '../src/lib/site/onlineStore'
import {
  approvedReviewsFor,
  deleteReview,
  listReviews,
  moderateReview,
  reopenReview,
  reviewCounts,
} from '../src/lib/site/productReviews'

const SITE = 1
const TAG = '__TEST_REVIEW__'

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

async function cleanup() {
  await siteExecute(SITE, `DELETE FROM product_reviews WHERE author_name = ?`, [TAG])
}

async function main() {
  await cleanup()

  /* ── Departments ──────────────────────────────────────────────────────── */
  console.log('\n— Department visibility —')
  const before = await listDepartmentVisibility(SITE)
  ok('the tree loads', before.length > 0, `${before.length} departments`)
  const originallyOn = before.filter((d) => d.showOnline).map((d) => d.id)

  const parent = before.find((d) => d.parentId === null && before.some((c) => c.parentId === d.id))
  if (parent) {
    const child = before.find((c) => c.parentId === parent.id)!

    // Establish the precondition rather than assuming it: the point of the
    // next three checks is that a ticked PARENT publishes an UNTICKED child,
    // so the child has to actually start unticked.
    await setDepartmentVisibility(SITE, child.id, false)
    await setDepartmentVisibility(SITE, parent.id, true)
    const ticked = await listDepartmentVisibility(SITE)
    const p = ticked.find((d) => d.id === parent.id)!
    const c = ticked.find((d) => d.id === child.id)!

    ok('ticking a parent sticks', p.showOnline)
    ok('the child is NOT ticked itself', !c.showOnline)
    // The whole point: a child of a ticked parent publishes anyway, and the
    // screen has to be able to say so rather than showing a misleading "off".
    ok('but the child publishes via its parent', c.publishedByParent)

    const counts = await getPublishCounts(SITE)
    const direct = await siteQueryOne<{ n: number }>(
      SITE,
      `SELECT COUNT(*) AS n FROM products p
        WHERE p.is_archived = 0 AND p.product_type IN ('normal','returnable')
          AND p.department_id = ?`,
      [parent.id],
    )
    ok(
      'the count includes products under the child',
      counts.departments > Number(direct?.n ?? 0),
      `${counts.departments} vs ${direct?.n} filed directly`,
    )

    await setDepartmentVisibility(SITE, parent.id, false)
    const cleared = await listDepartmentVisibility(SITE)
    ok(
      'unticking the parent unpublishes the child too',
      !cleared.find((d) => d.id === child.id)!.publishedByParent,
    )
  } else {
    console.log('SKIP  no parent department with children on this site')
  }

  ok('an unknown department is refused', !(await setDepartmentVisibility(SITE, 99_999_999, true)).ok)

  /* ── Reviews ──────────────────────────────────────────────────────────── */
  console.log('\n— Review moderation —')
  const product = await siteQueryOne<{ id: number }>(
    SITE,
    `SELECT id FROM products WHERE is_archived = 0 ORDER BY id LIMIT 1`,
  )
  if (!product) throw new Error('Need a product to review.')

  const seed = async (rating: number, body: string) =>
    (
      await siteExecute(
        SITE,
        `INSERT INTO product_reviews (product_id, rating, title, body, author_name, order_number)
         VALUES (?,?,?,?,?,?)`,
        [product.id, rating, 'Test review', body, TAG, 'ORD-123'],
      )
    ).insertId

  const first = await seed(5, 'Genuinely good.')
  const second = await seed(1, 'Spam, buy pills at example.com')

  const pending = await listReviews(SITE, 'pending')
  ok('new reviews land in the queue', pending.filter((r) => r.authorName === TAG).length === 2)
  ok(
    'they start as pending — nothing self-publishes',
    pending.filter((r) => r.authorName === TAG).every((r) => r.status === 'pending'),
  )

  // The storefront must not show a review nobody has looked at.
  const beforeApproval = await approvedReviewsFor(SITE, product.id)
  ok(
    'an unapproved review is NOT public',
    !beforeApproval.reviews.some((r) => r.authorName === TAG),
  )

  ok('a rejection needs a reason', !(await moderateReview(SITE, second, 'rejected', 'Tester')).ok)
  ok(
    'rejecting with a reason works',
    (await moderateReview(SITE, second, 'rejected', 'Tester', 'Spam — links to another shop')).ok,
  )
  ok('approving works', (await moderateReview(SITE, first, 'approved', 'Tester')).ok)

  const afterApproval = await approvedReviewsFor(SITE, product.id)
  ok(
    'the approved one is now public',
    afterApproval.reviews.some((r) => r.id === first),
  )
  ok(
    'the rejected one is still not',
    !afterApproval.reviews.some((r) => r.id === second),
  )
  ok('an average is reported', afterApproval.average > 0, String(afterApproval.average))

  const rejected = (await listReviews(SITE, 'rejected')).find((r) => r.id === second)
  ok('the rejection reason is kept', !!rejected?.declineReason)
  ok('who moderated it is kept', rejected?.moderatedBy === 'Tester')

  const counts = await reviewCounts(SITE)
  ok('counts are reported per status', counts.approved > 0 && counts.rejected > 0)

  ok('a moderated review can be reopened', (await reopenReview(SITE, first)).ok)
  const reopened = await approvedReviewsFor(SITE, product.id)
  ok(
    'reopening takes it off the storefront again',
    !reopened.reviews.some((r) => r.id === first),
  )

  ok('a review can be deleted', (await deleteReview(SITE, second)).ok)
  ok('deleting a missing review is refused', !(await deleteReview(SITE, second)).ok)

  console.log('\n— Cleanup —')
  await cleanup()
  const left = await siteQuery(SITE, `SELECT id FROM product_reviews WHERE author_name = ?`, [TAG])
  ok('test reviews removed', left.length === 0)

  // Departments go back exactly as they were.
  for (const d of await listDepartmentVisibility(SITE)) {
    const shouldBeOn = originallyOn.includes(d.id)
    if (d.showOnline !== shouldBeOn) await setDepartmentVisibility(SITE, d.id, shouldBeOn)
  }
  const restored = await listDepartmentVisibility(SITE)
  ok(
    'department flags restored',
    restored.filter((d) => d.showOnline).length === originallyOn.length,
  )

  console.log(`\n${fails === 0 ? 'All online content checks passed.' : `${fails} FAILED.`}`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch(async (error) => {
  console.error(error)
  await cleanup().catch(() => {})
  process.exit(1)
})
