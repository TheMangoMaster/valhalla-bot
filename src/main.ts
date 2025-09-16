/// <reference lib="deno.unstable" />

import bot from "./bot.ts";

import { BOT_TOKEN, OPBNB_RPC_HTTP, OPBNB_RPC_WS } from "../config.ts";

console.log("[boot] Using Telegram token length:", (BOT_TOKEN?.length ?? 0));
console.log("[boot] HTTP RPC:", OPBNB_RPC_HTTP || "(none)");
console.log("[boot] WS RPC:", OPBNB_RPC_WS ? OPBNB_RPC_WS : "(none)");

/** Lightweight request logger (no external deps) */
bot.use(async (ctx, next) => {
  const t0 = Date.now();
  const kind =
    (ctx.update.message?.text && "message") ||
    (ctx.update.callback_query?.data && "callback_query") ||
    (ctx.update.inline_query && "inline_query") ||
    Object.keys(ctx.update)[0];

  const desc =
    ctx.update.message?.text ??
    ctx.update.callback_query?.data ??
    "";

  console.log(
    `[${new Date().toISOString()}] <- ${kind} ${ctx.update.update_id} ${desc}`,
  );

  try {
    await next();
    console.log(
      `[${new Date().toISOString()}] -> handled in ${Date.now() - t0}ms`,
    );
  } catch (err) {
    console.error(`[${new Date().toISOString()}] !! error`, err);
    throw err;
  }
});

/** Global error handler (so errors don’t crash the process silently) */
bot.catch((err) => {
  console.error(`[${new Date().toISOString()}] bot.catch`, err);
});

await bot.start();
console.log("Valhalla bot is running ⚔️  (logging enabled)");