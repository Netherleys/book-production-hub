/*
 * google-auth.js — Book Production Hub
 * Marcus Webb — Systems & Tools Administrator — 2026-07-10
 *
 * Client-side Google Sign-In using Google Identity Services (GIS), the
 * ONLY auth pattern approved for this app per the master brief's
 * non-negotiable: this repo/page is public (GitHub Pages), so it must
 * contain zero embedded secrets or credentials. There is no client
 * secret anywhere in this file, config.js, or anywhere else in this repo
 * — a Web application OAuth Client ID (see config.js) does not have one.
 *
 * Contrast with Marcus's existing PO tracker automation
 * (C:\Users\Administrator\PKA-Infra\google-sheets-tool\*.py), which uses a
 * stored refresh token + client secret in Windows Credential Manager for
 * unattended SERVER-SIDE writes on this machine only. That pattern is
 * fine for local automation scripts nobody else ever sees run — it must
 * NEVER be reused here. This app instead asks each user (David) to sign
 * in with his own Google account, live, in the browser, every session.
 * Access control is enforced entirely by Google's own sharing permissions
 * on the target Sheets (see config.js TITLES_SHEET_ID /
 * PO_TRACKER_SHEET_ID) — this app has no ability to grant itself access
 * to anything the signed-in user doesn't already have.
 *
 * Token handling:
 * - The access token GIS returns lives ONLY in the `accessToken` variable
 *   below (module-scope JS memory). It is never written to localStorage,
 *   sessionStorage, a cookie, or any file — it disappears the moment the
 *   tab is closed or reloaded, and the user simply signs in again.
 * - Tokens are short-lived (Google-issued, typically ~1 hour). This file
 *   does not attempt to persist a token across page loads — a reload always
 *   means signing in again. WITHIN a page load, though, the token IS kept
 *   fresh automatically (added 2026-08-11, see below) — the old version of
 *   this file only ever fetched a token once and let it silently expire
 *   ~59 minutes later, which is what caused David's repeated
 *   "Save failed: Not signed in / token expired" mid-session (see
 *   book_production_hub_save_failed_token_expired_2026-08-11 incident).
 *
 * 2026-08-11 fix (Marcus Webb) — token expiry incident:
 * - A background keep-alive timer (`scheduleKeepAlive`) silently calls
 *   requestAccessToken({prompt:''}) — GIS's silent, no-popup re-auth path —
 *   a few minutes before the current token would expire, for as long as the
 *   tab stays open and signed in. In the common case this means the token
 *   never actually reaches expiry during a normal working session; David
 *   should not see this at all.
 * - `ensureFreshToken()` is a just-in-time backstop for the rest of the app
 *   to call before every Sheets API request: if the cached token still has
 *   a safe margin left, it resolves immediately (no network call, no
 *   latency); if not (e.g. the keep-alive timer got throttled because the
 *   tab was backgrounded — browsers deprioritise setTimeout/setInterval in
 *   inactive tabs), it does the same silent refresh on demand before the
 *   request goes out.
 * - `reconnect()` is for the rare case silent refresh itself fails (e.g.
 *   the underlying Google browser session also expired/was signed out) —
 *   it tries the silent path once, then reports back to the caller so the
 *   app can prompt for an interactive re-sign-in WITHOUT reloading the page
 *   (a reload would discard any unsaved edits still sitting in memory).
 * Silent refresh keeps the exact same in-memory-only, no-secret model as
 * before — nothing new is persisted anywhere.
 *
 * Usage from the rest of the app (Mia's UI code):
 *   BookHubAuth.signIn(onSuccess, onError)
 *   BookHubAuth.getAccessToken()   // string or null
 *   BookHubAuth.isSignedIn()       // bool
 *   BookHubAuth.signOut()
 *   BookHubAuth.ensureFreshToken() // Promise<string> — resolves with a token
 *                                  // that has a safe margin left, refreshing
 *                                  // silently first if needed; rejects if
 *                                  // that's not possible without an
 *                                  // interactive prompt.
 *   BookHubAuth.reconnect(onSuccess, onError) // explicit silent-then-report
 *                                  // reconnect, for a UI "Reconnect" action.
 *
 * Requires <script src="https://accounts.google.com/gsi/client" async defer></script>
 * and config.js to be loaded before this file — see index.html.
 */
