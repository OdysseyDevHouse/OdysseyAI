package za.co.odyssey.backoffice;

import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.TextView;

import androidx.annotation.NonNull;
import androidx.appcompat.app.AppCompatActivity;
import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * The app's front door.
 *
 * ── WHAT HAPPENS HERE, AND IN WHICH ORDER ───────────────────────────────────
 *
 *   enrolled?  →  biometric unlock  →  exchange token  →  MainActivity
 *   not yet?   →  email + password  →  enrol           →  exchange  →  MainActivity
 *
 * Every step finishes before the WebView exists. That is the whole point: the
 * back office is only ever loaded by a browser that is already signed in, so
 * the person never meets a login form inside the app after the first run.
 *
 * ── WHY THE UNLOCK IS HERE AND NOT IN THE WEB LAYER ─────────────────────────
 *
 * If somebody picks up an unlocked phone, nothing should render until a face or
 * a fingerprint clears. A gate drawn in the WebView is a gate behind which the
 * content has already loaded.
 */
public class LoginActivity extends AppCompatActivity {

  private OdysseyAuth auth;
  private final ExecutorService work = Executors.newSingleThreadExecutor();
  private final Handler ui = new Handler(Looper.getMainLooper());

  private EditText email;
  private EditText password;
  private TextView error;
  private Button signIn;

  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);

    auth = new OdysseyAuth(this, BuildConfigUrl.serverUrl(this));

    if (auth.isEnrolled()) {
      /* No form at all for a returning device — straight to the unlock. The
         layout is not even inflated, so there is no flash of a login screen
         behind the biometric sheet. */
      unlockThenOpen();
      return;
    }

    setContentView(R.layout.activity_login);
    email = findViewById(R.id.email);
    password = findViewById(R.id.password);
    error = findViewById(R.id.error);
    signIn = findViewById(R.id.signIn);

    signIn.setOnClickListener(v -> attemptEnrol());
  }

  /* ── The returning device ─────────────────────────────────────────────── */

  private void unlockThenOpen() {
    BiometricManager manager = BiometricManager.from(this);
    /* DEVICE_CREDENTIAL alongside biometrics: a phone with no fingerprint
       enrolled still has a PIN, and refusing to open for somebody who has not
       set up a face is locking a person out of an app they are entitled to
       run. */
    int can = manager.canAuthenticate(
        BiometricManager.Authenticators.BIOMETRIC_WEAK
            | BiometricManager.Authenticators.DEVICE_CREDENTIAL);

    if (can != BiometricManager.BIOMETRIC_SUCCESS) {
      /* No lock screen on the device at all. Failing open, deliberately: the
         phone's owner has chosen not to secure it, and the app is not the place
         to overrule that. The server-side revoke remains the real protection
         for a lost handset. */
      exchangeThenOpen();
      return;
    }

    BiometricPrompt prompt = new BiometricPrompt(
        this,
        ContextCompat.getMainExecutor(this),
        new BiometricPrompt.AuthenticationCallback() {
          @Override
          public void onAuthenticationSucceeded(@NonNull BiometricPrompt.AuthenticationResult r) {
            exchangeThenOpen();
          }

          @Override
          public void onAuthenticationError(int code, @NonNull CharSequence message) {
            /* Cancelled, or too many failures. Not an error to report — the
               person chose not to open the app — so the app closes rather than
               sitting on a screen with nothing to do. */
            finish();
          }
        });

    prompt.authenticate(new BiometricPrompt.PromptInfo.Builder()
        .setTitle(getString(R.string.app_name))
        .setSubtitle(getString(R.string.login_subtitle))
        .setAllowedAuthenticators(
            BiometricManager.Authenticators.BIOMETRIC_WEAK
                | BiometricManager.Authenticators.DEVICE_CREDENTIAL)
        .build());
  }

  private void exchangeThenOpen() {
    work.execute(() -> {
      OdysseyAuth.Session session = auth.exchange();
      ui.post(() -> {
        if (session != null) {
          openApp();
          return;
        }

        /* Either the token was revoked (exchange cleared it) or the network is
           down (it did not). isEnrolled() answers which, and the two need
           different screens: a revoked device has to sign in again, while a
           phone in a lift must not be made to. */
        if (auth.isEnrolled()) {
          openApp();
        } else {
          showForm();
        }
      });
    });
  }

  /** Fall back to the form after a revoke, without restarting the activity. */
  private void showForm() {
    setContentView(R.layout.activity_login);
    email = findViewById(R.id.email);
    password = findViewById(R.id.password);
    error = findViewById(R.id.error);
    signIn = findViewById(R.id.signIn);
    signIn.setOnClickListener(v -> attemptEnrol());
  }

  /* ── First run ────────────────────────────────────────────────────────── */

  private void attemptEnrol() {
    String user = email.getText().toString().trim();
    String pass = password.getText().toString();

    if (user.isEmpty() || pass.isEmpty()) {
      showError(getString(R.string.login_need_both));
      return;
    }

    setBusy(true);
    showError(null);

    work.execute(() -> {
      try {
        auth.enrol(user, pass, deviceLabel());
        OdysseyAuth.Session session = auth.exchange();
        ui.post(() -> {
          setBusy(false);
          if (session != null) {
            openApp();
          } else {
            /* Enrolled but could not exchange — almost always the network
               dropping between two requests. The token is stored, so the next
               launch will not ask for a password again. */
            showError("Signed in, but could not reach the server. Try again.");
          }
        });
      } catch (OdysseyAuth.Failure failure) {
        ui.post(() -> {
          setBusy(false);
          showError(failure.getMessage());
        });
      }
    });
  }

  /**
   * Something the owner will recognise in the back office's revoke list.
   *
   * The device's marketing name where the OS offers it, falling back to the
   * model. Reading the user-set name needs a permission and one more prompt at
   * first run for a cosmetic gain; the "last used" line beside each entry is
   * what actually answers "which one did I lose".
   */
  private String deviceLabel() {
    String model = Build.MODEL == null ? "" : Build.MODEL.trim();
    String make = Build.MANUFACTURER == null ? "" : Build.MANUFACTURER.trim();

    if (model.isEmpty() && make.isEmpty()) return "Android device";
    if (make.isEmpty()) return model;
    /* Samsung reports MODEL as "SM-G991B" and MANUFACTURER as "samsung"; most
       others put the make in the model already, and "Google Google Pixel" reads
       as a bug. */
    if (model.toLowerCase().startsWith(make.toLowerCase())) return model;
    return make.substring(0, 1).toUpperCase() + make.substring(1) + " " + model;
  }

  private void openApp() {
    startActivity(new Intent(this, MainActivity.class));
    /* No animation and finish(): this activity must not be on the back stack,
       or the phone's back gesture from the dashboard lands on a login screen
       for a session that is already open. */
    overridePendingTransition(0, 0);
    finish();
  }

  private void setBusy(boolean busy) {
    signIn.setEnabled(!busy);
    signIn.setText(busy ? R.string.login_working : R.string.login_button);
    email.setEnabled(!busy);
    password.setEnabled(!busy);
  }

  private void showError(String message) {
    if (message == null || message.isEmpty()) {
      error.setVisibility(View.GONE);
      return;
    }
    error.setText(message);
    error.setVisibility(View.VISIBLE);
  }

  @Override
  protected void onDestroy() {
    work.shutdownNow();
    super.onDestroy();
  }
}
