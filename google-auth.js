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
 *   does not attempt to persist or refresh a token across page loads;
 *   requestAccessToken() with prompt:'' below is a silent re-prompt within
 *   the same session, not a stored-refresh-token flow.
 *
 * Usage from the rest of the app (Mia's UI code):
 *   BookHubAuth.signIn(onSuccess, onError)
 *   BookHubAuth.getAccessToken()   // string or null
 *   BookHubAuth.isSignedIn()       // bool
 *   BookHubAuth.signOut()
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

  /**
   * Triggers the Google Sign-In popup/consent flow. On success, the access
   * token is cached in memory (not persisted) and onSuccess() is called.
   */
  function signIn(onSuccess, onError) {
    try {
      const client = ensureTokenClient();
      client.callback = (resp) => {
        if (resp.error) {
          onError && onError(resp);
          return;
        }
        accessToken = resp.access_token;
        // expires_in is in seconds; keep a small safety margin.
        tokenExpiresAt = Date.now() + (Number(resp.expires_in || 3600) - 60) * 1000;
        onSuccess && onSuccess(accessToken);
      };
      client.requestAccessToken({ prompt: accessToken ? "" : "consent" });
    } catch (e) {
      onError && onError(e);
    }
  }

  function isSignedIn() {
    return !!accessToken && Date.now() < tokenExpiresAt;
  }

  function getAccessToken() {
    return isSignedIn() ? accessToken : null;
  }

  function signOut() {
    if (accessToken && google.accounts && google.accounts.oauth2) {
      google.accounts.oauth2.revoke(accessToken, () => {});
    }
    accessToken = null;
    tokenExpiresAt = 0;
  }

  window.BookHubAuth = { signIn, signOut, isSignedIn, getAccessToken };
})();
