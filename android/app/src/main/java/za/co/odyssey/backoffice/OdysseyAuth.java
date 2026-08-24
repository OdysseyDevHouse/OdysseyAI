package za.co.odyssey.backoffice;

import android.content.Context;
import android.content.SharedPreferences;
import android.webkit.CookieManager;

import androidx.security.crypto.EncryptedSharedPreferences;
import androidx.security.crypto.MasterKey;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;

/**
 * How the app stays signed in.
 *
 *   first run   →  email + password  →  /api/mobile/auth/login   →  refresh token
 *   every run   →  refresh token     →  /api/mobile/auth/session →  session cookie
 *   sign out    →  refresh token     →  /api/mobile/auth/revoke
 *
 * ── WHY THIS IS NATIVE AND NOT THE TYPESCRIPT IT REPLACES ───────────────────
 *
 * The exchange has to finish BEFORE any web content loads, because the whole
 * design rests on the WebView never showing a login page. A JavaScript shell is
 * itself a loaded WebView, so it could only hide one login screen behind
 * another.
 *
 * There is a second, harder reason. A bundled Capacitor shell runs at its own
 * origin (https://localhost); the server is somewhere else entirely. A session
 * cookie set from a fetch there is a THIRD-PARTY cookie relative to the page
 * that asked for it — increasingly blocked on Android, blocked by default under
 * iOS ITP. The shell could authenticate perfectly and the WebView still not be
 * signed in. CookieManager writes to the jar directly and has no origin problem
 * at all.
 *
 * ── WHAT IS SHARED WITH iOS, AND WHAT IS NOT ────────────────────────────────
 *
 * The contract is shared: three endpoints, fixed field names, asserted by
 * `npm run test:mobile-auth-contract` so a rename fails on the machine of
 * whoever renamed it rather than in an app-store review queue.
 *
 * This file is not shared, and Swift will need its own copy. That is the right
 * seam — the rules that matter (who may sign in, lockout, 2FA, what a token
 * buys, when it is revoked) all live on the server and are shared already. What
 * is duplicated is an HTTP client, against a contract that has a test.
 */
public final class OdysseyAuth {

  /** Where the token lives. Not a plain preference — see prefs() below. */
  private static final String PREFS_NAME = "odyssey_secure";
  private static final String TOKEN_KEY = "refresh_token";

  private static final int CONNECT_TIMEOUT_MS = 15000;
  private static final int READ_TIMEOUT_MS = 20000;

  private final Context context;
  private final String baseUrl;

  public OdysseyAuth(Context context, String baseUrl) {
    this.context = context.getApplicationContext();
    /* Trailing slashes would produce "…//api/…", which some servers treat as a
       different path and others reject outright. */
    this.baseUrl = baseUrl != null && baseUrl.endsWith("/")
        ? baseUrl.substring(0, baseUrl.length() - 1)
        : baseUrl;
  }

  /** What an exchange produced, for the caller to show while it loads. */
  public static final class Session {
    public final String siteName;
    public final String userName;

    Session(String siteName, String userName) {
      this.siteName = siteName;
      this.userName = userName;
    }
  }

  /** Why an enrolment was refused, in words the person can act on. */
  public static final class Failure extends Exception {
    Failure(String message) {
      super(message);
    }
  }

  /**
   * The token store.
   *
   * EncryptedSharedPreferences, so the value is sealed with a key held in the
   * Android Keystore rather than sitting in plain XML that any rooted device or
   * ADB backup can read. This is the app's only long-lived credential: anyone
   * holding it is the user until the device row is revoked.
   *
   * Falls back to ordinary preferences if the keystore is unavailable — some
   * devices with a broken or reset keystore throw here, and refusing to run at
   * all would turn a phone that cannot encrypt into a phone that cannot work.
   * The token is still revocable server-side, which is the protection that
   * actually matters for a lost handset.
   */
  private SharedPreferences prefs() {
    try {
      MasterKey key = new MasterKey.Builder(context)
          .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
          .build();
      return EncryptedSharedPreferences.create(
          context,
          PREFS_NAME,
          key,
          EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
          EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM);
    } catch (Exception e) {
      return context.getSharedPreferences(PREFS_NAME + "_plain", Context.MODE_PRIVATE);
    }
  }

  public boolean isEnrolled() {
    String token = prefs().getString(TOKEN_KEY, null);
    return token != null && !token.isEmpty();
  }

  public void forget() {
    prefs().edit().remove(TOKEN_KEY).apply();
  }

  /**
   * The one time the app asks for a password.
   *
   * Throws Failure carrying the SERVER's own sentence. It already distinguishes
   * a locked account from a wrong password, and says plainly when 2FA or a
   * forced password change means this has to be done on the web — rewriting any
   * of that here would be a second, worse policy on what a stranger is told.
   */
  public void enrol(String email, String password, String label) throws Failure {
    JSONObject body = new JSONObject();
    try {
      body.put("email", email);
      body.put("password", password);
      body.put("platform", "android");
      body.put("label", label);
    } catch (Exception e) {
      throw new Failure("Could not prepare the sign-in request.");
    }

    Response res = post("/api/mobile/auth/login", body.toString(), null);

    if (res.failed()) {
      throw new Failure("Could not reach the server. Check your connection.");
    }
    if (res.status != 200) {
      throw new Failure(res.errorMessage("Could not sign in."));
    }

    String token = res.string("token");
    if (token == null || token.isEmpty()) {
      throw new Failure("The server did not return a sign-in token.");
    }

    prefs().edit().putString(TOKEN_KEY, token).apply();
  }

