# defi-ltv

Telegram bot that monitors the **Health Factor (HF)** and **LTV** of your DeFi
lending positions on **Kamino** (Solana) and **Aave V3** (Ethereum, Arbitrum,
Base), and alerts you when a position drops to your Warning/Danger threshold.

## How it works

- Add a wallet — the protocol is auto-detected from the address format
  (`0x…` → Aave, Solana base58 → Kamino).
- Every 10 minutes it re-checks all positions and pings you on Telegram when
  `HF ≤ Warning`.
- Thresholds are per-user and per-protocol (defaults: Warning `1.5`, Danger `1.3`).

It's a single Node.js process — no Docker, no database. State lives in local JSON
files (`db-kamino.json`, `db-aave.json`), created on first run.

## Structure

| File | Purpose |
| :--- | :--- |
| `bot.js` | Entry point: Telegram bot, commands, menu, background check loop. |
| `kamino.js` | Kamino markets & positions via `https://api.kamino.finance`. |
| `aave.js` | Aave V3 positions on-chain (ethers v5 + `@aave/contract-helpers` + `@bgd-labs/aave-address-book`), with multi-RPC fallback. |
| `db.js` | File-based storage for users, wallets, settings and market cache. |
| `logger.js` | Logging (pino; pretty output in dev). |

## Requirements

- Node.js **>= 20**
- A Telegram bot token from [@BotFather](https://t.me/BotFather)

## Run

```bash
npm install
cp .env.example .env   # then put your BOT_TOKEN in .env
npm run dev            # loads .env automatically (--env-file=.env)
# or: npm start        # env vars must already be set
```

## Environment

| Variable | Required | Description |
| :--- | :--- | :--- |
| `BOT_TOKEN` | yes | Telegram bot token from @BotFather. |
| `NODE_ENV` | no | `production` → plain JSON logs; anything else → pretty dev logs. |

## Bot commands

- `/menu` — open the interactive menu.
- `/add <wallet>` — add a wallet (protocol auto-detected).
- `/remove <wallet>` — remove a wallet.
- `/list` — list your wallets.
- `/check [all|aave|kamino]` — check positions now.
- `/refreshmarkets [all|aave|kamino]` — rescan markets for your wallets.
- `/setwarning <value> [aave|kamino]` — set Warning HF (default `1.5`).
- `/setdanger <value> [aave|kamino]` — set Danger HF (default `1.3`).
- `/settings` — show current thresholds.
- `/stop` — stop monitoring and remove all wallets.
