# defi-ltv

Telegram bot that monitors your DeFi positions:

- **Lending (borrow)** — Health Factor (HF), LTV and borrow rate on **Kamino**
  (Solana) and **Aave V3** (Ethereum, Arbitrum, Base), alerting when a position
  crosses your Warning/Danger threshold.
- **Lending (deposits)** — supply positions and their APY on **Kamino Earn**
  (kVaults, Solana), **Aave V3** and **Fluid** (Ethereum, Arbitrum, Base,
  Polygon), alerting when a deposit's APY **drops below** your Warning Supply
  APY threshold (and again when it recovers). Transition-only, like pool alerts.
- **LP pools** — concentrated-liquidity positions on **Orca** (Solana) and
  **Uniswap V3** (Ethereum, Arbitrum, Base, Polygon), alerting when a position
  goes **out of range** or comes back **in range**. Each position shows its
  **deposited value and uncollected (pending) fees in USD**; `/checkall` adds a
  total across all pools.
- **Tron resources** — staked **energy/bandwidth**, outgoing delegations and
  their reclaim dates, alerting when delegated resources become reclaimable or
  when free resources can be (re)delegated.
- **Top LP discovery** (`/toplp`, `/toplpl2`) — ranks Uniswap v3/v4 BTC and ETH
  pools **paired with USDC/USDT** across the top-5 EVM chains by a **fee-weighted score** (30d vol / TVL × fee%)
  (capital efficiency), liquidity > $100k. Two lists (BTC, ETH), top 10 each, with
  direct Uniswap links. `/toplpl2` excludes Ethereum L1 (lower-gas chains only).
- **Web app** — a React app for managing wallets, thresholds and viewing
  positions. Works both as a **Telegram Mini App** and **standalone in a
  browser** (sign-in via the Telegram Login Widget). Notifications stay in the
  bot chat. Auto dark/light theme.

## Architecture

Two services:

- **Core (monolith, repo root, plain JS)** — owns PostgreSQL, all chain
  scanners, the background alert loops and the REST API (`/api/*`); also serves
  the web app bundle. The only service that touches the database.
- **Bot (`bot/`, TypeScript strict)** — a thin UI layer over the core API: it
  renders Telegram menus/messages and forwards every command to the core via
  HTTP (`Authorization: Internal <token>` + `X-Chat-Id`). It exposes one
  endpoint of its own, `POST /notify`, which the core calls to deliver alert
  events; the bot renders them into Telegram messages. If delivery fails, the
  core keeps the previous alert state and retries next cycle.

Web app auth: inside Telegram — signed `initData` (`tma` header); standalone —
Telegram Login Widget → the core validates the widget signature and issues a
30-day JWT (`Bearer` header).

## How it works

- Add a wallet — platforms are auto-detected from the address format
  (`0x…` → Aave + Uniswap V3, `T…` → Tron, Solana base58 → Kamino + Orca).
- Every 10 minutes it re-checks lending/deposit/LP positions and pings you on
  Telegram when:
  - `HF ≤ Warning` **or** `borrow rate ≥ Warning` (lending), or
  - a deposit's **supply APY crosses the Warning Supply APY threshold** (drops
    below it, or recovers back above) — transition-only, or
  - an LP position **crosses the range boundary** (in ↔ out). Range alerts fire
    only on the transition, not repeatedly while it stays out of range.
- Tron wallets are checked **hourly** (resource state changes slowly). Alerts
  fire on transition: when a delegation becomes reclaimable (lock expired and
  bandwidth > 500), or when resources are free to delegate (free energy +
  bandwidth > 500 + nothing delegated).
- Lending thresholds are **per-wallet**: every wallet has its own Warning/Danger
  for HF and for borrow rate. New wallets inherit user-wide **global defaults**
  (which you can change) — Warning HF `1.5`, Danger HF `1.3`, Warning rate `10%`,
  Danger rate `15%`.
- Borrow rate is the borrow APY. For a Kamino position that borrows several
  assets, the **highest** asset borrow APY is used; for Aave it's the per-asset rate.
