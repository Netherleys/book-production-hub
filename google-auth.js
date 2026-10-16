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
        callback: dispatchToken,       // Round 84: one fixed callback, see waiters below
        error_callback: dispatchError, // popup closed / blocked: fail now, not hang
      });
    }
    return tokenClient;
  }

  /*
   * Round 84 (2026-10-16, Mia Chen) — token race fix.
   * GIS has ONE token client with ONE callback. Before this, every signIn()/silentRefresh()
   * overwrote client.callback, so when two token requests overlapped (two Sheet calls needing a
   * refresh at once, or a stuck background refresh and then David signing in on the overlay)
   * the earlier caller never heard back, timed out after 8s and reported "signed out / token
   * expired" AFTER a successful sign-in (once per caller, so the error could show twice).
   * Now every caller waits in `waiters`; any token response answers all of them, and a silent
   * refresh already in flight is joined rather than started again.
   */
  let waiters = [];       // {ok, fail, timer}
  let silentInFlight = false;
  function settleAll(fn) {
    const list = waiters; waiters = []; silentInFlight = false;
    list.forEach((w) => { if (w.timer) clearTimeout(w.timer); try { fn(w); } catch (e) {} });
  }
  /*
   * Round 85 (2026-10-16, Mia Chen) — "popup_closed" grace period.
   * GIS decides the popup was closed by polling the popup window. A popup that closes itself
   * (a quick already-consented sign-in, or a silent refresh) can be seen as "closed" a moment
   * BEFORE its token message is handled, so error_callback(popup_closed) fires and the token
   * then arrives anyway. R84 reported popup_closed at once, which failed every waiter, showed
   * "Sign-in failed" and left the overlay up even though a token came in.
   * Now: popup_closed waits CLOSED_GRACE_MS for a token; a token in that window answers
   * everyone as success and no error is shown. If none comes, the waiters fail with a calm
   * message. If a token still turns up later (up to LATE_OK_MS), the last interactive sign-in
   * is completed anyway (its success handler hides the overlay and the message).
   * popup_failed_to_open (blocked) and other errors still report straight away.
   */
  const CLOSED_GRACE_MS = 3000;
  const LATE_OK_MS = 60 * 1000;
  let closedGraceTimer = null;
  let lateOk = null, lateOkUntil = 0;
  function clearClosedGrace() { if (closedGraceTimer) { clearTimeout(closedGraceTimer); closedGraceTimer = null; } }
  function dispatchToken(resp) {
    clearClosedGrace();
    if (resp && resp.error) { lateOk = null; settleAll((w) => w.fail(resp)); return; }
    accessToken = resp.access_token;
    // expires_in is in seconds; keep a small safety margin.
    tokenExpiresAt = Date.now() + (Number(resp.expires_in || 3600) - 60) * 1000;
    scheduleKeepAlive();
    if (!waiters.length && lateOk && Date.now() < lateOkUntil) {
      const ok = lateOk; lateOk = null;
      try { ok(accessToken); } catch (e) {}
      return;
    }
    lateOk = null;
    settleAll((w) => w.ok(accessToken));
  }
  function dispatchError(err) {
    const type = (err && err.type) || "unknown";
    const e = new Error(type === "popup_closed" ? "The Google sign-in window closed before sign-in finished. Nothing is lost: click Sign in with Google to try again. (popup_closed)"
      : type === "popup_failed_to_open" ? "Chrome blocked the Google sign-in window (popup_failed_to_open). Allow pop-ups for this site and try again."
      : "Google sign-in error (" + type + ").");
    e.type = type;
    if (type === "popup_closed") {
      if (closedGraceTimer) return; // already waiting
      closedGraceTimer = setTimeout(() => {
        closedGraceTimer = null;
        settleAll((w) => {
          if (w.interactive) { lateOk = w.ok; lateOkUntil = Date.now() + LATE_OK_MS; }
          w.fail(e);
        });
      }, CLOSED_GRACE_MS);
      return;
    }
    clearClosedGrace();
    settleAll((w) => w.fail(e));
  }
  function addWaiter(onSuccess, onError, timeoutMs) {
    const w = { ok: (t) => onSuccess && onSuccess(t), fail: (e) => onError && onError(e), timer: null, interactive: !timeoutMs };
    if (timeoutMs) {
      w.timer = setTimeout(() => {
        waiters = waiters.filter((x) => x !== w);
        if (!waiters.length) silentInFlight = false;
        w.fail(new Error("Silent token refresh timed out after " + (timeoutMs / 1000) +
          "s — Google never responded (likely a suppressed silent popup). Interactive sign-in required."));
      }, timeoutMs);
    }
    waiters.push(w);
  }


  /**
   * Triggers the Google Sign-In popup/consent flow. On success, the access
   * token is cached in memory (not persisted) and onSuccess() is called.
   */
  function signIn(onSuccess, onError) {
    try {
      const client = ensureTokenClient();
      lateOk = null; // Round 85: a new click replaces any earlier late-token hand-off
      addWaiter(onSuccess, onError, 0); // interactive: no timeout (David may take a while)
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
   *
   * 2026-08-16 fix (Marcus Webb) — "Matching Print Est." / "Matching
   * POs/INV" stuck-on-Loading incident:
   * requestAccessToken({prompt:''}) has a documented Google Identity
   * Services limitation — if the silent flow is blocked (popup suppressed,
   * or the request wasn't triggered by a direct user gesture, which is
   * exactly what scheduleKeepAlive()'s setTimeout-driven background call
   * is) the library can fail to invoke EITHER callback at all. No error,
   * no success — nothing (see google/google-api-javascript-client#816).
   * Before this fix, that left ensureFreshToken()'s Promise permanently
   * unsettled, which hung authHeaders() -> sheetsGet() -> withAuthRetry()
   * forever with no rejection ever reaching the calling code's try/catch —
   * so loadPrintEstimatesFor()/loadPoInvoiceTrackerFor() in app.js never
   * got a chance to replace their "Loading…" placeholder with either real
   * data or the (already well-built) error message. Every OTHER Sheets
   * read in the app fetches once immediately after the initial, real,
   * user-clicked "consent" popup (which reliably fires a callback either
   * way) — the PO Tracker panels are the only calls that can still be
   * mid-flight when a LATER silent refresh is needed, which is why only
   * they were ever seen stuck.
   * Fix: a hard timeout races the callback. If neither fires in time, we
   * synthesize a rejection so callers (ensureFreshToken/reconnect) always
   * settle — turning a silent infinite hang into the ordinary, already-
   * handled "auth expired, needs reconnect" failure path.
   */
  function silentRefresh(onSuccess, onError) {
    try {
      const client = ensureTokenClient();
      const SILENT_TIMEOUT_MS = 8000;
      addWaiter(onSuccess, onError, SILENT_TIMEOUT_MS);
      // Round 84: join a silent refresh that is already on its way instead of starting another.
      if (silentInFlight) return;
      silentInFlight = true;
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
    // Round 84: a token that is still fresh (e.g. David just signed in) needs no refresh.
    if (accessToken && Date.now() < tokenExpiresAt - SAFE_MARGIN_MS) { onSuccess && onSuccess(accessToken); return; }
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
