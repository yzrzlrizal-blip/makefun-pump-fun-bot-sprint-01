// Survivor Rider: a pump.fun replay paper bot.
//
// Most pump.fun coins die within minutes, so this bot only buys a coin after
// it has survived the rug window: at least 1500 slots old, 20+ trades
// printed, at least 2 SOL of real reserves in the curve, and its price up
// at least 10% over both its first print and its own low. It risks a small
// fixed 0.02 SOL stake per coin, one buy per coin ever, at most 5 positions
// open, and exits fast: a stop-loss at -8%, a trailing stop that arms once
// the position is up 15% and sells on a 20% give-back from the peak, or a
// max hold of 1500 slots.
//
// All decisions are pure functions of the replay batches (no clock, no
// randomness, no environment), so two runs on the same data agree exactly.
// Prices are compared as exact BigInt ratios of the curve's virtual
// reserves, never as floats.

import {
  runBot,
  LAMPORTS_PER_SOL,
  type BotState,
  type Batch,
  type OrderInput,
} from "./vendor/makefun-bot.ts";

// ---------------------------------------------------------------- tuning

/** SOL staked on each buy (0.02 SOL). */
const STAKE_LAMPORTS = (LAMPORTS_PER_SOL * 2n) / 100n;
/** Smallest buy that counts toward the guardrail round trips (0.01 SOL). */
const MIN_STAKE_LAMPORTS = LAMPORTS_PER_SOL / 100n;
/** Keep this much cash spare for sell transaction fees (0.01 SOL). */
const CASH_RESERVE_LAMPORTS = LAMPORTS_PER_SOL / 100n;
/** A coin must be at least this old, in slots, before we trust it. */
const AGE_MIN_SLOTS = 1500;
/** Minimum trades printed before a coin can qualify. */
const TRADES_MIN = 20;
/** Minimum real SOL sitting in the curve (2 SOL). */
const REAL_MIN_LAMPORTS = LAMPORTS_PER_SOL * 2n;
/** The last price must be at least this share of the first print (110%). */
const FIRST_MIN_NUM = 110n;
const FIRST_MIN_DEN = 100n;
/** The last price must be at least this share of the coin's own low (110%). */
const LOW_MIN_NUM = 110n;
const LOW_MIN_DEN = 100n;
/** Stop-loss: sell when the mark is at or below this share of entry (92%). */
const STOP_NUM = 92n;
const STOP_DEN = 100n;
/** Trailing stop arms once the peak reaches this share of entry (115%). */
const TRAIL_ARM_NUM = 115n;
const TRAIL_ARM_DEN = 100n;
/** Once armed, sell when the mark falls to this share of the peak (80%). */
const TRAIL_NUM = 80n;
const TRAIL_DEN = 100n;
/** Hard exit: sell after this many slots held, whatever the price. */
const MAX_HOLD_SLOTS = 1500;
/** Slippage guard on every order (5%). */
const SLIPPAGE_BPS = 500;

// ---------------------------------------------------------------- prices

/** A price as a ratio of virtual reserves: quote per token. */
interface Price {
  q: bigint;
  t: bigint;
}

/** True when p is at least (num/den) times other: p.q/p.t >= (num/den)*(o.q/o.t). */
function priceAtLeast(p: Price, other: Price, num: bigint, den: bigint): boolean {
  return p.q * other.t * num >= other.q * p.t * den;
}

/** True when p is at most (num/den) times other. */
function priceAtMost(p: Price, other: Price, num: bigint, den: bigint): boolean {
  return p.q * other.t * num <= other.q * p.t * den;
}

// ---------------------------------------------------------------- per-coin bookkeeping

interface Coin {
  mint: string;
  /** Slot of its CreateEvent; null when first seen through a trade or mark. */
  createdSlot: number | null;
  first: Price;
  low: Price;
  last: Price;
  trades: number;
  realQuote: bigint;
  complete: boolean;
}

interface OpenPos {
  mint: string;
  /** Entry price: SOL spent per token received on the buy fill. */
  entry: Price;
  /** Best mark price seen since entry. */
  peak: Price;
  entrySlot: number;
}

const coins = new Map<string, Coin>();
/** Mints we have ever bought (one buy per coin, ever). */
const bought = new Set<string>();
/** Mints with a buy order still in flight. */
const pendingBuy = new Set<string>();
/** Mints with a sell order still in flight. */
const pendingSell = new Set<string>();
/** Open positions by mint, keyed from buy fills. */
const open = new Map<string, OpenPos>();
/** Diagnostics: how many coins failed each buy-test stage (stderr only). */
const stageFails = new Map<string, number>();
function failStage(stage: string): void {
  stageFails.set(stage, (stageFails.get(stage) ?? 0) + 1);
}

function notePrice(c: Coin, q: bigint, t: bigint): void {
  const p: Price = { q, t };
  c.last = p;
  if (priceAtMost(p, c.low, 1n, 1n)) c.low = p;
}

// ---------------------------------------------------------------- buy test

function qualifies(c: Coin, slot: number): boolean {
  if (c.complete) return false;
  if (c.createdSlot === null) {
    failStage("no_create");
    return false;
  }
  if (slot - c.createdSlot < AGE_MIN_SLOTS) return false;
  if (c.trades < TRADES_MIN) {
    failStage("trades");
    return false;
  }
  if (c.realQuote < REAL_MIN_LAMPORTS) {
    failStage("real_reserves");
    return false;
  }
  // It held up: price at least 10% over its first print and over its low.
  if (!priceAtLeast(c.last, c.first, FIRST_MIN_NUM, FIRST_MIN_DEN)) {
    failStage("below_first");
    return false;
  }
  if (!priceAtLeast(c.last, c.low, LOW_MIN_NUM, LOW_MIN_DEN)) {
    failStage("below_low");
    return false;
  }
  return true;
}

