// Capitulation Recovery + Range Sleeve — a long-only cbBTC/USDC bot for
// make.fun's "Race a BTC trading bot live for 24 hours"
// (btc-race-24h-20261118-1444).
//
// Idea: BTC mean-reverts on the 1-minute scale. The bot buys dips in stages
// (a sharp 30-bar fall below its 30-bar average), refuses to catch a knife
// (a 60-bar fall that is too steep), scales the buy size with the depth of
// the dip and down with recent volatility, then sells in stages into the
// recovery with a hard stop underneath. It never opens a new position in the
// last 120 bars of the window, so the end flattening cannot strand it.
//
// Costs: a full-size round trip pays ~26 bps (4 bps fee + 2 bps slippage +
// pool impact each way), so every exit target sits well above that.
//
// All decisions use only the bars the harness has sent (the close of the
// batch being answered); nothing reads the clock, the environment or
// Math.random, so two runs on the same data answer identically.

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch, OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// --- tuned on the published dev window (see README) -----------------------
// Buy when the 30-bar return is at or below this (a -0.7% dip in 30 min).
const BUY_DROP_BPS = -70;
// A deeper dip buys a bigger sleeve of the cash.
const DEEP_DROP_BPS = -90;
const BASE_FRACTION_BPS = 4000; // 40% of cash per buy
const DEEP_FRACTION_BPS = 9000; // 90% of cash per buy on a deep dip
// Refuse the buy when the 60-bar fall is steeper than this: falling knife.
const KNIFE_FLOOR_BPS = -250;
// At least this many bars between two buys, so a position is built in stages.
// Tuned on the dev window: cooldowns of 5-8 bars all score ~+$15 (a stable
// plateau), while 10+ bars miss the second leg of the dip and halve the PnL.
const BUY_COOLDOWN_BARS = 8;
// Sell 75% of the position once it is up this much over its average cost...
const TAKE_PROFIT_1_BPS = 80;
// ...and the rest once it is up this much.
const TAKE_PROFIT_2_BPS = 180;
// Hard stop: sell everything this far below the average cost.
const STOP_LOSS_BPS = -150;
// When the mean absolute 1-minute move over the last 30 bars is above this,
// halve the buy size (volatility sizing).
const VOL_CAP_BPS = 12;
// No new buys once this many bars of the 1,440-bar window are left.
const NO_BUY_AFTER_SEQ = 1320;
// Bars of history needed before the first decision.
const WARMUP_BARS = 61;
// Max slippage vs the latest close: the largest 1-minute move on the dev
// window was ~64 bps, so 300 bps never binds in practice yet still guards
// against a wild open.
const MAX_SLIPPAGE_BPS = 300;

const MIN_NOTIONAL = 1_000_000n; // 1 USDC, in micro-USDC

// Average fill price of the open position, in the symbol's price units
// (raw integer, price_scale 5), derived from the position's cost basis.
function avgCostPrice(state: BarsState): bigint | null {
  const pos = state.positions.get(SYMBOL);
  if (pos === undefined || pos.qty <= 0n) return null;
  // value = qty * price * 10^quote_scale / 10^(qty_scale + price_scale)
  //   => price = cost * 10^(8 + 5) / (qty * 10^6) = cost * 10^7 / qty.
  return (pos.cost * 10_000_000n) / pos.qty;
}

const closes: number[] = [];
let lastBuySeq = -1_000_000;

await runBars({
  onBatch(state: BarsState, _batch: Batch): OrderInput[] {
    if (state.warmingUp) return [];
    const closeRaw = state.close(SYMBOL);
    if (closeRaw === null) return [];
    const close = Number(closeRaw);
    closes.push(close);
    if (closes.length > 240) closes.shift();
    if (state.seq < WARMUP_BARS || closes.length < WARMUP_BARS) return [];

    const orders: OrderInput[] = [];
    const pos = state.positions.get(SYMBOL);
    const qty = pos?.qty ?? 0n;
    const cash = state.cash;

    // --- exits first: manage the open position ----------------------------
    if (qty > 0n) {
      const avg = avgCostPrice(state);
      if (avg !== null && avg > 0n) {
        const gainBps = Math.round(((close - Number(avg)) / Number(avg)) * 10_000);
        let sellQty = 0n;
        if (gainBps >= TAKE_PROFIT_2_BPS || gainBps <= STOP_LOSS_BPS) {
          sellQty = qty; // full exit: big win, or hard stop
        } else if (gainBps >= TAKE_PROFIT_1_BPS) {
          sellQty = (qty * 3n) / 4n; // bank 75%, let the rest run
        }
        if (sellQty > 0n) {
          // A partial sell must leave at least 1 USDC of position behind,
          // otherwise empty it entirely (a sub-minimum remainder is rejected).
          const rest = qty - sellQty;
          const restValue = state.value(SYMBOL, rest);
          if (sellQty < qty && restValue < MIN_NOTIONAL) sellQty = qty;
          const sellValue = state.value(SYMBOL, sellQty);
          if (sellQty === qty || sellValue >= MIN_NOTIONAL) {
            orders.push({ side: 'sell', symbol: SYMBOL, qty: sellQty, max_slippage_bps: MAX_SLIPPAGE_BPS });
            return orders; // one action per bar keeps fills predictable
          }
        }
      }
    }

    // --- entries: buy the dip, in stages ----------------------------------
    if (state.seq >= NO_BUY_AFTER_SEQ) return orders;
    if (state.seq - lastBuySeq < BUY_COOLDOWN_BARS) return orders;
    if (cash < MIN_NOTIONAL * 2n) return orders;

    const n = closes.length;
    const c30 = closes[n - 31];
    const c60 = closes[n - 61];
    const ret30Bps = Math.round(((close - c30) / c30) * 10_000);
    const ret60Bps = Math.round(((close - c60) / c60) * 10_000);
    let sma30 = 0;
    for (let i = n - 30; i < n; i++) sma30 += closes[i];
    sma30 /= 30;
    let volBps = 0;
    for (let i = n - 30; i < n; i++) volBps += Math.abs(Math.log(closes[i] / closes[i - 1]));
    volBps = (volBps / 30) * 10_000;

    // Dip below its 30-bar average, but not a free fall over 60 bars.
    if (ret30Bps > BUY_DROP_BPS) return orders;
    if (close >= sma30) return orders;
    if (ret60Bps <= KNIFE_FLOOR_BPS) return orders;

    let fractionBps = BASE_FRACTION_BPS;
    if (ret30Bps <= DEEP_DROP_BPS) fractionBps = DEEP_FRACTION_BPS;
    if (volBps > VOL_CAP_BPS) fractionBps = Math.floor(fractionBps / 2);

    let spend = (cash * BigInt(fractionBps)) / 10_000n;
    const room = state.weightRoom(SYMBOL);
    if (spend > room) spend = room;
    if (spend < MIN_NOTIONAL) return orders;

    lastBuySeq = state.seq;
    orders.push({ side: 'buy', symbol: SYMBOL, notional_quote_units: spend, max_slippage_bps: MAX_SLIPPAGE_BPS });
    return orders;
  },
});
