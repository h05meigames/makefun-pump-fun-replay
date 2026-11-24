// Breakout Scalper: a pump.fun replay bot for the make.fun bounty
// "Winner Takes All — $5 Pump.fun Replay Sprint".
// Paper trading only: 10 SOL of virtual money on recorded chain data. Buys breakouts small, banks +12% fast, never holds more than 300 slots.
// Nothing here trades for real.
//
// The grader runs `node /bot/main.ts` with this directory mounted at /bot.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
