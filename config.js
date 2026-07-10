/*
 * config.js — Book Production Hub
 *
 * PUBLIC configuration only. Nothing in this file is a secret — it is
 * safe, by design, for this file to be committed to the public GitHub
 * Pages repo and visible to anyone who views source.
 *
 * GOOGLE_CLIENT_ID is an OAuth 2.0 "Web application" Client ID from Google
 * Cloud Console. Unlike a "Desktop app" client (the kind Marcus's PO
 * tracker automation scripts use, which pairs a client ID with a CLIENT
 * SECRET for server-side refresh-token flows), a Web application client ID
 * has no secret at all — it is meant to be public. Google enforces where
 * it can be used via "Authorized JavaScript origins" configured against
 * this Client ID in Cloud Console (locked to this GitHub Pages URL, not
 * "*"), not via a hidden credential in this repo.
 *
 * STATUS AS OF 2026-07-10: not yet created. See
 * MARCUS_BookProductionHubInfra_2026-07-10.md in Team Inbox for exact
 * steps to create it (Google Cloud Console access is required — Marcus's
 * tooling has no way to create a new OAuth client programmatically).
 * Placeholder below intentionally left empty so a missing/blank Client ID
 * fails loudly (google-auth.js checks for this) rather than silently.
 */
window.BOOK_HUB_CONFIG = {
  GOOGLE_CLIENT_ID: "", // <-- fill in once the Web application OAuth Client ID exists (see report)
  TITLES_SHEET_ID: "1hCCbT3TOKa7eb4EQ8WTaDoy7XQEu7J2zAeyNnSYqDMo", // "Book Production Titles" — created 2026-07-10
  PO_TRACKER_SHEET_ID: "171M_525EckIyREF1V-DcLxr_iTsO3DEV2loOGsY7uG4", // Printer_Quotes_Per_Title_Complete (existing, unmodified)
  BOOK_REVEAL_HELPER_URL: "http://127.0.0.1:8744", // local-only companion process, see book_reveal_helper.py
  // Minimal scope: read/write access only to Sheets the signed-in user
  // already has permission to. Deliberately NOT the broad 'drive' scope —
  // this app never needs to browse/list the user's whole Drive, only
  // read/write two specific Sheets it already knows the IDs of.
  GOOGLE_OAUTH_SCOPE: "https://www.googleapis.com/auth/spreadsheets",
};