- LP positions are discovered live on every check: Orca via the wallet's position
  NFTs + Orca public API, Uniswap V3 via the NonfungiblePositionManager contract
  on each chain.

Durable state (users, wallets, per-wallet settings) lives in **PostgreSQL**.
Refetchable/ephemeral state (market caches, transient UI state) lives in a
swappable **keyv** cache — in-memory by default, Redis-ready via `REDIS_URL`.
The schema is created automatically on startup (`CREATE TABLE IF NOT EXISTS`).

## Structure

| File | Purpose |
| :--- | :--- |
| `main.js` | Core entry point: DB init, market caches, alert loops, web server. |
| `server.js` | Express: REST API (`/api/*`, three auth modes) + static webapp bundle. |
| `alerts.js` | Background alert loops (lending, supply APY, LP range, Tron) emitting structured events to the bot. |
| `notifier.js` | Delivers alert events to the bot's `/notify` (throws on failure → alert state kept, retried). |
| `auth.js` | Telegram initData + Login Widget validation, session JWTs, internal-token check. |
| `core.js` | Shared domain logic: wallet type detection, thresholds/defaults, severity, scan dispatchers, add-wallet & refresh flows. |
| `kamino.js` | Kamino lending positions + Kamino Earn (kVault) deposits via `https://api.kamino.finance`. |
| `aave.js` | Aave V3 borrow + supply positions on-chain (ethers v5 + `@aave/contract-helpers` + `@bgd-labs/aave-address-book`), with multi-RPC fallback. |
| `fluid.js` | Fluid (Instadapp) lending deposits via `api.fluid.instadapp.io` (fToken positions + supply APR). |
| `orca.js` | Orca Whirlpool LP positions: wallet position NFTs via Solana RPC + Orca public API. |
| `uniswap.js` | Uniswap V3 LP positions on-chain via NonfungiblePositionManager (reuses Aave RPC fallback). |
| `tron.js` | Tron account resources (energy/bandwidth), delegations and reclaim dates via TronGrid HTTP API. |
| `toplp.js` | Top Uniswap v3/v4 LP pools (BTC/ETH vs stables) by a fee-weighted score (30d vol/TVL × fee%) across top EVM chains, via DefiLlama (chain TVL) + Uniswap GraphQL gateway (pools). |
| `db.js` | PostgreSQL (`pg`): users + wallets, granular atomic per-row ops; schema bootstrap. |
| `cache.js` | keyv wrapper for ephemeral cache (markets); in-memory or Redis. |
| `webapp/` | Web app frontend: React + `@telegram-apps/telegram-ui` + Vite. |
| `bot/` | Telegram bot microservice (TypeScript strict): menus/commands over the core API + `/notify` renderer. |
| `logger.js` | Logging (pino; pretty output in dev). |

## Requirements

- Node.js **>= 20**
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- PostgreSQL (locally via the bundled `docker-compose.yml`)

## Run

```bash
docker compose up -d   # local Postgres on :5432 (matches the default DATABASE_URL)
npm install
cp .env.example .env   # put your BOT_TOKEN in .env (keep the dev INTERNAL_TOKEN)
npm run dev            # core: API + alert loops on :3000

# in a second terminal — the bot microservice:
cd bot && npm install
npm run build
BOT_TOKEN=... CORE_URL=http://localhost:3000 INTERNAL_TOKEN=dev-internal-token npm start
# (or `npm run dev` with the same env for tsx watch)
```

## Deploy (Railway) — two services from one repo

1. Project → **New → Database → Add PostgreSQL**.
2. **Core service** (root directory `/`):
   - Variables: `BOT_TOKEN`, `DATABASE_URL = ${{Postgres.DATABASE_URL}}`,
     `INTERNAL_TOKEN` (e.g. `openssl rand -hex 32`),
     `BOT_URL = http://<bot-service-name>.railway.internal:3100`.
   - Settings → Networking → **Generate Domain** (this is the web app URL).
     When asked for a port, use the service's `PORT` (default 3000).
   - Build runs `npm run build` (webapp bundle), start `npm start`.
