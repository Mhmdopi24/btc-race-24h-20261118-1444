# Capitulation Recovery + Range Sleeve — cbBTC trading bot

[![make.fun](https://make.fun/c/btc-race-24h-20261118-1444/badge)](https://make.fun/c/btc-race-24h-20261118-1444)

Entry for the [make.fun bounty "Race a BTC trading bot live for 24 hours"](https://make.fun/c/btc-race-24h-20261118-1444) (`btc-race-24h-20261118-1444`): a long-only bot that trades Coinbase Wrapped BTC (cbBTC) against USDC, minute by minute, on 1-minute on-chain bars from the Orca Whirlpool, starting with 1,000 USDC of paper money.

## Strategy

Bitcoin mean-reverts on the 1-minute scale, so the bot buys dips in stages and sells into the recovery — never chasing, never shorting, never leveraged.

- **Buy the dip, in stages.** When the 30-bar return falls to −0.7% or worse *and* the price sits below its 30-bar average, buy with 40% of the cash on hand. A deeper dip (−0.9% or worse) buys a bigger sleeve: 90% of cash. At least 8 bars pass between buys, so a position is built gradually instead of all at once.
- **Don't catch a falling knife.** No buy when the 60-bar fall is steeper than −2.5%.
- **Volatility sizing.** When the mean absolute 1-minute move over the last 30 bars exceeds 12 bps, the buy size is halved.
- **Sell into strength.** Once the position is up 0.8% over its average cost (fees included), sell 75% and let the rest run; sell everything at +1.8%.
- **Hard stop.** Sell everything if the position falls 1.5% below its average cost.
- **No late entries.** No new buys in the last 120 bars of the window, so the end-of-window flattening cannot strand the bot in a fresh dip.

A full-size round trip pays about 26 bps in fees, slippage and pool impact, so every exit target sits well above that cost. All thresholds were tuned by backtesting on the competition's published dev window — not guessed.

## Dev-window result (local grade, kit's own grader)

| Metric | Value |
|---|---|
| Net PnL | **+15.16 USDC (+1.52%)** |
| Trades | 15 |
| Max drawdown | 0.51% |
| Fees paid | 1.39 USDC |
| Net PnL at 2× fees | +13.77 USDC |
| Determinism | two runs byte-identical (`result_sha256 c98143a4…`) |

Every kit baseline loses money on the same falling dev window (buy-and-hold −31.63, momentum −23.87, ema-cross −148.17, rsi-bollinger −39.92, adx-momentum −75.57, hold-cash 0.00 USDC) — this bot is the only one that clears the dev gate with a profit.

## How to run

The bot speaks `agent-fun/bars-replay/v1` (newline-delimited JSON on stdin/stdout) and runs on Node 22 with the standard library only. `vendor/makefun-bars.ts` is the kit's SDK shim, copied byte for byte.

```sh
# Grade locally with the kit (from the kit directory):
node cli/makefun.mjs grade-local --kit . --bot <path-to-this-repo> --driver process
```

The bot never reads the wall clock, the environment, or `Math.random`, so two runs on the same data produce identical orders.

## Layout

- `main.ts` — the bot (entrypoint)
- `vendor/makefun-bars.ts` — the kit's protocol shim, unmodified
- `LICENSE` — MIT
- `.makefun/owner.json` — claim file naming the payout wallet
