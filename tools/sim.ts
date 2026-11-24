// Local replay tester for the Dip-and-Ride bot. NOT part of the graded entry:
// the grader runs its own engine. This is a small, dependency-free,
// deterministic replay of the kit's dev dataset, written to check the bot
// behaves (trades, respects caps, stays above the guardrails) before submit.
//
//   node tools/sim.ts <kit-dir> [seed]
//
// Market model (constant-product bonding curve, as the harness documents):
// - batches group the dataset's events by slot; orders decided on slot s
//   fill at slot s + 2 (latency_slots), against the curve's reserves at the
//   fill slot, after that slot's recorded trades.
// - buy of S lamports: curve fees 95 protocol + 30 creator bps are taken
//   from S; the rest buys tokens at the constant-product price.
// - sell of T tokens: quote out is T * vq / (vt + T), minus the same fees.
// - every order pays base + priority tx fees (5,000 + 100,000 lamports),
//   even when its transaction fails; 2% of transactions fail, decided by a
//   seeded splitmix64 hash of (seed, seq, order index) — no Math.random.
// - a CompleteEvent force-closes the position at the final reserves; at the
//   end of the data every remaining position is flattened the same way.
// - the bot's own trades move the reserves, like the real replay.
//
// Output: a JSON summary (net PnL, fills, distinct mints, round trips >=
// 0.01 SOL, max drawdown, top coins) printed to stdout.

import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { BotState, type Batch, type Fill, type Hello, type Order } from '../vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from '../strategy.ts';

const BPS = 10_000n;
const LAMPORTS_PER_SOL = 1_000_000_000n;
const MASK = (1n << 64n) - 1n;

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
const feeOf = (amount: bigint, bps: bigint) => ceilDiv(amount * bps, BPS);

function splitmix64(z0: bigint): bigint {
  let z = (z0 + 0x9e3779b97f4a7c15n) & MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK;
  return z ^ (z >> 31n);
}

interface CurveState {
  vq: bigint;
  vt: bigint;
  rq: bigint;
  rt: bigint;
  complete: boolean;
}

interface Pending {
  order: Order;
  seq: number;
  index: number;
  decidedSlot: number;
  fillSlot: number;
  reject: string | null;
  decisionRq: bigint;
}

function loadEvents(kit: string): any[] {
  const manifest = JSON.parse(readFileSync(`${kit}/dataset/manifest.json`, 'utf8'));
  const { modulus, residue } = manifest.universe.sample;
  const excluded = new Set<string>(manifest.excluded_mints ?? []);
  const members = new Set<string>();
  const events: any[] = [];
  for (let part = 0; part < 3; part++) {
    const raw = gunzipSync(
      readFileSync(`${kit}/dataset/events/part-0000${part}.ndjson.gz`),
    ).toString('utf8');
    for (const line of raw.split('\n')) {
      if (line.length === 0) continue;
      const e = JSON.parse(line);
      if (e.event === 'CreateEvent' && !members.has(e.mint)) {
        const h = BigInt('0x' + createHash('sha256').update(e.mint, 'utf8').digest('hex'));
        if (
          e.quote_mint === '11111111111111111111111111111111' &&
          !e.is_mayhem_mode &&
          !e.is_cashback_enabled &&
          !excluded.has(e.mint) &&
          h % BigInt(modulus) === BigInt(residue)
        ) {
          members.add(e.mint);
        }
      }
      if (members.has(e.mint)) events.push(e);
    }
  }
  return events;
}

