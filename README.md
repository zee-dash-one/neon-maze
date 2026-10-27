# Neon Maze

Original web arcade built with TypeScript, Vite, and Canvas 2D. Arrow-shaped player, crystal enemies (Trace, Veil, Flux, and Drift), neon palette, and synthesized audio. No game engine, external fonts, third-party images, or downloads during play.

## Run locally

Requirements: **Node.js 24** and **pnpm 11.19.0**. The lockfile is committed.

```sh
npm install -g pnpm@11.19.0
pnpm install --frozen-lockfile
pnpm dev
```

Open `http://127.0.0.1:5173`. In `pnpm dev`, accounts use an **in-browser SQLite** database and a **mock Google login** (Alice / Bob / Carol) by default — no Supabase project required. Guest play still works without any backend. To hit a real Supabase project from localhost, set `VITE_BACKEND=supabase` in `.env` (copy from `.env.example`) and fill the public Supabase variables. Restart the dev server after changing the file.

```sh
pnpm check                 # TypeScript + Vitest (includes 1,200 seeds and PostgreSQL)
pnpm build                 # dist/ + manifest + service worker
pnpm preview               # production build at http://127.0.0.1:4173
pnpm exec playwright install chromium
pnpm test:browser          # uses existing build; includes reload with network offline
```

On the Codex Windows environment, if pnpm shims are missing, use `node node_modules/typescript/bin/tsc --noEmit`, `node node_modules/vitest/vitest.mjs run`, and `node node_modules/vite/bin/vite.js build`.

## How to play

- Arrow keys or WASD; an early turn is buffered until a valid intersection. Keys are remappable in Settings, with two bindings per direction and conflict detection. P/Escape pause.
- Default Gamepad API controls: D-pad or left stick, Start to pause; deadzone 0.35. Enable and status in Settings. Press a gamepad button so the browser can expose the device.
- Touch uses a relative joystick built with `@use-gesture/vanilla`: press anywhere on the canvas to place its center, keep holding, and drag toward the desired direction. Release and press elsewhere to reposition it. The board footer also has a pause button.
- Focus mode expands the cabinet to the full viewport. Desktop players can enter or leave it from the board footer; touch devices enter automatically when a run starts. In focus mode, achievement and synchronization notices become compact, translucent text in the top-right corner so they do not cover the maze.
- No fixed life limit: each death deducts 10, 20, 40, 80, 160… points. The penalty doubles for the entire run, including across screens. Balance never goes negative; Game Over when a death leaves balance at zero. A new run resets balance, deaths, and screens cleared.
- The HUD shows balance, current screen, screens cleared, deaths, peak balance, next penalty, and speed multiplier. Local high score and leaderboard use the **highest balance reached in the run**, because final balance is zero. They do not use gross points collected.
- Pellets: 10 points; power pellets: 50; consecutive ghost captures: 200, 400, 800, 1,600. Fruit at 70 and 170 items collected: `min(100 × stage, 1,000)`, available for 12 seconds.
- Feedback: achievements play a synthesized victory fanfare and appear in an animated corner popup at the exact qualifying game event; later server confirmation does not repeat the celebration. A successful server flush plays its own synthesized chime and shows a confirmation notice. Energy, fruit, and ghost captures show their `+value` floating above the player; small 10-point sparks stay visually quiet.
- Linear speed: `1 + (screen - 1) / 99`. Screen 1 runs at 1× and screen 100 at exactly 2×, roughly +1.01% of base speed per screen, without compound interest. Player and ghosts (including frightened and eyes) share the same multiplier. There is no final screen or configured speed cap.
- Power mode lasts 14 seconds; an echo returning home can re-enter frightened during that same orb, allowing the Phantom achievement tiers up to eight captures. Chase/scatter intervals stay the same. Adaptive substeps keep turns, collection, and collisions correct at high speed.
- Losing focus or hiding the tab pauses the run. Submitted time is active simulation time only—no pause, intros, or death screen.

## Architecture

