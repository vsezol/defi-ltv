# defi-ltv

Telegram bot that monitors your DeFi positions:

- **Lending (borrow)** — Health Factor (HF), LTV and borrow rate on **Kamino**
  (Solana) and **Aave V3** (Ethereum, Arbitrum, Base, Polygon), alerting when a
  position crosses your Warning/Danger threshold.
- **LP pools** — concentrated-liquidity positions on **Orca** and **Meteora
  DLMM** (Solana) and **Uniswap V3** (Ethereum, Arbitrum, Base, Polygon),
  alerting when a position goes **out of range** or comes back **in range**.
- **Tron resources** — staked **energy/bandwidth**, outgoing delegations and
  their reclaim dates, alerting when delegated resources become reclaimable or
  when free resources can be (re)delegated.
- **Top LP discovery** (`/toplp`, `/toplpl2`) — ranks Uniswap v3/v4 BTC and ETH
  pools **paired with USDC/USDT** across the top-5 EVM chains by a **fee-weighted score** (30d vol / TVL × fee%)
  (capital efficiency), liquidity > $100k. Two lists (BTC, ETH), top 10 each, with
  direct Uniswap links. `/toplpl2` excludes Ethereum L1 (lower-gas chains only).
- **Telegram Mini App** — a React web app (served by the bot process) for
  managing wallets, thresholds and viewing positions; notifications stay in the
  bot chat. Auto dark/light theme following Telegram.

## How it works

- Add a wallet — platforms are auto-detected from the address format
  (`0x…` → Aave + Uniswap V3, `T…` → Tron, Solana base58 → Kamino + Orca).
- Every 10 minutes it re-checks lending/LP positions and pings you on Telegram
  when:
  - `HF ≤ Warning` **or** `borrow rate ≥ Warning` (lending), or
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
  NFTs + Orca public API, Meteora DLMM via the Meteora datapi, Uniswap V3 via the
  NonfungiblePositionManager contract on each chain.

Durable state (users, wallets, per-wallet settings) lives in **PostgreSQL**.
Refetchable/ephemeral state (market caches, transient UI state) lives in a
swappable **keyv** cache — in-memory by default, Redis-ready via `REDIS_URL`.
The schema is created automatically on startup (`CREATE TABLE IF NOT EXISTS`).

## Structure

| File | Purpose |
| :--- | :--- |
| `bot.js` | Entry point: Telegram bot, commands, menu, background check loop. |
| `core.js` | Shared logic (bot + Mini App API): wallet type detection, thresholds/defaults, severity, LP scan dispatcher, add-wallet flow. |
| `kamino.js` | Kamino borrow (obligation) positions via `https://api.kamino.finance`. |
| `aave.js` | Aave V3 borrow positions on-chain (ethers v5 + `@aave/contract-helpers` + `@bgd-labs/aave-address-book`), multi-RPC fallback with per-attempt timeout; all networks scanned in parallel. |
| `orca.js` | Orca Whirlpool LP positions: wallet position NFTs via Solana RPC + Orca public API. |
| `meteora.js` | Meteora DLMM LP positions via the Meteora datapi (`dlmm.datapi.meteora.ag`) — positions by wallet, no RPC. |
| `uniswap.js` | Uniswap V3 LP positions on-chain via NonfungiblePositionManager (reuses Aave RPC fallback); networks and positions scanned in parallel. |
| `tron.js` | Tron account resources (energy/bandwidth), delegations and reclaim dates via TronGrid HTTP API. |
| `toplp.js` | Top Uniswap v3/v4 LP pools (BTC/ETH vs stables) by a fee-weighted score (30d vol/TVL × fee%) across top EVM chains, via DefiLlama (chain TVL) + Uniswap GraphQL gateway (pools). |
| `db.js` | PostgreSQL (`pg`): users + wallets, granular atomic per-row ops; schema bootstrap. |
| `cache.js` | keyv wrapper for ephemeral cache (markets, UI state); in-memory or Redis. |
| `server.js` | Express: Mini App REST API (`/api/*`, initData-authenticated) + static webapp bundle. |
| `webapp-auth.js` | Telegram initData HMAC validation (no deps). |
| `webapp/` | Mini App frontend: React + `@telegram-apps/telegram-ui` + Vite. |
| `logger.js` | Logging (pino; pretty output in dev). |