function main(): void {
  const kit = process.argv[2];
  if (!kit) {
    console.error('usage: node tools/sim.ts <kit-dir> [seed]');
    process.exit(2);
  }
  const seed = BigInt(process.argv[3] ?? '42');
  const overrides: Record<string, number> = {};
  for (const arg of process.argv.slice(4)) {
    const m = arg.match(/^([A-Za-z]+)=(.+)$/);
    if (m) overrides[m[1]!] = Number(m[2]);
  }
  const events = loadEvents(kit);
  const batches: { slot: number; events: any[] }[] = [];
  for (const e of events) {
    const tail = batches[batches.length - 1];
    if (tail !== undefined && tail.slot === e.slot) tail.events.push(e);
    else batches.push({ slot: e.slot, events: [e] });
  }
  const manifest = JSON.parse(readFileSync(`${kit}/dataset/manifest.json`, 'utf8'));
  const endSlot: number = manifest.window?.end_slot ?? batches[batches.length - 1]!.slot;

  const hello: Hello = {
    type: 'hello',
    protocol: 'agent-fun/replay/v2',
    seed: seed.toString(),
    universe: {
      program: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
      quote: 'SOL',
      mayhem: 'excluded',
      exclude_cashback: true,
      sample: { hash: 'sha256', modulus: 16, residue: 15 },
    },
    capital: { lamports: '10000000000' },
    caps: { max_open_positions: 5, max_order_bps_of_real_reserve: 100, max_orders_per_batch: 16, shorts: false, leverage: false },
    latency_slots: 2,
    fees: { protocol_bps_fallback: 95, creator_bps_fallback: 30, base_fee_lamports: '5000', priority_fee_lamports: '100000', failed_tx_bps: 200 },
  };
  const TX_FEE = 105_000n;
  const startCash = 10_000_000_000n;

  const curves = new Map<string, CurveState>();
  const positions = new Map<string, { tokens: bigint; cost: bigint }>();
  let cash = startCash;
  const pending: Pending[] = [];
  const usedIds = new Set<string>();
  const undelivered: Fill[] = [];
  const perMint = new Map<string, { pnl: bigint; buys: bigint; sells: number; bought: bigint }>();
  let fills = 0;
  let rejected = 0;
  let failed = 0;
  const rejectReasons = new Map<string, number>();
  let peakEquity = startCash;
  let maxDd = 0n;
  let seq = 0;

  const account = () => ({
    cash_lamports: cash.toString(),
    positions: [...positions.entries()]
      .filter(([, p]) => p.tokens > 0n)
      .map(([mint, p]) => ({ mint, token_amount: p.tokens.toString(), cost_lamports: p.cost.toString() })),
  });

  const markValue = (mint: string): bigint => {
    const pos = positions.get(mint);
    const c = curves.get(mint);
    if (!pos || !c || c.vt === 0n) return 0n;
    const q = (pos.tokens * c.vq) / (c.vt + pos.tokens);
    const proceeds = q - feeOf(q, 95n) - feeOf(q, 30n);
    return proceeds > TX_FEE ? proceeds - TX_FEE : 0n;
  };

  const equityNow = (): bigint => {
    let eq = cash;
    for (const mint of positions.keys()) eq += markValue(mint);
    return eq;
  };

  const trackEquity = () => {
    const eq = equityNow();
    if (eq > peakEquity) peakEquity = eq;
    const dd = peakEquity - eq;
    if (dd > maxDd) maxDd = dd;
  };

  const mintStats = (mint: string) => {
    let s = perMint.get(mint);
    if (!s) {
      s = { pnl: 0n, buys: 0n, sells: 0, bought: 0n };
      perMint.set(mint, s);
    }
    return s;
  };

  const forceClose = (mint: string, kind: string) => {
    const pos = positions.get(mint);
    if (!pos) return;
    const value = markValue(mint);
    cash += value;
    const s = mintStats(mint);
    s.pnl += value - pos.cost;
    s.sells++;
    positions.delete(mint);
    undelivered.push({
      client_id: `_${kind}_${seq}`,
      mint,
      side: 'sell',
      status: 'filled',
      reason: null,
      decided_slot: 0,
      slot: 0,
      quote_lamports: value.toString(),
      token_amount: pos.tokens.toString(),
      fee_lamports: '0',
      tx_fee_lamports: '0',
      fee_fallback: false,
    });
  };

  const resolve = (p: Pending, curSlot: number) => {
    const m = curves.get(p.order.mint);
    const base: Fill = {
      client_id: p.order.client_id,
      mint: p.order.mint,
      side: p.order.side,
      status: 'filled',
      reason: null,
      decided_slot: p.decidedSlot,
      slot: curSlot,
      quote_lamports: '0',
      token_amount: '0',
      fee_lamports: '0',
      tx_fee_lamports: TX_FEE.toString(),
      fee_fallback: false,
    };
    if (p.reject !== null) {
      base.status = 'rejected';
      base.reason = p.reject as Fill['reason'];
      base.tx_fee_lamports = '0';
      rejected++;
      rejectReasons.set(p.reject, (rejectReasons.get(p.reject) ?? 0) + 1);
      undelivered.push(base);
      return;
    }
    // Deterministic failed-transaction draw (2% of orders).
    const draw = splitmix64(seed ^ (BigInt(p.seq) << 32n) ^ BigInt(p.index) ^ 0x6661696c65642d74n) % 10_000n;
    if (draw < 200n) {
      cash -= TX_FEE;
      base.status = 'failed';
      failed++;
      undelivered.push(base);
      return;
    }
    if (!m || m.complete) {
      base.status = 'rejected';
      base.reason = 'token_complete';
      base.tx_fee_lamports = '0';
      rejected++;
      rejectReasons.set('token_complete', (rejectReasons.get('token_complete') ?? 0) + 1);
      undelivered.push(base);
      return;
    }
    const s = mintStats(p.order.mint);
    if (p.order.side === 'buy') {
      const spend = BigInt(p.order.quote_lamports);
      if (spend > cash) {
        base.status = 'rejected';
        base.reason = 'insufficient_cash';
        base.tx_fee_lamports = '0';
        rejected++;
        rejectReasons.set('insufficient_cash', (rejectReasons.get('insufficient_cash') ?? 0) + 1);
        undelivered.push(base);
        return;
      }
      const net0 = (spend * BPS) / (BPS + 95n + 30n);
      let fee = feeOf(net0, 95n);
      let creatorFee = feeOf(net0, 30n);
      const q0 = net0 - (net0 + fee + creatorFee > spend ? net0 + fee + creatorFee - spend : 0n);
      let tokens = q0 <= 1n ? 0n : ((q0 - 1n) * m.vt) / (m.vq + q0 - 1n);
      let paid = q0 + fee + creatorFee;
      if (tokens > m.rt) {
        tokens = m.rt;
        if (tokens === 0n) {
          base.status = 'rejected';
          base.reason = 'zero_amount';
          base.tx_fee_lamports = '0';
          rejected++;
          rejectReasons.set('zero_amount', (rejectReasons.get('zero_amount') ?? 0) + 1);
          undelivered.push(base);
          return;
        }
        const q = (tokens * m.vq) / (m.vt - tokens) + 1n;
        fee = feeOf(q, 95n);
        creatorFee = feeOf(q, 30n);
        paid = q + fee + creatorFee;
      }
      cash -= paid + TX_FEE;
      m.vq += q0 <= 1n ? 0n : paid - fee - creatorFee;
      m.vt -= tokens;
      m.rq += paid - fee - creatorFee;
      m.rt -= tokens;
      const pos = positions.get(p.order.mint) ?? { tokens: 0n, cost: 0n };
      pos.tokens += tokens;
      pos.cost += paid + TX_FEE;
      positions.set(p.order.mint, pos);
      s.buys += paid;
      s.bought += tokens;
      base.quote_lamports = paid.toString();
      base.token_amount = tokens.toString();
      base.fee_lamports = (fee + creatorFee).toString();
      fills++;
      undelivered.push(base);
    } else {
      const want = BigInt(p.order.token_amount);
      const pos = positions.get(p.order.mint);
      if (!pos || pos.tokens === 0n) {
        base.status = 'rejected';
        base.reason = 'insufficient_tokens';
        base.tx_fee_lamports = '0';
        rejected++;
        rejectReasons.set('insufficient_tokens', (rejectReasons.get('insufficient_tokens') ?? 0) + 1);
        undelivered.push(base);
        return;
      }
      const t = want > pos.tokens ? pos.tokens : want;
      const q = (t * m.vq) / (m.vt + t);
      const proceeds = q - feeOf(q, 95n) - feeOf(q, 30n);
      cash -= TX_FEE;
      cash += proceeds > 0n ? proceeds : 0n;
      m.vq -= q;
      m.vt += t;
      m.rq -= q;
      m.rt += t;
      const costShare = (pos.cost * t) / pos.tokens;
      s.pnl += proceeds - costShare - TX_FEE;
      pos.tokens -= t;
      pos.cost -= costShare;
      if (pos.tokens === 0n) positions.delete(p.order.mint);
      s.sells++;
      base.quote_lamports = (proceeds > 0n ? proceeds : 0n).toString();
      base.token_amount = t.toString();
      base.fee_lamports = (feeOf(q, 95n) + feeOf(q, 30n)).toString();
      fills++;
      undelivered.push(base);
    }
  };

  const bot = createStrategy({ ...DEFAULT_PARAMS, ...overrides });
  const state = new BotState(hello);
  bot.onHello?.(state);

  for (const b of batches) {
    const x = b.slot;
    while (pending.length > 0 && pending[0]!.fillSlot < x) {
      const p0 = pending.shift()!;
      resolve(p0, p0.fillSlot);
    }
    const completed: string[] = [];
    for (const e of b.events) {
      if (e.event === 'CreateEvent') {
        curves.set(e.mint, {
          vq: BigInt(e.virtual_quote_reserves),
          vt: BigInt(e.virtual_token_reserves),
          rq: 0n,
          rt: BigInt(e.real_token_reserves),
          complete: false,
        });
      } else if (e.event === 'TradeEvent') {
        const m = curves.get(e.mint);
        if (m) {
          m.vq = BigInt(e.virtual_quote_reserves);
          m.vt = BigInt(e.virtual_token_reserves);
          m.rq = BigInt(e.real_quote_reserves);
          m.rt = BigInt(e.real_token_reserves);
        }
      } else if (e.event === 'CompleteEvent') {
        const m = curves.get(e.mint);
        if (m) m.complete = true;
        completed.push(e.mint);
      }
    }
    for (const mint of completed) if (positions.has(mint)) forceClose(mint, 'complete');
    while (pending.length > 0 && pending[0]!.fillSlot === x) resolve(pending.shift()!, x);
    const heldMints = new Set<string>([...positions.keys(), ...pending.map((p) => p.order.mint)]);
    const marks = [...heldMints].map((mint) => {
      const c = curves.get(mint)!;
      return {
        mint,
        slot: x,
        virtual_token_reserves: c.vt.toString(),
        virtual_quote_reserves: c.vq.toString(),
        real_token_reserves: c.rt.toString(),
        real_quote_reserves: c.rq.toString(),
      };
    });
    const batch: Batch = { type: 'batch', seq, slot: x, events: b.events, marks, fills: undelivered.splice(0), account: account() };
    const traceMint = process.env.TRACE_MINT;
    if (traceMint) {
      for (const f of batch.fills) if (f.mint === traceMint) console.error(`slot ${x} FILL ${f.side} ${f.status} ${f.reason ?? ''} quote=${f.quote_lamports} tokens=${f.token_amount}`);
      const tp = positions.get(traceMint);
      if (tp) {
        const c = curves.get(traceMint)!;
        const q = (tp.tokens * c.vq) / (c.vt + tp.tokens);
        console.error(`slot ${x} HELD tokens=${tp.tokens} cost=${tp.cost} markSol=${Number(q) / 1e9} rq=${Number(c.rq) / 1e9} complete=${c.complete}`);
      }
    }
    trackEquity();
    state.applyBatch(batch);
    const orders = state.toOrders(bot.onBatch(state, batch) as any);
    state.recordOrders(orders);
    orders.forEach((order, index) => {
      let reject: string | null = null;
      const amount = order.side === 'buy' ? order.quote_lamports : order.token_amount;
      if (index >= hello.caps.max_orders_per_batch) reject = 'max_orders_per_batch';
      else if (usedIds.has(order.client_id)) reject = 'duplicate_client_id';
      else if (amount === '0') reject = 'zero_amount';
      else if (!curves.has(order.mint)) reject = 'not_in_universe';
      else if (order.side === 'buy') {
        const m = curves.get(order.mint)!;
        const capAmt = (m.rq * 100n) / BPS;
        // Sum of this reply's buys on the same mint must stay under the cap.
        let sameMint = BigInt(order.quote_lamports);
        for (let j = 0; j < index; j++) {
          if (orders[j]!.side === 'buy' && orders[j]!.mint === order.mint) sameMint += BigInt((orders[j] as any).quote_lamports);
        }
        if (sameMint > capAmt) reject = 'max_order_size';
      }
      usedIds.add(order.client_id);
      const m = curves.get(order.mint);
      pending.push({
        order,
        seq,
        index,
        decidedSlot: x,
        fillSlot: x + hello.latency_slots,
        reject,
        decisionRq: m ? m.rq : 0n,
      });
    });
    seq++;
  }
  while (pending.length > 0) {
    const p = pending.shift()!;
    if (p.fillSlot > endSlot) {
      p.reject = 'after_end';
      resolve(p, endSlot);
    } else resolve(p, p.fillSlot);
  }
  for (const mint of [...positions.keys()].sort()) forceClose(mint, 'flatten');
  trackEquity();

  const netPnl = cash - startCash;
  let roundTrips = 0;
  for (const s of perMint.values()) {
    if (s.buys >= 10_000_000n && s.sells >= 1) roundTrips++;
  }
  const top = [...perMint.entries()]
    .sort((a, b) => (b[1].pnl > a[1].pnl ? 1 : -1))
    .slice(0, 3)
    .map(([mint, s]) => ({ mint: mint.slice(0, 8), pnl_sol: Number(s.pnl) / 1e9 }));
  const bottom = [...perMint.entries()]
    .sort((a, b) => (a[1].pnl > b[1].pnl ? 1 : -1))
    .slice(0, 10)
    .map(([mint, s]) => ({ mint: mint.slice(0, 8), pnl_sol: Number(s.pnl) / 1e9, buys_sol: Number(s.buys) / 1e9, sells: s.sells }));
  const summary = {
    seed: seed.toString(),
    batches: batches.length,
    events: events.length,
    net_pnl_sol: Number(netPnl) / 1e9,
    net_pnl_lamports: netPnl.toString(),
    fills,
    rejected,
    failed,
    distinct_mints_traded: perMint.size,
    round_trips_min_0_01_sol: roundTrips,
    max_drawdown_sol: Number(maxDd) / 1e9,
    max_drawdown_pct: Number(maxDd) / Number(peakEquity),
    final_cash_sol: Number(cash) / 1e9,
    guardrails: {
      min_distinct_mints: 20,
      max_drawdown: 0.5,
      pass: roundTrips >= 20 && Number(maxDd) / Number(peakEquity) <= 0.5,
    },
    strategy_stats: bot.stats,
    overrides,
    top_coins: top,
    bottom_coins: bottom,
    reject_reasons: Object.fromEntries(rejectReasons),
  };
  console.log(JSON.stringify(summary, null, 2));
  writeFileSync(new URL('./sim-report.json', import.meta.url), JSON.stringify(summary, null, 2));
}

main();
