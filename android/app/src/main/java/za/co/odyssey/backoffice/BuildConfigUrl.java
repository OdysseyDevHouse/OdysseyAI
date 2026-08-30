package za.co.odyssey.backoffice;

import android.content.Context;

import org.json.JSONObject;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;

/**
 * Where this build talks to.
 *
 * ── ONE SOURCE, READ TWICE ──────────────────────────────────────────────────
 *
 * The URL is set once, in `capacitor.config.ts`, from ODYSSEY_APP_URL at build
 * time. `npx cap sync` copies it into assets/capacitor.config.json, which is
 * what the WebView loads from.
 *
 * The login screen needs the same address BEFORE the WebView exists — there is
 * no bridge to ask yet — so it reads that same file rather than carrying a
 * second copy of the value. A build pointed at a dev server would otherwise
 * enrol against dev and then load production, which is the kind of mismatch
 * that produces a "signed in but everything is empty" bug report.
 */
final class BuildConfigUrl {

  private BuildConfigUrl() {}

  private static String cached;

  /**
   * Which store a till build opens, or 0 for "let the server choose".
   *
   * Zero rather than -1 because the server treats any non-positive id as
   * absent, and the two callers here have nothing to say about the difference
   * between "unset" and "unreadable" — both mean the same thing to a shell
   * that must still launch.
   */
  static int siteId(Context context) {
    JSONObject server = serverConfig(context);
    return server == null ? 0 : server.optInt("odysseySiteId", 0);
  }

  static String serverUrl(Context context) {
    if (cached != null) return cached;

    JSONObject server = serverConfig(context);
    cached = server == null ? "" : server.optString("url", "");
    return cached;
  }

  /** The `server` object, or null when the file cannot be read. */
  private static JSONObject serverConfig(Context context) {
    try (InputStream in = context.getAssets().open("capacitor.config.json")) {
      byte[] buffer = new byte[in.available()];
      int read = in.read(buffer);
      if (read <= 0) return null;

      JSONObject config = new JSONObject(new String(buffer, StandardCharsets.UTF_8));
      return config.optJSONObject("server");
    } catch (Exception e) {
      /* Unreachable in a built app — the file is packaged by `cap sync` and the
         app cannot start without it. Null leaves `serverUrl` returning the
         empty string, which makes the failure loud at the first request rather
         than silently pointing somewhere else. */
      return null;
    }
  }
}