## Requirements

- Node.js **>= 20**
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- PostgreSQL (locally via the bundled `docker-compose.yml`)

## Run

```bash
docker compose up -d   # local Postgres on :5432 (matches the default DATABASE_URL)
npm install
cp .env.example .env   # then put your BOT_TOKEN in .env
npm run dev            # loads .env automatically (--env-file=.env)
# or: npm start        # env vars must already be set
```

## Deploy (Railway)

1. Project → **New → Database → Add PostgreSQL**.
2. Bot service → **Variables** → `DATABASE_URL = ${{Postgres.DATABASE_URL}}`
   (reference var → resolves to the internal `*.railway.internal` host: no egress, no SSL).
3. Redeploy. `npm start` runs the bot; tables are created on first boot
   (`npm run build` builds the Mini App bundle during deploy).
4. **Mini App**: Settings → Networking → **Generate Domain**, then set
   `WEBAPP_URL = https://<app>.up.railway.app`. On the next boot the bot points
   its menu button at the app.
5. (Optional Redis cache: add a Redis service, set `REDIS_URL = ${{Redis.REDIS_URL}}`, `npm i @keyv/redis`.)

## Mini App

- Open it from the bot's **menu button** (set automatically when `WEBAPP_URL` is configured).
- Three tabs: **Positions** (auto-loads a scan of borrow positions, LP pool
  ranges and Tron, with a loading skeleton), **Wallets** (add one or many,
  remove), **Settings** (global defaults + per-wallet threshold overrides).
- Auth: every `/api` request carries Telegram's signed `initData`; the server
  validates the HMAC with the bot token — no separate accounts.
- Local dev: `npm run dev` (bot + API on :3000), `cd webapp && npx vite` (UI on
  :5173 with `/api` proxied). To open inside Telegram it must be HTTPS — tunnel
  with `cloudflared tunnel --url http://localhost:5173` and point a dev bot's
  menu button at the tunnel URL.

## Environment

| Variable | Required | Description |
| :--- | :--- | :--- |
| `BOT_TOKEN` | yes | Telegram bot token from @BotFather. |
| `DATABASE_URL` | yes | PostgreSQL connection string. Local dev: `postgres://postgres:dev@localhost:5432/postgres` (docker-compose). |
| `REDIS_URL` | no | Redis URL for the ephemeral cache. Unset → in-memory. Requires `@keyv/redis`. |
| `NODE_ENV` | no | `production` → plain JSON logs; anything else → pretty dev logs. |
| `SOLANA_RPC_URL` | no | Solana RPC URL(s) for Orca scanning (comma-separated). Many public RPCs now block `getTokenAccountsByOwner`; set a private endpoint for reliable Orca monitoring. Falls back to keyless public RPCs. |
| `WEBAPP_URL` | no | Public HTTPS URL of the Mini App. When set, the bot's menu button opens it. |
| `PORT` | no | HTTP port for the Mini App server (default 3000; Railway injects it). |

## Bot commands

Everything is driven through the interactive menu:

- `/menu` — open the menu: add/remove wallets, tap a wallet under **Wallets** to
  edit its thresholds, **Settings** edits the global defaults, **Check All** /
  **Refresh All** run checks, **Top LP** / **Top LP (L2)** rank pools.
- `/checkall` — check all positions now (lending + LP pools + Tron).
- `/toplp` — top Uniswap v3/v4 BTC/ETH-vs-stable pools by fee-weighted score (30d vol/TVL × fee%).
- `/toplpl2` — same, excluding Ethereum L1 (lower-gas chains only).
