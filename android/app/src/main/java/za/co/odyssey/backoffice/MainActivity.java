package za.co.odyssey.backoffice;

import android.graphics.Color;
import android.os.Bundle;
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
