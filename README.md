# defi-ltv

Telegram bot that monitors the **Health Factor (HF)**, **LTV** and **borrow rate**
of your DeFi lending positions on **Kamino** (Solana) and **Aave V3** (Ethereum,
Arbitrum, Base), and alerts you when a position crosses your Warning/Danger
threshold.

## How it works

- Add a wallet — the protocol is auto-detected from the address format
  (`0x…` → Aave, Solana base58 → Kamino).
- Every 10 minutes it re-checks all positions and pings you on Telegram when
  `HF ≤ Warning` **or** `borrow rate ≥ Warning`.
- Thresholds are **per-wallet**: every wallet has its own Warning/Danger for HF
  and for borrow rate. New wallets inherit user-wide **global defaults** (which you
  can change) — Warning HF `1.5`, Danger HF `1.3`, Warning rate `10%`, Danger rate `15%`.
- Borrow rate is the borrow APY. For a Kamino position that borrows several
  assets, the **highest** asset borrow APY is used; for Aave it's the per-asset rate.

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

All threshold commands take a target — a wallet address, its **index** from
`/list`, or the keyword **`default`** (to change the global defaults).

- `/menu` — open the interactive menu. Tap a wallet under **Wallets** to edit its
  thresholds; **Settings** edits the global defaults.
- `/add <wallet>` — add a wallet (protocol auto-detected).
- `/remove <wallet>` — remove a wallet.
- `/list` — list your wallets with their thresholds.
- `/check [all|aave|kamino]` — check positions now.
- `/refreshmarkets [all|aave|kamino]` — rescan markets for your wallets.
- `/setwarning <wallet|index|default> <value>` — set Warning HF.
- `/setdanger <wallet|index|default> <value>` — set Danger HF.
- `/setratewarning <wallet|index|default> <value>` — set Warning borrow rate (%).
- `/setratedanger <wallet|index|default> <value>` — set Danger borrow rate (%).
- `/settings` — show global defaults and per-wallet thresholds.
- `/stop` — stop monitoring and remove all wallets.
