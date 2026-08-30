package za.co.odyssey.backoffice;

import android.graphics.Color;
import android.os.Bundle;
import android.webkit.CookieManager;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;

/**
 * The app's one activity.
 *
 * Everything the person sees is the back office rendered in the WebView — except
 * for the one screen below, which exists because the WebView's own failure page
 * is the single most obvious way a wrapper gives itself away.
 */
public class MainActivity extends BridgeActivity {

  @Override
  public void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);

    /*
     * The canvas colour behind the page, so the moment before the first paint
     * is not a white flash on a dark app. Matches --color-canvas.
     */
    if (getBridge() != null && getBridge().getWebView() != null) {
      getBridge().getWebView().setBackgroundColor(Color.parseColor("#0b0f14"));
      getBridge().setWebViewClient(new OfflineAwareClient(this));
    }

    /*
     * Only the back-office build announces itself as a phone shell.
     *
     * A till build renders the touch till, which draws its own full-screen
     * chrome and reads no such signal — and the cookie would be a standing
     * instruction to strip the sidebar off any back-office page that did get
     * opened, quietly making the wrong product look deliberate.
     *
     * The start path is the discriminator because it is already in the
     * generated config and needs no second flag to drift out of step with it.
     */
    if (!isTillBuild()) {
      declareMobileShell();
    }
  }

  /**
   * Is this the counter-tablet build?
   *
   * `ODYSSEY_POS_ONLY=1` at sync time writes `server.appStartPath` into
   * capacitor.config.json, and the bridge appends it to the server URL — so
   * the app URL ending at the till's path IS the build flag, already carried
   * across the boundary. Reading it back beats a second BuildConfig field
   * that could disagree with the path the WebView actually opens.
   */
  private boolean isTillBuild() {
    try {
      String url = getBridge().getAppUrl();
      return url != null && url.endsWith("/pos");
    } catch (Exception ignored) {
      /* Fall back to the back-office behaviour: a till that gets the cookie
         is cosmetically wrong, while a crash here is a dead launcher. */
      return false;
    }
  }

  /**
   * Tell the server this is the app, not a browser.
   *
   * ── WHY A COOKIE AND NOT A HEADER ───────────────────────────────────────
   *
   * The header (x-odyssey-shell) is the honest signal and the shell's own fetch
   * sends it — but a WebView attaches custom headers ONLY to requests it makes
   * itself, never to navigations the PAGE starts. A tapped link, a redirect
   * after sign-in, a form post: all arrive bare. And WebResourceRequest headers
   * are read-only, so there is no interception hook that can add one either.
   *
   * The cookie is the half that survives navigation. The proxy already writes
   * it when it sees the header (src/proxy.ts), and this sets the same value up
   * front so the VERY FIRST page — before any fetch has run — is already the
   * phone's layout. Without it the app renders the desktop sidebar: 256px of
   * menu on a 390px screen, with the dashboard's widgets crushed beside it.
   *
   * Presentation only, and deliberately not a credential: it decides which
   * chrome is drawn and nothing else. Every capability check, module gate and
   * session check runs exactly as it does for a browser.
   */
  private void declareMobileShell() {
    try {
      String url = getBridge().getServerUrl();
      if (url == null || url.isEmpty()) return;

      CookieManager cookies = CookieManager.getInstance();
      cookies.setAcceptCookie(true);
      /* Third-party cookies too: the WebView treats the app's own origin as
         third-party in some configurations, and a session that silently fails
         to stick is the hardest kind of bug to see. */
      cookies.setAcceptThirdPartyCookies(getBridge().getWebView(), true);

      /* No Secure attribute: a dev build talks to a plain-HTTP LAN address and
         a Secure cookie would simply be dropped there. It carries nothing
         sensitive — the session cookie is a separate, httpOnly one the server
         sets itself. */
      cookies.setCookie(url, "odyssey_shell=mobile; Path=/; Max-Age=31536000; SameSite=Lax");
      cookies.flush();
    } catch (Exception ignored) {
      /* Worst case the app renders the desktop layout — wrong, but usable.
         Failing to launch over a presentation hint would be far worse. */
    }
  }

  /**
   * Replaces Chrome's error page with something that names the actual problem.
   *
   * ── WHY THIS IS WORTH NATIVE CODE ───────────────────────────────────────
   *
   * A build pointed at a host that does not resolve showed the stock Android
   * page: a broken-globe icon, "Webpage not available", and
   * net::ERR_NAME_NOT_RESOLVED in a system font that ignores the app's theme.
   * It is unreadable on a dark background, it says "webpage" in an app, and it
   * tells the person nothing they can act on.
   *
   * What replaces it is the same sentence a person could act on: which server
   * this build points at, and that it could not be reached. That is almost
   * always the true fault — a phone off the wifi, a dev server not running, or
   * a build pointed at the wrong host.
   */
  private static class OfflineAwareClient extends BridgeWebViewClient {
    private final MainActivity activity;

    OfflineAwareClient(MainActivity activity) {
      super(activity.getBridge());
      this.activity = activity;
    }

    @Override
    public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
      /*
       * MAIN FRAME ONLY. A failed image or a dropped analytics beacon also
       * lands here, and replacing a working screen because one asset 404'd
       * would be far worse than the error page this exists to hide.
       */
      if (request == null || !request.isForMainFrame()) {
        super.onReceivedError(view, request, error);
        return;
      }

      String host = "the server";
      try {
        host = request.getUrl().getHost();
      } catch (Exception ignored) {
        /* Keep the generic word rather than failing inside an error handler. */
      }

      view.loadDataWithBaseURL(null, page(host), "text/html", "utf-8", null);
    }

    /**
     * Deliberately inline and self-contained: it has to render when nothing can
     * be fetched, so it can reference no stylesheet, font or image. The colours
     * are the app's own tokens, copied rather than imported for that reason.
     */
    private String page(String host) {
      return "<!doctype html><html><head><meta name='viewport' content='width=device-width,initial-scale=1'>"
          + "<style>"
          + "html,body{margin:0;height:100%;background:#0b0f14;color:#e6edf3;"
          + "font-family:-apple-system,'Segoe UI',Roboto,sans-serif;-webkit-text-size-adjust:100%}"
          + ".w{display:flex;flex-direction:column;justify-content:center;height:100%;padding:32px;box-sizing:border-box}"
          + "h1{font-size:20px;font-weight:600;margin:0 0 12px}"
          + "p{font-size:15px;line-height:1.5;color:#8b98a5;margin:0 0 8px}"
          + "code{font-size:13px;color:#8b98a5;word-break:break-all}"
          + "button{margin-top:24px;padding:14px;font-size:16px;font-weight:500;"
          + "color:#fff;background:#2f6feb;border:0;border-radius:8px}"
          + "</style></head><body><div class='w'>"
          + "<h1>Can’t reach Odyssey</h1>"
          + "<p>The app could not connect to:</p>"
          + "<p><code>" + escape(host) + "</code></p>"
          + "<p>Check that you have a connection, then try again.</p>"
          + "<button onclick='location.reload()'>Try again</button>"
          + "</div></body></html>";
    }

    /** The host comes from a URL that may be anything; never interpolate it raw. */
    private String escape(String value) {
      return value
          .replace("&", "&amp;")
          .replace("<", "&lt;")
          .replace(">", "&gt;")
          .replace("\"", "&quot;");
    }
  }
}
