# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

IsiHunter is a Chrome Extension (Manifest V3) for Instagram lead prospecting with AI qualification. It collects Instagram profiles via the Instagram internal private API (not DOM scraping), qualifies them using OpenAI gpt-4o, generates two personalized DM messages per approved profile (icebreaker + hook), and optionally sends leads to an external CRM via webhook.

## How to load/test the extension

There is no build step. Load directly in Chrome:

1. Open `chrome://extensions`
2. Enable "Developer mode"
3. Click "Load unpacked" → select this directory
4. After any code change: click the refresh icon on the extension card
5. **Cache busting**: after changing `popup.js`, increment the `?v=N` suffix on the script tag in `popup.html` — Chrome caches ES Modules aggressively

## Architecture

### Message flow

All coordination goes through `chrome.runtime.sendMessage`. The three execution contexts communicate like this:

```
popup.js  ──sendToBg()──►  background.js  ──sendToContent()──►  content.js
                                │                                     │
                                │◄────── PROFILE_DATA ────────────────┘
                                │◄────── COLLECTION_ERROR ────────────┘
                         (processes with OpenAI, saves to storage)
popup.js  ◄── broadcast() ── background.js  (PROGRESS, WEBHOOK_SENT, etc.)
```

- `background.js` is an ES Module service worker. It orchestrates everything: receives `PROFILE_DATA` from the content script, calls OpenAI (qualify → icebreaker + hook in parallel → comment), persists to storage, and broadcasts status updates to the popup.
- `content.js` runs in the Instagram tab. It calls the Instagram internal API (`/api/v1/tags/`, `/api/v1/users/web_profile_info/`, `/api/v1/feed/user/`) with `credentials: include` and the `X-IG-App-ID` header. It also handles DM sending and comment posting via DOM interaction.
- `popup.js` is pure UI. It sends commands to the background and listens for `PROGRESS` broadcasts to update the log/stats.

### Storage schema (`db.js`)

All state lives in `chrome.storage.local`. Keys:

| Key | Type | Purpose |
|-----|------|---------|
| `isi_settings` | object | All user config (ICP, product, OpenAI key, webhook, delays, prompts) |
| `isi_profiles` | array | Approved profiles with generated messages |
| `isi_stats` | object | `{ active, processed, approved }` |
| `isi_log` | array | Last 100 log entries (no `message` field — reconstructed in UI) |
| `isi_blacklist` | object | `{ username: true }` — approved profiles, never re-processed |
| `isi_graylist` | object | `{ username: expiry_timestamp }` — rejected, ignored for 30 days |
| `isi_history` | array | All analyzed profiles (approved + rejected), max 500 |

### OpenAI calls per approved profile (`openai.js`)

1. `qualifyProfile()` — JSON mode, returns `{ pontuacao, aprovado, justificativa, nicho }`
2. `generateIcebreaker()` + `generateHook()` — run in **parallel** via `Promise.all`
3. `generateComment()` — sequential after the above

### Key implementation details

- **Service worker keep-alive**: alarm fires every 24s (`keepAlive`) to prevent Chrome from killing the SW between profile batches.
- **SW reliability**: `sendToBackground()` in `content.js` has a 120s timeout + one automatic retry on SW restart. All Instagram `fetch()` calls use `fetchWithTimeout()` (15s) with `AbortController`.
- **Anti-detection delays**: configurable per-profile delay (random between min/max seconds) and group pause every N profiles. Both reloaded from storage each iteration.
- **Log entries**: `appendLog` in `background.js` stores `{ action, username, pontuacao, ... }` — no `message` field. `addLogEntry()` in `popup.js` reconstructs the human-readable message from those fields when loading from storage.
- **ES Module cache**: `popup.html` loads popup.js with `?v=N`. Increment N after every change to `popup.js` to force Chrome to re-fetch.

### Webhook payload (`webhook.js`)

Sends to a Supabase Edge Function. Key field mappings:
- `origin` → always `'mineração'`
- `niche` → `profile.nicho_detectado` (detected by AI, not the seller's product)
- `icebreaker_message` / `hook_message` → the two generated DM messages
- `temperature` → derived from `pontuacao_icp`: ≥9=quente, ≥7=morno, else frio

### Settings object shape

```js
{
  icp, produto, instrucaoAbordagem, hashtags,
  pontuacaoMinima,    // 0–10, default 7
  metaPerfis,         // max approved profiles per session, default 20
  openaiKey,
  promptIcebreaker,   // optional custom prompt, blank = use built-in
  promptHook,         // optional custom prompt, blank = use built-in
  webhookEndpoint, webhookApiKey, webhookFunnel, webhookStage, webhookTags, webhookAuto,
  delayMinPerfil, delayMaxPerfil,   // seconds between profiles
  pausaMinGrupo, pausaMaxGrupo,     // seconds for group pause
  tamanhoGrupo,                     // profiles per group before long pause
}
```
