import Image from "next/image";
import { ShieldCheck } from "@/components/ui/icons";
import LoginForm from "./login/LoginForm";
import LocalLoginForm from "./login/LocalLoginForm";
import { localSiteId } from "@/lib/localSignIn";
import { wrongShellMessage } from "@/lib/siteOpensHere";
import styles from "./login.module.css";

/**
 * The products one Odyssey account can hold, in the order they are shown.
 *
 * ── WHY THE LOGIN SCREEN LISTS THEM AT ALL ──────────────────────────────────
 *
 * Because the screen asks somebody to sign in to a "workspace", and that word
 * means nothing until the modules are named. Most people arriving here bought a
 * till and have no idea the same account already opens the books, the loyalty
 * scheme and the online store — and the front door is the one screen where
 * saying so is an answer rather than an advert.
 *
 * ── ORDER, AND WHY IT IS NOT NAV_MODULES' ───────────────────────────────────
 *
 * This is a shop's ranking, not the menu's: what a business runs on, biggest
 * first. Sales leads because it is the till; Accounting sits third because
 * money in and money out is the pair, and everything after it is a module a
 * business adds to that rather than one it opens on day one.
 *
 * Deliberately NOT derived from `NAV_MODULES`. That list is the RAIL — six
 * chips, keyed to what a signed-in account has bought, and Accounting is not
 * one of them because it hangs under Back-office. Reading it here would put a
 * marketing panel at the mercy of a navigation decision, and drop Accounting
 * off a screen whose whole point is naming everything on sale.
 *
 * The codes are the same three letters the rail wore before it went to full
 * names — short enough to sit in a fixed badge beside a name of any length.
 */
const MODULES: readonly {
  code: string;
  name: string;
  note: string;
  lead?: boolean;
}[] = [
  { code: "SAL", name: "Sales", note: "Till, invoices, returns", lead: true },
  { code: "BO", name: "Back-office", note: "Stock, buying, reporting" },
  { code: "ACC", name: "Accounting", note: "Ledgers and books" },
  { code: "LOY", name: "Loyalty", note: "Points, tiers, rewards" },
  { code: "WEB", name: "Online Store", note: "Your e-store, in sync" },
  { code: "JOB", name: "Job Cards", note: "Repairs and services" },
  { code: "TIX", name: "Ticketing", note: "Events and admission" },
];

/**
 * The landing page and the real sign-in. Authenticates against cp2_users in the
 * control database; on success the session opens the user's default site.
 *
 * ── EXCEPT ON A SHOP'S OWN MACHINE ─────────────────────────────────────────
 *
 * A local Electron install has no control database to ask. Its staff were
 * created on the machine and exist nowhere else, so it signs in with a name and
 * a PIN against the shop's own `users` table — see lib/localSignIn.ts, and
 * docs/plans/database-setup-app.md for why the model settled that way.
 *
 * Decided on the SERVER, from whether this machine has been told which shop it
 * is. A client-side check would flash the wrong form on every load, and the
 * wrong form here is one whose credentials cannot work.
 *
 * ── THE TWO HALVES ─────────────────────────────────────────────────────────
 *
 * The card is a showcase panel and a form. On a phone the panel becomes a
 * banner above the form and its module board becomes a row scrolled with a
 * finger, so the fields stay above the fold — see login.module.css, which owns
 * every pixel of that. The screen is styled from that CSS module rather than
 * the UI kit: it is a pixel-port of the Odyssey POS front door and carries its
 * own brand blue. The other screens built on LoginScreen (/change-password,
 * /select-site) still use the design tokens.
 */
export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; kicked?: string; wrongsite?: string }>;
}) {
  const { next, kicked, wrongsite } = await searchParams;
  const local = await localSiteId();

  return (
    <div className={styles.wrapper}>
      <div className={styles.card}>
        {/* ── What the account opens ─────────────────────────────────────── */}
        <aside className={styles.panel}>
          <div className={styles.panelTop}>
            <div className={styles.panelBrand}>
              <span className={styles.panelMark}>
                <Image
                  src="/logo-icon.svg"
                  alt=""
                  width={40}
                  height={37}
                  className={styles.panelMarkImg}
                  priority
                  unoptimized
                />
              </span>
              <span className={styles.panelWordmark}>Odyssey</span>
            </div>

            <p className={styles.panelEyebrow}>
              One account &middot; every module
            </p>
            <h2 className={styles.panelHeadline}>
              Everything your business runs on, in one place.
            </h2>
            <p className={styles.panelBlurb}>
              Your till is one part of it. Sign in once and move between the
              modules your business uses.
            </p>
          </div>

          {/* A board on a desktop, a finger-scrolled row on a phone. One list
              either way — the layout is entirely the stylesheet's business. */}
          <ul className={styles.moduleStrip}>
            {MODULES.map((m) => (
              <li
                key={m.code}
                className={
                  m.lead
                    ? `${styles.moduleTile} ${styles.moduleLead}`
                    : styles.moduleTile
                }
              >
                <span className={styles.moduleCode}>{m.code}</span>
                <span className={styles.moduleText}>
                  <span className={styles.moduleName}>{m.name}</span>
                  <span className={styles.moduleNote}>{m.note}</span>
                </span>
              </li>
            ))}
          </ul>
        </aside>

        {/* ── Signing in ─────────────────────────────────────────────────── */}
        <div className={styles.formPane}>
          <div className={styles.brand}>
            <h1 className={styles.title}>Welcome back</h1>
            <p className={styles.subtitle}>
              {local
                ? "Sign in with your name and PIN"
                : "Sign in to your Odyssey workspace"}
            </p>
          </div>

          {/* WHY they are back here, when they did not ask to be.
              `requireSession` sets this after finding the session was superseded.
              Without it, being dropped at the login screen mid-task is
              indistinguishable from the app having broken — and the natural
              response to that is to sign in again, which would displace whoever
              legitimately holds the seat and start a loop. */}
          {kicked === "1" && (
            <div className={styles.notice} role="status">
              You were signed out because this account signed in on another
              device.
            </div>
          )}

          {/* A store that was open here and is not any more: requireSite() sets
              this when connection_type has been changed under a live session —
              migrated up to the cloud, or brought back down onto the shop's own
              hardware. Distinct from `kicked` on purpose: the remedy is the OTHER
              back office, not another attempt at this form. wrongShellMessage()
              says which one, from the build this is. */}
          {wrongsite === "1" && (
            <div className={styles.notice} role="status">
              {wrongShellMessage()}
            </div>
          )}

          {local ? <LocalLoginForm /> : <LoginForm next={next ?? ""} />}

          <div className={styles.secureNote}>
            <ShieldCheck size={15} strokeWidth={1.8} aria-hidden="true" />
            Secure and protected
          </div>

          <p className={styles.adminNote}>
            Need access to another module?{" "}
            <a className={styles.adminLink} href="/help.html">
              Ask your administrator
            </a>
          </p>
        </div>

        {/* Under the panel on a desktop, under the form on a phone. Its own
            grid cell so one DOM order can do both — see login.module.css. */}
        <div className={styles.panelFoot}>
          <span>&copy; {new Date().getFullYear()} Odyssey Software</span>
          <span aria-hidden="true" className={styles.footRule} />
          <a className={styles.footLink} href="/help.html">
            Support
          </a>
        </div>
      </div>
    </div>
  );
}
