# makefun-pump-fun-replay

[![make.fun · u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3](https://make.fun/badge/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3.svg)](https://make.fun/bounty/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3?utm_source=github&utm_medium=readme&utm_campaign=u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3)
[![rank](https://make.fun/badge/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3/h05meigames/makefun-pump-fun-replay/rank.svg)](https://make.fun/bounty/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3)
[![reward](https://make.fun/badge/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3/h05meigames/makefun-pump-fun-replay/reward.svg)](https://make.fun/bounty/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3?utm_source=github&utm_medium=readme&utm_campaign=u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3)

Breakout Scalper — a paper-trading bot for the make.fun bounty
[Winner Takes All — $5 Pump.fun Replay Sprint](https://make.fun/bounty/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3).
It trades 10 SOL of virtual money on a replay of pump.fun bonding-curve
chain data. Nothing here trades for real: no real funds, no on-chain
transactions, no paid APIs.

## Strategy

Buy breakouts small, bank small wins fast, never hold long:

- **Entry:** a curve at a fresh high over its 40-slot window, up across the
  window, with net SOL flowing in and buy volume spiking in the newer half
  of the window — and no single wallet dominating the coin's lifetime net
  SOL.
- **Size:** 0.05 SOL first buy, one 0.05 SOL add on a further leg up
  (0.10 SOL max per position, 5 positions max).
- **Exit:** take-profit +10%, stop-loss −6%, a loose trailing stop once up
  5%, or 300 slots max hold. A curve that completes is closed by the replay.
- **Guardrails:** every position is ≥ 0.05 SOL, so each round trip clears
  the 0.01 SOL bar; a tiny 0.02 SOL probe pacer keeps the run on pace for
  25 coins / 120 fills over a 6-hour window.

Why this shape: on the kit's dev window, buying dips caught falling knives
and holding breakouts for big wins bled on stop-losses, while the
catastrophic losses were one-slot rug cascades (dozens of wallets dumping
in a single slot — no stop-loss can escape through 2 slots of latency).
Short holds and small stakes are the only defence: a rug costs one small
position, not the run. See `strategy.ts` for the full reasoning and the
numbers behind it.

Deterministic: no clock, no environment, no randomness, so two executions
of the same run produce the same action log.

## Run it

```sh
node main.ts
```

The grader runs `node /bot/main.ts` with this directory mounted at `/bot`
(Node 22, no build, no install — the SDK shim is vendored at
`vendor/makefun-bot.ts`).

## Test it locally

`tools/sim.ts` is a small, dependency-free replay of the kit's dev dataset
(it is a test tool, not part of the graded entry):

```sh
node tools/sim.ts <kit-dir> [seed] [Param=value ...]
```

On the dev window (seed 42): net PnL **−0.337 SOL** over 464 fills,
130 distinct mints, 130 round trips ≥ 0.01 SOL, max drawdown 3.4% —
guardrails pass, but the dev window is a net loser for this strategy, so
treat the result as a baseline to improve on, not a promise. The full
report is `tools/sim-report.json`
(sha256 `80c347f5cffe8140648fc3bf7164d8c1484d975ebb63dfd2d48a9800ac89c9ef`).

## Layout

- `main.ts` — entrypoint (`node /bot/main.ts`).
- `strategy.ts` — the Breakout Scalper strategy.
- `vendor/makefun-bot.ts` — the kit's `agent-fun/replay/v2` bot shim,
  copied byte for byte as the kit instructs.
- `tools/sim.ts` — local replay tester + `tools/sim-report.json`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=0ene8b3q&utm_source=github&utm_medium=readme&utm_campaign=u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3) · referral: https://make.fun/r/0ene8b3q</sub>
