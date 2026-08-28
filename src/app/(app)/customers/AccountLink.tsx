import { Card, CardBody, CardHeader, Callout, CopyLink, TextLink } from '@/components/ui'

/**
 * The link that lets this customer see their own account.
 *
 * ── IT IS THE SAME URL FOR EVERY CUSTOMER, AND THAT IS THE POINT ──────────
 *
 * There is no per-customer address here. The link identifies the BUSINESS —
 * which shop's portal this is — and the customer proves who they are by asking
 * for a sign-in link at the address the shop already has on file. See
 * publicPortalToken.
 *
 * A per-customer URL was the obvious alternative and is worse in two ways: it
 * would be a bearer token in an email that gets forwarded, and possessing one
 * would confirm that its holder is a customer of this shop. This link tells a
 * stranger nothing they could not learn from the shop's own website, which is
 * why it is safe to print on an invoice or put in a footer.
 *
 * ── IT SITS BESIDE THE ONLINE-STORE PASSWORD, NOT INSIDE IT ───────────────
 *
 * Two different doors: the storefront takes an email and password so somebody
 * can order on account, and the portal sends a one-time link so somebody can
 * read their statement. Presenting them as one control would suggest setting up
 * the password is what makes the statement reachable, and it is not.
 */
export default function AccountLink({
  url,
  enabled,
  customerEmail,
}: {
  /** Null when SESSION_SECRET is missing — the token cannot be minted. */
  url: string | null
  /** Whether the shop has switched the account portal on at all. */
  enabled: boolean
  /** Whether we can actually reach this customer with a sign-in link. */
  customerEmail: string
}) {
  return (
    <Card>
      <CardHeader
        title="Account statement link"
        description="Lets this customer sign in and see their own details, transactions and statement."
      />
      <CardBody className="flex flex-col gap-3">
        {!enabled ? (
          <Callout tone="warning" title="The customer portal is switched off">
            Nobody can use this link until you turn it on under{' '}
            <TextLink href="/setup/customer-portal">Customer portal</TextLink>.
          </Callout>
        ) : !customerEmail.trim() ? (
          /* The one failure this design accepts, stated where it bites. A
             portal sign-in is a link mailed to the address on file, so a
             customer with no address on file cannot get in at all — and the
             useful moment to say so is while looking at their record. */
          <Callout tone="warning" title="This customer has no email address">
            They will not be able to sign in — a sign-in link is sent to the address on their
            record. Add one on the Details tab.
          </Callout>
        ) : null}

        {url ? (
          <>
            <CopyLink value={url} copiedMessage="Account link copied." />
            <p className="text-sm text-muted">
              Send this to the customer. They enter{' '}
              <span className="text-ink">{customerEmail || 'their email address'}</span> and we
              email them a link that signs them in — there is no password to hand over.
            </p>
          </>
        ) : (
          <Callout tone="danger" title="The link cannot be generated">
            This installation is missing its session secret. Please contact support.
          </Callout>
        )}
      </CardBody>
    </Card>
  )
}