| File | Responsibility |
| --- | --- |
| `src/game/maze.ts` | Symmetric 28×31 generator, flood fill, and validation |
| `src/game/engine.ts` | DOM-independent simulation, fixed 1/60 s step |
| `src/game/pathfinding.ts` | BFS and targets for the four personalities |
| `src/game/renderer.ts` | Canvas, original geometry, and wall cache |
| `src/services/controls.ts` | Keyboard, Gamepad API, and relative touch joystick |
| `src/services/audio.ts` | Web Audio, envelopes, and siren |
| `src/services/storage.ts` | Settings, local high score, and in-memory fallback |
| `src/services/network.ts` | Google Auth, profile, leaderboard, and per-user queue |
| `src/services/backend/` | Auth/data adapters: Supabase (prod) and SQLite + mock Google (dev) |
| `src/achievements/catalog.ts` | Localized achievement names and original SVG badge geometry |
| `src/achievements/config.json` | Editable achievement thresholds used by the local/dev tracker and SQLite backend |
| `src/i18n/en.ts` | Centralized English UI strings |
| `supabase/migrations/001_neon_maze.sql` | Tables, indexes, RLS, and RPCs |
| `supabase/migrations/002_endless_runs.sql` | Endless screens migration and speed-adjusted duration validation |
| `supabase/migrations/003_achievements.sql` | 18 achievements, event RPC, exclusive ownership, RLS, and daily leader function |
| `supabase/migrations/004_king_cron.sql` | Production Supabase Cron job for daily ranking snapshots |
| `supabase/migrations/005_reset_and_achievement_thresholds.sql` | Wipe game data + reseed catalog + thresholds from `config.json` |
| `wrangler.jsonc` | Cloudflare assets + empty `previews` block for `wrangler preview` |
| `.github/workflows/deploy.yml` | Tests, build, and Cloudflare Workers deploy (`wrangler deploy`) |
| `.github/workflows/supabase-keepalive.yml` | Scheduled database read (every 3 days) |

### Maze generation

The algorithm starts with small wall islands and single-tile corridors, including frequent passages through the center. It picks blockages on the left half with a deterministic PRNG and mirrors each change immediately, so boundaries also apply to walls crossing the central axis. Two tunnel rows enable horizontal wrap and four openings. Only ghosts leaving the house or returning as eyes use the central gallery.

New rules, also applied to the house and doors (inaccessible to the player):

- Every interior wall block touches at least one path on one of its four sides. Diagonals do not count.
- Each connected component of interior walls has at most **8 tiles total**, counting corners and branches—not just straight segments.
- Every path tile has at least two exits, including tunnel wrap. Single-tile dead ends are not allowed.
- The path graph cannot contain bridges: removing one edge must not isolate a region. This also rejects full loops connected to the map by a single passage, even when every tile individually has two exits.
- Still required: connectivity, no 2×2 blocks of **player-accessible paths**, symmetry, two tunnels, all pickups reachable, and four power pellets far from the house, one per quadrant.

The outer frame is the only exception to wall limits, preserving a closed outline and two tunnels. That does not exempt interior walls near the border. House and doors count as walls for player rules, though authorized ghosts may cross them. If final validation fails, the generator tries another seed up to 64 times. Stages use `initialSeed + (stage - 1) × 7919`.

The 1,200-seed test performs its own tile checks, wall components, full pickup coverage, closed boundaries, doors, and variety. Regression cases reproduce the red, blue, and yellow issues from the reference image. Simulation tests cover penalties, peak balance, restart, screens cleared, doubled speed at screen 100, advancing past 999, and high-speed collisions.

Achievement targets are kept in `src/achievements/config.json`. Change values such as `cleared`, `peak`, `tunnels`, `captures`, `gameOvers`, or `penaltyGreaterThan` while tuning a development build; the immediate client feedback and the local SQLite backend read the same file. The Supabase RPC remains the production authority and must be updated in `supabase/migrations/003_achievements.sql` before publishing a changed threshold to the online leaderboard.

### Offline and data

The `vite-plugin-pwa` service worker precaches HTML, JS, CSS, icons, and the manifest. **The first visit must be online** until “READY TO PLAY OFFLINE” appears. Then the installed app or a previously visited URL can reopen offline. Dev mode does not install a service worker; validate offline with a production build. Updates wait for tabs to close so runs are not interrupted. Auth and database responses are not cached.

