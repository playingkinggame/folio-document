import { useEffect, useState } from "react";
import { getSupabaseClient, supabase } from "../auth.js";

function Icon({ name }) {
  const paths = {
    mail: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" /></>,
    lock: <><rect x="4" y="10" width="16" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></>,
    eye: <><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></>,
    eyeOff: <><path d="m3 3 18 18M10.6 10.6a2 2 0 0 0 2.8 2.8" /><path d="M9.9 5.2A10.8 10.8 0 0 1 12 5c6.5 0 10 7 10 7a16 16 0 0 1-3 3.8M6.2 6.2C3.5 8 2 12 2 12s3.5 7 10 7a10.5 10.5 0 0 0 4-.8" /></>,
    arrow: <><path d="M5 12h14" /><path d="m13 6 6 6-6 6" /></>,
  };

  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      {paths[name]}
    </svg>
  );
}

export default function Login({ onDone, initialMode = "login", onRecoveryComplete }) {
  const [mode, setMode] = useState(initialMode);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!supabase) return undefined;
    const { data } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY") {
        setMode("update");
        setPassword("");
        setError("");
        setNotice("Choose a new password for your account.");
      }
    });
    return () => data.subscription.unsubscribe();
  }, []);

  function switchMode(nextMode) {
    setMode(nextMode);
    setError("");
    setNotice("");
    setPassword("");
  }

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");

    try {
      const client = getSupabaseClient();
      if (mode === "login") {
        const { error: authError } = await client.auth.signInWithPassword({ email, password });
        if (authError) throw authError;
        await onDone();
      } else if (mode === "signup") {
        const { data, error: authError } = await client.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: window.location.origin },
        });
        if (authError) throw authError;
        if (data.session) await onDone();
        else setNotice("Check your email to confirm your account, then sign in.");
      } else if (mode === "reset") {
        const { error: authError } = await client.auth.resetPasswordForEmail(email, {
          redirectTo: window.location.origin,
        });
        if (authError) throw authError;
        setNotice("If an account exists for that address, you’ll receive a password reset link.");
      } else {
        const { error: authError } = await client.auth.updateUser({ password });
        if (authError) throw authError;
        onRecoveryComplete?.();
        switchMode("login");
        setNotice("Your password has been updated. Sign in to continue.");
      }
    } catch (err) {
      setError(err.message || "We couldn’t complete that request. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function signInWithGoogle() {
    setBusy(true);
    setError("");
    try {
      const { error: authError } = await getSupabaseClient().auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo: window.location.origin },
      });
      if (authError) throw authError;
    } catch (err) {
      setError(err.message || "Could not start Google sign-in. Please try again.");
      setBusy(false);
    }
  }

  const headings = {
    login: ["Welcome back", "Sign in to continue to Folio"],
    signup: ["Create your account", "Get started with your document library"],
    reset: ["Reset your password", "We’ll email you a secure reset link"],
    update: ["Choose a new password", "Make sure it’s strong and unique"],
  };
  const [title, subtitle] = headings[mode];
  const passwordMode = mode === "login" || mode === "signup" || mode === "update";

  return (
    <main className="login">
      <form className="login-card" onSubmit={submit}>
        <div className="login-brand" aria-label="Folio">
          <span>F</span>
        </div>
        <h1>{title}</h1>
        <p className="login-subtitle">{subtitle}</p>

        {mode !== "update" && (
          <div className="login-field">
            <label className="sr-only" htmlFor="login-email">Email address</label>
            <Icon name="mail" />
            <input
              id="login-email"
              type="email"
              autoComplete="email"
              placeholder="Email address"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
              autoFocus
            />
          </div>
        )}

        {passwordMode && (
          <div className="login-field">
            <label className="sr-only" htmlFor="login-password">Password</label>
            <Icon name="lock" />
            <input
              id="login-password"
              type={showPassword ? "text" : "password"}
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              placeholder={mode === "update" ? "New password" : "Password"}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              minLength={mode === "signup" || mode === "update" ? 8 : undefined}
              required
              autoFocus={mode === "update"}
            />
            <button
              className="login-password-toggle"
              type="button"
              aria-label={showPassword ? "Hide password" : "Show password"}
              onClick={() => setShowPassword((visible) => !visible)}
            >
              <Icon name={showPassword ? "eyeOff" : "eye"} />
            </button>
          </div>
        )}

        {mode === "login" && (
          <div className="login-options">
            <span>Secure sign-in</span>
            <button className="login-link" type="button" onClick={() => switchMode("reset")}>
              Forgot password?
            </button>
          </div>
        )}

        {error && <p className="login-message error" role="alert">{error}</p>}
        {notice && <p className="login-message success" role="status">{notice}</p>}

        <button className="login-submit" disabled={busy}>
          {busy ? "Please wait…" : mode === "login" ? "Sign in" : mode === "signup" ? "Create account" : mode === "reset" ? "Send reset link" : "Update password"}
          {!busy && mode === "login" && <Icon name="arrow" />}
        </button>

        {mode === "login" && (
          <>
            <div className="login-divider"><span>or</span></div>
            <button className="login-google" type="button" disabled={busy} onClick={signInWithGoogle}>
              <span aria-hidden="true">G</span>
              Continue with Google
            </button>
          </>
        )}

        <p className="login-switch">
          {mode === "login" ? (
            <>Don’t have an account?{" "}
              <button className="login-link strong" type="button" onClick={() => switchMode("signup")}>Sign up</button>
            </>
          ) : mode === "signup" || mode === "reset" ? (
            <>Already have an account?{" "}
              <button className="login-link strong" type="button" onClick={() => switchMode("login")}>Sign in</button>
            </>
          ) : mode === "update" ? null : (
            <>Remember your password?{" "}
              <button className="login-link strong" type="button" onClick={() => switchMode("login")}>Sign in</button>
            </>
          )}
        </p>
      </form>
    </main>
  );
}
