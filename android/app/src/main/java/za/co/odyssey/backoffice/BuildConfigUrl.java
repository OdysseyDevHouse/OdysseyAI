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

  static String serverUrl(Context context) {
    if (cached != null) return cached;

    try (InputStream in = context.getAssets().open("capacitor.config.json")) {
      byte[] buffer = new byte[in.available()];
      int read = in.read(buffer);
      if (read <= 0) return "";

      JSONObject config = new JSONObject(new String(buffer, StandardCharsets.UTF_8));
      JSONObject server = config.optJSONObject("server");
      cached = server == null ? "" : server.optString("url", "");
      return cached;
    } catch (Exception e) {
      /* Unreachable in a built app — the file is packaged by `cap sync` and the
         app cannot start without it. An empty string makes the failure loud at
         the first request rather than silently pointing somewhere else. */
      return "";
    }
  }
}