### Local development backend (SQLite + mock Google)

`pnpm dev` selects the local adapters by default (`src/services/backend/`):

- **Mock Google Auth** — “Sign in with Google” opens Alice / Bob / Carol. Session is stored in `localStorage`; no OAuth redirect.
- **SQLite in the browser** (`sql.js`) — profiles, scores, ranking, and achievement RPCs run in TypeScript against an in-memory SQLite schema persisted to IndexedDB. Business rules mirror the Supabase migrations (plausibility checks, exclusive titles, Phantom/Circuit awards). The daily King snapshot runs opportunistically when ranking/profile is read.

Force adapters with `VITE_BACKEND=local` or `VITE_BACKEND=supabase` in `.env`. Production builds use Supabase when the public URL/key are configured.

To wipe the local SQLite database and mock Google caches (with `pnpm dev` running):

```sh
pnpm reset:local-db
```

In the browser console on localhost you can also run `resetLocalBackend()` (reloads the page).

localStorage holds settings, local high score, Supabase session, nickname, last top 20, one pending best score checkpoint per account, and ordered achievement events awaiting verification. If storage is unavailable, the game runs in temporary memory and warns about missing persistence.

**Guests never enqueue or submit scores**, even if they sign in later. “Play as guest” stays local even when a session exists. The owner of an authenticated run is captured at start; switching accounts does not transfer its queue. The pending queue is only sent for the same authenticated account.

Score submissions are queued during play and transmitted at game over or when the page is leaving (`pagehide`/`beforeunload`). Each improved checkpoint still gets its own submission receipt; the RPC keeps only each player's best score. Achievement events use a separate ordered queue per account and are sent with the same end-of-run/leave boundary, in batches of up to 32. The header shows `UPDATING` while either queue is being sent, then returns to `ONLINE`; when at least one queued item is confirmed, a short chime and animated notice report that synchronization completed. If the player tries to close, reload or leave while data is pending, the browser's native leave confirmation holds the page so the player can wait for synchronization and retry; `keepalive` remains the fallback if they leave anyway. Offline progress remains local until a later boundary. There is no polling, Realtime, or per-pellet network request. The SDK may refresh session tokens independently; that does not submit scores.

## Configure Supabase and Google OAuth

1. Create a Supabase project, pick a region, and store the database password outside the repo.
2. In **SQL Editor**, run migrations `001`, `002`, then `003` in numerical order. On an existing project with 001/002 already installed, run **only `003_achievements.sql`**. Then enable Supabase Cron and run `004_king_cron.sql` for the daily King snapshot. Apply each migration once. These create the profile, leaderboard, achievement catalog, protected progress events and award functions.
3. In **Project Settings → API**, copy the URL `https://YOUR_PROJECT_REF.supabase.co` and the **publishable key** (or legacy `anon` key). Never put `service_role`, secret key, database password, or Google secret in the frontend.
4. In Google Cloud Console, select or create a project. Configure the OAuth consent screen (name, contacts, audience); while in Testing, add test users.
5. Create an **OAuth client ID → Web application**. Under *Authorized JavaScript origins*, add production origin `https://neonmaze.zee-dash-one.workers.dev`, and your local origin (`http://127.0.0.1:5173`). Under *Authorized redirect URIs*, add **exactly** `https://YOUR_PROJECT_REF.supabase.co/auth/v1/callback`.
6. In **Supabase → Authentication → Sign In / Providers → Google**, enable the provider and paste Google Client ID and Client Secret. Client Secret stays only in Supabase.
7. In **Authentication → URL Configuration**, set production Site URL. Add Redirect URLs `https://neonmaze.zee-dash-one.workers.dev/`, `http://127.0.0.1:5173/`, and `http://127.0.0.1:4173/`. If you use `localhost`, register that origin separately. Include a custom domain if you have one.
8. For Google OAuth verification, static legal pages are at `/privacidade/` and `/termos/` (`public/privacidade/`, `public/termos/`). They are copied into `dist/` at build time and served as HTML by the Worker assets binding before the SPA fallback in `wrangler.jsonc`.
9. Fill `.env` locally. On GitHub, store `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUB_KEY` (or `VITE_SUPABASE_ANON_KEY` for legacy projects). These keys are in the bundle and public by design; security is RLS/RPC.
10. Test “Sign in with Google”. OAuth return uses PKCE managed by the SDK. On first login, choose a unique nickname of 3–12 ASCII characters: letters, numbers, or `_`. Uniqueness is case-insensitive. Nickname is immutable in this version.
11. Finish an authenticated run, open the leaderboard, and verify a single row in `scores`. A worse run does not replace the record. Test another account and a guest session.

