# Mediagram

Browse, search and tag the media in your Telegram chats — a macOS app built
with TanStack Router + TanStack Query, running in Tauri.

Telegram runs entirely in the window (mtcute over MTProto). The only local
state is a SQLite file holding tags and per-chat read markers:
`~/Library/Application Support/com.mediagram.app/mediagram.db`.

## Setup

```sh
cp .env.example .env   # fill in VITE_TELEGRAM_API_ID / VITE_TELEGRAM_API_HASH
bun install
```

Requires Rust (`rustup`) and Xcode command line tools.

## Run

```sh
bun run tauri:dev     # the app, with Vite HMR on http://localhost:3000
bun run tauri:build   # src-tauri/target/release/bundle/macos/Mediagram.app (+ .dmg)
```

`bun run dev` alone serves the UI in a browser, but tags won't load there:
SQLite is reached through `@tauri-apps/plugin-sql`, which only exists in Tauri.

## Layout

- `src/routes/` — `/` (sign in), `/chats`, `/c/$chatId` (media grid), `/tags`
- `src/lib/media-tags.ts`, `src/lib/source-visits.ts` — the SQLite data layer
- `src-tauri/src/lib.rs` — schema migrations; release builds serve `dist/` on
  `http://localhost:14327` so the `/progressive/*` video service worker can
  register (never change that port: the Telegram session is keyed to it)

## Checks

```sh
bun run typecheck
bun run test      # node --test over src/**/*.test.ts
bun run check     # biome
```
