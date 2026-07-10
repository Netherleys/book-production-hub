# Book Production Hub

Publishing management app for Headpress / Oil On Water Press. Rebuild of the original [Headpress Hub](../../Headpress/HeadpressHub/headpress.html) onto a cross-device-accessible architecture — hosted on GitHub Pages, data backed by a Google Sheet, no local file/folder handle required, so it works from any device David is logged into.

## Security model (read this before changing auth code)

This repo is **public** (GitHub Pages requirement). It must never contain:
- An OAuth client secret
- A refresh token
- Any API key that isn't meant to be public

Sign-in uses [Google Identity Services](https://developers.google.com/identity/gsi/web) with a **public, Web-application-type OAuth Client ID** (see `config.js`) — this Client ID is *designed* to be public; it has no secret counterpart. Each user authenticates with their own Google account live in the browser. Access to the data lives entirely in **Google's own sharing permissions** on the two Sheets referenced in `config.js` — not in anything this repo controls. Revoking access = removing someone from the Sheet's share list, nothing more.

Contrast with `C:\Users\Administrator\PKA-Infra\google-sheets-tool\` — Marcus's existing PO tracker automation. That uses a stored refresh token + client secret (Windows Credential Manager, this PC only) for unattended server-side writes. That pattern is correct for local automation nobody else runs — it must **never** be ported into this repo.

## Files

| File | Purpose |
|---|---|
| `index.html` | Landing/scaffold page — confirms hosting is live and exercises the sign-in flow. Mia Chen's full UI (cards, accordion, pipeline strip, ISBN manager) replaces/extends this. |
| `config.js` | Public, non-secret config: OAuth Client ID (once created), target Sheet IDs, reveal-helper URL. Safe to commit. |
| `google-auth.js` | Client-side Google Sign-In module (`BookHubAuth.signIn/signOut/isSignedIn/getAccessToken`). |

## Local working-folder links

Per-title "working folder" links point at local paths (`D:\PROJECTS - BOOKS\Book_<Title>`) that only mean something on David's own PC. The app should offer a "Reveal working folder" action that calls `http://127.0.0.1:8744/reveal?path=...` (see `book_reveal_helper.py`, one level up, **not** part of this public repo — it's a local-only companion process, same pattern as Photo Gallery's `reveal_helper.py`). If that local helper isn't running, fall back to a native folder picker (same fallback pattern Mia's gallery uses).

## Status (2026-07-10)

- [x] Repo scaffold + auth module prepared locally
- [ ] Repo pushed to GitHub, Pages enabled — **blocked, no GitHub credentials in this environment**, see delivery report
- [ ] `GOOGLE_CLIENT_ID` in `config.js` filled in — **blocked, requires one-time Google Cloud Console step**, see delivery report
- [ ] UI build — Mia Chen, once the above two are live