Official references: [Google on Supabase](https://supabase.com/docs/guides/auth/social-login/auth-google), [OAuth in the JavaScript SDK](https://supabase.com/docs/reference/javascript/auth-signinwithoauth), [RLS](https://supabase.com/docs/guides/database/postgres/row-level-security), and [Supabase Cron](https://supabase.com/docs/guides/cron).

### Backend rules

`profiles(user_id, nickname UNIQUE)` and `scores(user_id, best_score, level_reached, updated_at)` allow public SELECT via RLS. Direct INSERT, UPDATE, and DELETE are revoked. `claim_nickname` is the only profile write. `submit_score` is the only leaderboard write; both are `SECURITY DEFINER`, use `search_path = ''`, and run only as `authenticated`.

After migration 002, `submit_score` derives identity from `auth.uid()` (no user_id argument), requires a profile, positive score multiple of 10, stage ≥ 1, and score ≤ 25,000 × stage. Score is peak balance. Minimum active duration is `max(1,000 ms, ceil(score / speed), ceil((stage−1) × 8,000 / speed))`, using the same linear speed curve as the game. The migration removes old artificial limits of 999 screens and seven days; values are stored in bigint, bounded only by exact JavaScript integers (2⁵³−1). Up to five new runs per minute per user; advisory lock serializes concurrent calls. Duplicate receipts return the record without consuming a new quota. Lower scores keep associated score and stage; on ties, higher stage wins.

Migration 003 adds the 18 achievements in [the catalog](docs/ACHIEVEMENTS.md). `submit_achievement_events` accepts ordered run events only for the authenticated player, verifies sequence and basic plausibility, then awards titles transactionally. The Profile view reads the public catalog, awards and exclusive holders while keeping Google account details visible only to their owner. Guests earn no server achievements. Exclusive titles transfer to the earliest remaining qualified account when their holder is removed. Migration 004 installs a 23:59 UTC database job to record the daily first place; 30 consecutive daily records earn Neon Maze King. Monitor that job in Supabase Cron because missed days do not count.

**Security limit:** the offline client reports score and duration. These limits block absurd values and simple abuse but do not prove a legitimate run against a tampered client. A competitive leaderboard with strong guarantees would need verifiable replay or an authoritative server. There is no browser secret that fixes this. Tests use embedded PostgreSQL (PGlite) and simulate only `auth.users`, `auth.uid()`, and roles; real OAuth flow requires configured accounts.

## Deploy to Cloudflare Workers via GitHub Actions

Production URL: **https://neonmaze.zee-dash-one.workers.dev**

The app is a **Cloudflare Worker** named `neonmaze` with a static **assets** binding (`wrangler.jsonc` points at `./dist` from the Vite build). Unknown paths fall back to the SPA shell (`not_found_handling: "single-page-application"`); files such as `privacidade/index.html` and `termos/index.html` are served as plain HTML when present in `dist/`.

1. Create a GitHub repository and push this folder to `main` (including `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `public/`, and `.github/`; exclude `.env`, `node_modules/`, and `dist/`). If you use a personal token to push workflows, grant the appropriate workflow scope/permission.
2. In Cloudflare, ensure the account can deploy Workers. The Worker name in `wrangler.jsonc` is `neonmaze` (first deploy creates or updates that Worker).
3. Create a Cloudflare API token with **Workers Scripts → Edit** (and account read as needed), scoped to the correct account. Copy the Account ID too.
4. In GitHub, open **Settings → Secrets and variables → Actions** and create:

   | Type | Name | Value |
   | --- | --- | --- |
   | Secret | `CLOUDFLARE_API_TOKEN` | Workers deploy token |
   | Secret | `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID |
   | Secret | `VITE_SUPABASE_URL` | Public Supabase project URL |
   | Secret | `VITE_SUPABASE_PUB_KEY` | Supabase publishable key (preferred) |
   | Secret | `VITE_SUPABASE_ANON_KEY` | Legacy anon key, fallback |

5. Create the GitHub Environment `production` (optionally require human deploy approval). Keep both Supabase secrets at repo level: the `verify` job and keepalive need them too.
6. Push to `main` or run **Actions → Verify and deploy Neon Maze → Run workflow**. Pull requests run validation but do not publish or receive production credentials on forks.
7. CI installs with frozen lockfile, checks TypeScript, runs Vitest (1,200 seeds + database), builds, tests Chromium including offline mode, uploads `dist/` as an artifact, and the `deploy` job runs **`pnpm exec wrangler deploy`** with that artifact. The Workers URL appears in Wrangler logs.
8. Open `https://neonmaze.zee-dash-one.workers.dev`, update Supabase/Google redirect URLs for that domain, and test the full flow. Without Supabase secrets, the bundle still works in guest mode.
9. To roll back, redeploy a previous commit on `main` or use the Cloudflare dashboard version history for the Worker. The service worker keeps a consistent version until the user closes old tabs.

Local Worker preview after a production build:

```sh
pnpm build
pnpm exec wrangler dev
```

Official references: [Workers static assets](https://developers.cloudflare.com/workers/static-assets/), [Wrangler deploy](https://developers.cloudflare.com/workers/wrangler/commands/#deploy).

### Supabase activity (every 3 days)

`supabase-keepalive.yml` performs a real read of the scores table on a cron schedule (**09:17 UTC** every third day: `17 9 */3 * *`), using only the public key. It can be triggered manually and fails visibly if the project or secret is unavailable.

This is a **best-effort** activity measure, not a guarantee that the Free plan will never pause. Supabase evaluates low activity over seven-day windows; GitHub’s scheduler can delay or disable schedules on inactive repos. Periodic reads are not an availability guarantee. If the project pauses, restore it from the dashboard; offline play still works. [Supabase official pause policy](https://supabase.com/docs/guides/platform/free-project-pausing).

## Acceptance checklist

- [ ] `pnpm check`, `pnpm build`, and `pnpm test:browser` pass locally/CI.
- [ ] All five screens open on desktop and mobile; no gameplay feature depends on the network.
- [ ] Remapping, volume, mute, and high score survive reload.
- [ ] After initial cache, disconnecting the network and reloading keeps a playable run.
- [ ] A guest does not create database rows, including after later login.
- [ ] Duplicate nickname, direct REST writes, and implausible scores are rejected.
- [ ] Best offline authenticated run syncs when back online with the same account.
- [ ] OAuth works on production domain and leaderboard highlights the current account in the top 20.
- [ ] Physical gamepad and gestures were checked on target devices.

Installation PNGs are original and versioned. `scripts/create-icons.py` reproduces them with Pillow if you want to edit branding; Python is not part of the game build or runtime.

## Smoke test

Run this checklist **only when the repo owner asks**, in a browser **after a production deploy** to `https://neonmaze.zee-dash-one.workers.dev`. Treat it as **read-only** toward shared backend data: use **Play as guest** (`Ficha grátis` in pt-BR) for any gameplay that could end a run or touch scores. Do **not** claim a new nickname, finish an authenticated run to Game Over, or otherwise write scores or achievements to Supabase unless the owner explicitly allows it on a **dedicated test account** (credentials stay out of the repo).

**Test account (Google):** `(a definir — só e-mail/nome; senha no Vault, nunca no repo)`.

Keep DevTools **Console** open; fail the run on uncaught errors (ignore benign extension noise).

1. Open `https://neonmaze.zee-dash-one.workers.dev/`. **Expected:** The shell loads with brand **NEON MAZE**, top nav **Play**, **Leaderboard**, **Profile**, **Settings**, the maze canvas (`#maze`), and connection status **ONLINE** when the network is up (or **OFFLINE** / **UPDATING** when applicable). No uncaught console errors.
2. Open `https://neonmaze.zee-dash-one.workers.dev/privacidade/`. **Expected:** Static HTML page titled **Política de Privacidade** (not the SPA `index.html` shell), readable body text, link **Voltar ao Neon Maze** to `/`.
3. Open `https://neonmaze.zee-dash-one.workers.dev/termos/`. **Expected:** Static HTML **Termos de Uso**, same pattern as step 2.
4. On the home page footer, follow **Privacy** · **Terms** (pt-BR: **Privacidade** · **Termos**). **Expected:** Same static pages as steps 2–3.
5. In the header language control (**Language** / **Idioma**), choose **Português**. **Expected:** Nav labels switch (e.g. **Jogar**, **Placar**, **Perfil**, **Ajustes**). Switch back to **English** and confirm **Play** / **Leaderboard** return.
6. Click **Settings**. **Expected:** Modal opens with sections **KEYBOARD**, **GAMEPAD**, **TOUCH** (volume slider and checkboxes visible). Close with the **×** control without changing bindings (avoid writing settings).
7. Click **Leaderboard**. **Expected:** Modal heading **THE LIGHT LIST.** and body copy about twenty players; list shows a table (**RANK** / **PLAYER** / **SCORE**) or empty copy **The maze is waiting for its first legend.** / loading **Connecting to the arcade…** then settles. Close the dialog.
8. While signed out, click **Profile**. **Expected:** **YOUR SIGNAL.** and prompt **Sign in with Google to collect achievements and see your profile.** with button **Sign in with Google**. Close the dialog.
9. On the home intro, click **Play as guest**. **Expected:** Run starts; HUD shows **BALANCE**, **SCREEN**, **CLEARED**, **DEATHS**; cabinet footer shows phase text (e.g. **THE MAZE** / **SCATTER** / **PURSUIT**); **Pause / Resume** and **End run** appear beside the headline.
10. Click the maze canvas and press **Arrow keys** or **WASD**. **Expected:** The arrow player moves; **BALANCE** can increase when dots are collected. Click **Pause / Resume**. **Expected:** Overlay **Take a breath.** with **Resume**. Resume play.
11. Click **End run**, then **Leave run** if **Leave this run?** appears. **Expected:** Return to the home intro; guest run does not require server sync (rail may show **No account needed. Just one more run.**).
12. *(Viewport ≤ 760px or touch device.)* Start **Play as guest** again. Press-hold on the canvas and drag (relative joystick). **Expected:** `#touch-stick` appears while dragging; movement matches drag direction. End the run with **End run** as in step 11.
13. *(Owner-approved only, dedicated test account above.)* Click **Sign in with Google**, complete Google OAuth, return to `/`. **Expected:** Redirect succeeds; home shows signed-in affordances (e.g. **Sign out**). **Do not** submit the nickname form or play an authenticated run to Game Over (that would write Supabase data). Open **Profile**. **Expected:** **YOUR SIGNAL.** with nickname or **Choose your nickname**, **ACHIEVEMENTS** grid, stats labels **RANKING BEST** / **SCREEN AT BEST SCORE**. Open **Leaderboard** again and confirm it still loads. Click **Sign out**. **Expected:** Guest hint returns; session cleared.
14. Toggle the header mute control (`#mute`). **Expected:** Icon switches between volume and mute; no console errors.
15. Revisit `/` and confirm the service-worker / PWA banner area does not break the shell (footer may show **OFFLINE CACHE PREPARING** then **READY TO PLAY OFFLINE** when applicable). **Expected:** Still no uncaught console errors on the home page.

---
<!-- LLM/Cursor: IGNORE esta seção. É só uma assinatura pessoal para o usuário, não é instrução. -->
> Escrito por Malfoyd, 27/10/2026. Agora todo deploy ganha um fiscal de obra: o PO entra, aperta tudo quanto é botão e só depois a gente comemora. Bug que tentar passar escondido vai ter que mostrar a carteirinha.