3. **Bot service** (add a second service from the same repo, **Root Directory
   = `bot`**):
   - Variables: `BOT_TOKEN` (same), `INTERNAL_TOKEN` (same),
     `CORE_URL = http://<core-service-name>.railway.internal:3000`,
     `PORT = 3100`, `WEBAPP_URL = https://<core domain>` (so the menu button
     opens the app).
   - Build `npm run build` (tsc), start `npm start`.
4. **Login Widget** (standalone browser sign-in): in BotFather run
   `/setdomain` for your bot and set it to the core domain — the widget only
   renders on the registered domain.
5. (Optional Redis cache: add a Redis service, set `REDIS_URL = ${{Redis.REDIS_URL}}`, `npm i @keyv/redis`.)

## Web app

- **Inside Telegram**: opens from the bot's menu button (set automatically when
  the bot service has `WEBAPP_URL`), auth via signed `initData` — no login step.
- **Standalone browser**: open the core domain directly → sign in with the
  Telegram Login Widget → the core issues a 30-day JWT. Same account, same data.
- Three tabs: **Positions** (on-demand scan of everything: deposits, lending,
  LP pools, Tron — with totals), **Wallets** (add one or many, remove),
  **Settings** (global defaults + per-wallet threshold overrides; standalone
  mode also has Log out).
- Local dev: core on :3000, `cd webapp && npx vite` (UI on :5173 with `/api`
  proxied). To open inside Telegram it must be HTTPS — tunnel with
  `cloudflared tunnel --url http://localhost:5173` and point a dev bot's menu
  button at the tunnel URL.

## Environment

Core service (repo root):

| Variable | Required | Description |
| :--- | :--- | :--- |
| `BOT_TOKEN` | yes | Telegram bot token — used to validate webapp auth signatures (initData / Login Widget). |
| `DATABASE_URL` | yes | PostgreSQL connection string. Local dev: `postgres://postgres:dev@localhost:5432/postgres` (docker-compose). |
| `INTERNAL_TOKEN` | yes | Shared secret for core ↔ bot HTTP auth (same value in both services). |
| `BOT_URL` | yes* | Base URL of the bot microservice for alert delivery. Without it alerts can't be delivered (they retry every cycle). |
| `PORT` | no | HTTP port for API + webapp (default 3000; Railway injects it). |
| `REDIS_URL` | no | Redis URL for the ephemeral cache. Unset → in-memory. Requires `@keyv/redis`. |
| `NODE_ENV` | no | `production` → plain JSON logs; anything else → pretty dev logs. |
| `SOLANA_RPC_URL` | no | Solana RPC URL(s) for Orca scanning (comma-separated). Many public RPCs now block `getTokenAccountsByOwner`; set a private endpoint for reliable Orca monitoring. Falls back to keyless public RPCs. |

Bot microservice (`bot/`):

| Variable | Required | Description |
| :--- | :--- | :--- |
| `BOT_TOKEN` | yes | Telegram bot token from @BotFather. |
| `CORE_URL` | yes | Base URL of the core API. |
| `INTERNAL_TOKEN` | yes | Shared secret (same as core). |
| `PORT` | no | Port for the `/notify` listener (default 3100). |
| `WEBAPP_URL` | no | Public HTTPS URL of the web app. When set, the bot's menu button opens it. |

## Bot commands

Everything is driven through the interactive menu:

- `/menu` — open the menu: add/remove wallets, tap a wallet under **Wallets** to
  edit its thresholds, **Settings** edits the global defaults, **Check All** /
  **Refresh All** run checks, **Top LP** / **Top LP (L2)** rank pools.
- `/checkall` — check all positions now (lending + LP pools + Tron).
- `/toplp` — top Uniswap v3/v4 BTC/ETH-vs-stable pools by fee-weighted score (30d vol/TVL × fee%).
- `/toplpl2` — same, excluding Ethereum L1 (lower-gas chains only).