(function () {
  "use strict";

  const cfg = window.BOOK_HUB_CONFIG || {};
  let tokenClient = null;
  let accessToken = null;
  let tokenExpiresAt = 0;
  let keepAliveTimer = null;
  // How long before actual expiry we consider the token "stale" and worth
  // refreshing. Two different uses: SAFE_MARGIN_MS gates the fast-path in
  // ensureFreshToken() (below this, still treated as fresh, no network
  // call); the keep-alive timer below aims to refresh well before that so
  // the fast path is what normally fires.
  const SAFE_MARGIN_MS = 2 * 60 * 1000; // 2 min

  function ready() {
    return typeof google !== "undefined" && google.accounts && google.accounts.oauth2;
  }

  function ensureTokenClient() {
    if (!cfg.GOOGLE_CLIENT_ID) {
      throw new Error(
        "BOOK_HUB_CONFIG.GOOGLE_CLIENT_ID is empty. A Web application OAuth " +
        "Client ID must be created in Google Cloud Console and pasted into " +
        "config.js before sign-in will work — see the delivery report for " +
        "exact steps. (This is expected to be blank until that one-time " +
        "manual step is done; it is not a bug in this file.)"
      );
    }
    if (!ready()) {
      throw new Error("Google Identity Services script has not loaded yet.");
    }
    if (!tokenClient) {
      tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: cfg.GOOGLE_CLIENT_ID,
        scope: cfg.GOOGLE_OAUTH_SCOPE || "https://www.googleapis.com/auth/spreadsheets",
        callback: "", // overridden per-call in signIn()
      });
    }
    return tokenClient;
  }

  function onTokenResponse(resp, onSuccess, onError) {
    if (resp.error) {
      onError && onError(resp);
      return;
    }
    accessToken = resp.access_token;
    // expires_in is in seconds; keep a small safety margin.
    tokenExpiresAt = Date.now() + (Number(resp.expires_in || 3600) - 60) * 1000;
    scheduleKeepAlive();
    onSuccess && onSuccess(accessToken);
  }

  /**
   * Triggers the Google Sign-In popup/consent flow. On success, the access
   * token is cached in memory (not persisted) and onSuccess() is called.
   */
  function signIn(onSuccess, onError) {
    try {
      const client = ensureTokenClient();
      client.callback = (resp) => onTokenResponse(resp, onSuccess, onError);
      client.requestAccessToken({ prompt: accessToken ? "" : "consent" });
    } catch (e) {
      onError && onError(e);
    }
  }

  /**
   * Silent, no-popup re-auth using GIS's prompt:'' path. Works only while
   * the user still has an active, permitted Google browser session — which
   * is the normal case for as long as the tab stays open. Does NOT fall
   * back to an interactive prompt; callers decide what to do if this fails
   * (see ensureFreshToken/reconnect below).
   */
  function silentRefresh(onSuccess, onError) {
    try {
      const client = ensureTokenClient();
      client.callback = (resp) => onTokenResponse(resp, onSuccess, onError);
      client.requestAccessToken({ prompt: "" });
    } catch (e) {
      onError && onError(e);
    }
  }

  // Re-arms itself after every successful token fetch (see onTokenResponse)
  // so it keeps firing for as long as the tab/session stays alive. Aims to
  // refresh a few minutes before SAFE_MARGIN_MS would otherwise force
  // ensureFreshToken() to do it synchronously on the critical path of a
  // save. Browsers throttle timers in backgrounded tabs, so this is a
  // best-effort layer, not the only one — ensureFreshToken() below is the
  // just-in-time backstop that makes correctness not depend on this timer
  // actually firing on schedule.
  function scheduleKeepAlive() {
    if (keepAliveTimer) clearTimeout(keepAliveTimer);
    if (!tokenExpiresAt) return;
    const fireIn = Math.max(30 * 1000, tokenExpiresAt - Date.now() - SAFE_MARGIN_MS - 3 * 60 * 1000);
    keepAliveTimer = setTimeout(() => {
      if (!accessToken) return; // signed out since scheduling
      silentRefresh(
        () => {}, // success already updates state + reschedules via onTokenResponse
        () => { /* silent refresh failed in the background — leave state as-is; ensureFreshToken()/reconnect() will surface it when something actually needs the token */ }
      );
    }, fireIn);
  }

  function isSignedIn() {
    return !!accessToken && Date.now() < tokenExpiresAt;
  }

  function getAccessToken() {
    return isSignedIn() ? accessToken : null;
  }

  /**
   * Promise-based just-in-time token guarantee for callers about to make an
   * API request. Fast path (no network) if the current token still has
   * SAFE_MARGIN_MS left; otherwise attempts one silent refresh before
   * resolving. Rejects (does not fall back to an interactive popup) if a
   * silent refresh isn't possible — callers should treat rejection as
   * "needs reconnect()/interactive sign-in", not as a hard failure to
   * report as data loss, since nothing unsaved is lost by waiting.
   */
  function ensureFreshToken() {
    return new Promise((resolve, reject) => {
      if (accessToken && Date.now() < tokenExpiresAt - SAFE_MARGIN_MS) {
        resolve(accessToken);
        return;
      }
      if (!tokenClient) {
        reject(new Error("Not signed in yet."));
        return;
      }
      silentRefresh(
        (tok) => resolve(tok),
        (err) => reject(err instanceof Error ? err : new Error((err && err.message) || "Silent token refresh failed — interactive sign-in required."))
      );
    });
  }

  /**
   * Explicit reconnect for UI use (e.g. the reconnect banner's button).
   * Tries the silent path first — if the underlying Google session is
   * still alive this succeeds with zero extra clicks. onError is only
   * called if silent refresh genuinely fails, at which point the caller
   * should show the interactive "Sign in with Google" overlay.
   */
  function reconnect(onSuccess, onError) {
    if (!tokenClient) {
      // Never signed in this session at all (e.g. GIS script race) — go
      // straight to interactive.
      onError && onError(new Error("No active session — interactive sign-in required."));
      return;
    }
    silentRefresh(onSuccess, onError);
  }

  function signOut() {
    if (keepAliveTimer) { clearTimeout(keepAliveTimer); keepAliveTimer = null; }
    if (accessToken && google.accounts && google.accounts.oauth2) {
      google.accounts.oauth2.revoke(accessToken, () => {});
    }
    accessToken = null;
    tokenExpiresAt = 0;
  }

  window.BookHubAuth = { signIn, signOut, isSignedIn, getAccessToken, ensureFreshToken, reconnect };
})();