// ---------------------------------------------------------------- the bot

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const orders: OrderInput[] = [];
    const changed = new Set<string>();

    // Fills first: record entries, clear finished positions and in-flight flags.
    for (const fill of batch.fills) {
      if (fill.side === "buy") {
        pendingBuy.delete(fill.mint);
        if (fill.status !== "filled") continue;
        bought.add(fill.mint);
        const tokens = BigInt(fill.token_amount);
        const spent = BigInt(fill.quote_lamports);
        if (tokens > 0n && spent > 0n) {
          const entry: Price = { q: spent, t: tokens };
          open.set(fill.mint, {
            mint: fill.mint,
            entry,
            peak: entry,
            entrySlot: fill.slot,
          });
        }
      } else if (fill.side === "sell") {
        pendingSell.delete(fill.mint);
        if (fill.status === "filled") open.delete(fill.mint);
      }
      // Harness closes (_complete/_flatten/_writeoff) arrive as sell fills
      // too, so the position is gone either way.
      if (fill.client_id.startsWith("_")) {
        open.delete(fill.mint);
        pendingSell.delete(fill.mint);
      }
    }

    // Events: keep every curve's shape current, note which coins moved.
    for (const event of batch.events) {
      if (event.event === "CreateEvent") {
        let c = coins.get(event.mint);
        if (c === undefined) {
          const first: Price = {
            q: BigInt(event.virtual_quote_reserves),
            t: BigInt(event.virtual_token_reserves),
          };
          c = {
            mint: event.mint,
            createdSlot: event.slot,
            first,
            low: first,
            last: first,
            trades: 0,
            realQuote: 0n,
            complete: false,
          };
          coins.set(event.mint, c);
        }
        changed.add(event.mint);
      } else if (event.event === "TradeEvent") {
        let c = coins.get(event.mint);
        if (c === undefined) {
          const at: Price = {
            q: BigInt(event.virtual_quote_reserves),
            t: BigInt(event.virtual_token_reserves),
          };
          c = {
            mint: event.mint,
            createdSlot: null,
            first: at,
            low: at,
            last: at,
            trades: 0,
            realQuote: 0n,
            complete: false,
          };
          coins.set(event.mint, c);
        }
        c.trades += 1;
        c.realQuote = BigInt(event.real_quote_reserves);
        notePrice(c, BigInt(event.virtual_quote_reserves), BigInt(event.virtual_token_reserves));
        changed.add(event.mint);
      } else {
        // CompleteEvent: the curve is done; the harness closes any position.
        const c = coins.get(event.mint);
        if (c !== undefined) c.complete = true;
        open.delete(event.mint);
      }
    }

    // Exits first: stop-loss, armed trailing stop, or max hold, per position.
    for (const [mint, holding] of state.positions) {
      if (pendingSell.has(mint)) continue;
      const pos = open.get(mint);
      if (pos === undefined) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const mark: Price = {
        q: curve.virtual_quote_reserves,
        t: curve.virtual_token_reserves,
      };
      if (mark.t === 0n) continue;
      if (priceAtLeast(mark, pos.peak, 1n, 1n)) pos.peak = mark;
      const stopped = priceAtMost(mark, pos.entry, STOP_NUM, STOP_DEN);
      const armed = priceAtLeast(pos.peak, pos.entry, TRAIL_ARM_NUM, TRAIL_ARM_DEN);
      const trailed = armed && priceAtMost(mark, pos.peak, TRAIL_NUM, TRAIL_DEN);
      const stale = batch.slot - pos.entrySlot >= MAX_HOLD_SLOTS;
      if (stopped || trailed || stale) {
        orders.push({
          side: "sell",
          mint,
          token_amount: holding.token_amount,
          max_slippage_bps: SLIPPAGE_BPS,
        });
        pendingSell.add(mint);
      }
      if (orders.length >= state.hello.caps.max_orders_per_batch) return orders;
    }

    // Buys: only coins that moved on this batch.
    // The shim only records this batch's orders after onBatch returns, so
    // count them locally against the position cap and the cash.
    let buysSent = 0;
    let spentThisBatch = 0n;
    for (const mint of changed) {
      if (orders.length >= state.hello.caps.max_orders_per_batch) break;
      if (bought.has(mint) || open.has(mint) || pendingBuy.has(mint)) continue;
      if (state.committedPositionCount() + buysSent >= state.hello.caps.max_open_positions) continue;
      const c = coins.get(mint);
      if (c === undefined || c.complete) continue;
      if (!qualifies(c, batch.slot)) continue;
      let stake = STAKE_LAMPORTS;
      const cap = state.maxBuyLamports(mint);
      if (cap < stake) stake = cap;
      if (stake < MIN_STAKE_LAMPORTS) continue;
      const txFee = state.txFeeLamports();
      if (state.freeCashLamports() - spentThisBatch < stake + txFee + CASH_RESERVE_LAMPORTS) continue;
      orders.push({
        side: "buy",
        mint,
        quote_lamports: stake,
        max_slippage_bps: SLIPPAGE_BPS,
      });
      pendingBuy.add(mint);
      buysSent += 1;
      spentThisBatch += stake + txFee;
    }

    return orders;
  },

  onDone(state: BotState): void {
    const stages = [...stageFails.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
    console.error(
      `done: cash=${state.cash} open=${state.positions.size} coins_seen=${coins.size} bought=${bought.size} failstages: ${stages}`,
    );
  },
});