  /**
   * Trade the stored token for a live session cookie.
   *
   * Returns null when there is nothing stored or the token has been revoked —
   * both mean the same thing to the person holding the phone, so both send them
   * to the login screen.
   *
   * A REVOKED token clears itself here. Leaving it would spend a request every
   * launch proving the same thing, and would leave a working-looking credential
   * on a phone that may since have been sold.
   *
   * A network failure does NOT clear it: that is a phone in a lift, not a
   * revocation, and forgetting the token would make somebody type their
   * password again because they walked into a basement.
   */
  public Session exchange() {
    String token = prefs().getString(TOKEN_KEY, null);
    if (token == null || token.isEmpty()) return null;

    Response res = post("/api/mobile/auth/session", "{}", "Bearer " + token);

    if (res.failed()) return null;
    if (res.status == 401) {
      forget();
      return null;
    }
    if (res.status != 200) return null;

    /* The cookie is what actually authenticates the WebView. Written straight
       into its jar — no origin involved, which is the whole reason this is
       native. */
    if (!storeCookies(res.cookies)) return null;

    String siteName = "";
    String userName = "";
    try {
      JSONObject json = new JSONObject(res.body);
      siteName = json.optJSONObject("site") != null
          ? json.optJSONObject("site").optString("name", "")
          : "";
      userName = json.optJSONObject("user") != null
          ? json.optJSONObject("user").optString("name", "")
          : "";
    } catch (Exception ignored) {
      /* The names are for a subtitle. A session that works but cannot be
         labelled is still a working session. */
    }

    return new Session(siteName, userName);
  }

  /**
   * Sign out on this device.
   *
   * The server is told first, so the token dies even if the app is deleted a
   * second later — then the local copy goes regardless of what the server said.
   * A failed request must not leave somebody apparently signed in on a phone
   * they are handing to someone else.
   */
  public void signOut() {
    String token = prefs().getString(TOKEN_KEY, null);
    if (token != null && !token.isEmpty()) {
      post("/api/mobile/auth/revoke", "{}", "Bearer " + token);
    }
    forget();

    CookieManager cookies = CookieManager.getInstance();
    cookies.removeAllCookies(null);
    cookies.flush();
  }

  /**
   * Put the server's Set-Cookie headers into the WebView's jar.
   *
   * Returns whether a session cookie was actually among them: an exchange that
   * answered 200 but set nothing usable is a failure the caller must not treat
   * as success, or the WebView loads and meets a login page.
   */
  private boolean storeCookies(List<String> setCookieHeaders) {
    if (setCookieHeaders == null || setCookieHeaders.isEmpty()) return false;

    CookieManager manager = CookieManager.getInstance();
    manager.setAcceptCookie(true);

    boolean sawSession = false;
    for (String header : setCookieHeaders) {
      if (header == null) continue;
      manager.setCookie(baseUrl, header);
      /* An empty value is a DELETION, not a session — the server clears the
         cookie this way, and counting it would report success on a sign-out. */
      if (header.startsWith("odyssey_session=") && !header.startsWith("odyssey_session=;")) {
        sawSession = true;
      }
    }
    manager.flush();
    return sawSession;
  }

  /* ── The HTTP bit ───────────────────────────────────────────────────────── */

  private static final class Response {
    int status;
    String body = "";
    List<String> cookies;
    /** A transport failure, as distinct from a server that answered a refusal. */
    boolean transportError;

    boolean failed() {
      return transportError;
    }

    String string(String key) {
      try {
        return new JSONObject(body).optString(key, null);
      } catch (Exception e) {
        return null;
      }
    }

    /** The server's `error`, or the fallback when it did not send one. */
    String errorMessage(String fallback) {
      String message = string("error");
      return message == null || message.isEmpty() ? fallback : message;
    }
  }

  private Response post(String path, String json, String authorization) {
    Response result = new Response();
    HttpURLConnection connection = null;
    try {
      connection = (HttpURLConnection) new URL(baseUrl + path).openConnection();
      connection.setRequestMethod("POST");
      connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
      connection.setReadTimeout(READ_TIMEOUT_MS);
      connection.setDoOutput(true);
      connection.setRequestProperty("Content-Type", "application/json");
      /* So the server renders the phone's chrome from the very first page. The
         proxy turns this into a cookie, which is what keeps the layout right on
         navigations the PAGE starts — a WebView sends no custom headers there. */
      connection.setRequestProperty("x-odyssey-shell", "mobile");

      if (authorization != null) {
        connection.setRequestProperty("Authorization", authorization);
      }

      try (OutputStream out = connection.getOutputStream()) {
        out.write(json.getBytes(StandardCharsets.UTF_8));
      }

      result.status = connection.getResponseCode();

      /* getErrorStream for a 4xx: getInputStream throws there, and the body is
         exactly where the server put the sentence worth showing. */
      InputStream stream = result.status >= 400
          ? connection.getErrorStream()
          : connection.getInputStream();
      result.body = read(stream);

      Map<String, List<String>> headers = connection.getHeaderFields();
      if (headers != null) {
        for (Map.Entry<String, List<String>> entry : headers.entrySet()) {
          /* Header names are case-insensitive and servers disagree about the
             casing, so matching "Set-Cookie" exactly would work in testing and
             fail somewhere else. */
          if (entry.getKey() != null && "set-cookie".equalsIgnoreCase(entry.getKey())) {
            result.cookies = entry.getValue();
          }
        }
      }
    } catch (Exception e) {
      result.transportError = true;
    } finally {
      if (connection != null) connection.disconnect();
    }
    return result;
  }

  private String read(InputStream stream) {
    if (stream == null) return "";
    StringBuilder text = new StringBuilder();
    try (BufferedReader reader =
        new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8))) {
      String line;
      while ((line = reader.readLine()) != null) text.append(line);
    } catch (Exception ignored) {
      /* A partial body is still worth whatever was read. */
    }
    return text.toString();
  }
}
