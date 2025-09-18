// src/bot.ts
import { Bot, InputFile } from "../deps.ts";
import type { Context } from "../deps.ts";
import { BOT_TOKEN, ENTRY_POINT, OPBNB_RPC_HTTP } from "../config.ts";
import {
  sessionMiddleware,
  MySession,
  readSessionByKey,
  writeSessionByKey,
} from "./state.ts";
import {
  // we keep these for filters/help/vera card UI
  manageFiltersInline,
  veraInline,
  helpInline,
  setFiltersModeInline,
  backToMenuInline,
  settingsInline,
} from "./ui/inline.ts";

import { createEncountersWatcher } from "./watcher/encountersWatcher.ts";
import { createPvpQueueWatcher } from "./watcher/pvpQueueWatcher.ts";
import { formatVeraCard } from "./format.ts";

import { QUESTS } from "./quests.ts";

// ---------- ethers + ABI for direct contract calls (quests/variation/vera)
import { ethers } from "../deps.ts";
import entryPointAbiJson from "../abi/entryPoint.json" with { type: "json" };
const entryAbi = entryPointAbiJson as unknown as ethers.InterfaceAbi;
const http = new ethers.JsonRpcProvider(OPBNB_RPC_HTTP);
const entry = new ethers.Contract(ENTRY_POINT, entryAbi, http);

/** Payload we expect from watcher when sending a card */
type VeraCardPayload = {
  veraId: bigint;
  level: number;
  speciesId: number;
  personality?: number | null;
  username?: string | null;
  innate: {
    strength: number; dexterity: number; vitality: number;
    intellect: number; wisdom: number; charisma: number;
  };
  imagePath: string;
};

const bot = new Bot<Context & { session: MySession }>(BOT_TOKEN);
bot.use(sessionMiddleware);

// robust error logging
bot.catch((err) => {
  console.error("[bot.catch]", err.error ?? err);
});

/** ---------- small helpers ---------- */

function parseNames(input: string): string[] {
  return input.normalize("NFC").split(/[,;\n\r]+/).map((s) => s.trim()).filter((s) => s.length > 0);
}

function mergeUnicode(existing: string[], additions: string[]): string[] {
  const collator = new Intl.Collator(undefined, { sensitivity: "base" });
  const out = [...existing];
  for (const name of additions) {
    const has = out.some((e) => collator.compare(e, name) === 0);
    if (!has) out.push(name);
  }
  return out;
}

function normalizeUnique(names: string[]): string[] {
  const collator = new Intl.Collator(undefined, { sensitivity: "base" });
  const out: string[] = [];
  for (const n of names) {
    const has = out.some((e) => collator.compare(e, n) === 0);
    if (!has) out.push(n);
  }
  return out;
}

/** chat id helper works for messages & callbacks */
function getChatId(ctx: Context): number {
  const id =
    (ctx.chat as any)?.id ??
    (ctx.update as any)?.callback_query?.message?.chat?.id ??
    (ctx.update as any)?.message?.chat?.id ??
    (ctx.from as any)?.id;
  if (typeof id !== "number") throw new Error("No chat id in update");
  return id;
}

/** Build main menu text */
function menuText(s: MySession): string {
  const encEnabled = !!s.prefs.enabled;
  const pvpEnabled = !!(s as any).pvpEnabled;
  const { usernames } = s.prefs;
  return [
    "⚔️ <b>Valhalla Bot</b>",
    `Encounters: ${encEnabled ? "Enabled ▶️" : "Paused ⏸️"}`,
    `PvP Queue: ${pvpEnabled ? "Enabled ▶️" : "Paused ⏸️"}`,
    `Filters: ${usernames.length ? usernames.join(", ") : "None"}`,
    "",
    "Tip: open <b>⚙️ Settings</b> to sync, set filters, or manage filters.",
    "Commands: /quests · /variation · /vera &lt;id&gt;",
  ].join("\n");
}

/** Build main menu inline keyboard (separate toggles) */
function mainMenuMarkup(encEnabled: boolean, pvpEnabled: boolean, names: string[]) {
  return {
    inline_keyboard: [
      [
        { text: encEnabled ? "⏸️ Pause Encounters" : "▶️ Enable Encounters", callback_data: "menu:toggle:enc" },
        { text: pvpEnabled ? "⏸️ Pause PvP" : "▶️ Enable PvP", callback_data: "menu:toggle:pvp" },
      ],
      [
        { text: "⚙️ Settings", callback_data: "menu:settings" },
        { text: "📊 Status", callback_data: "menu:status" },
      ],
      [
        { text: "❓ Help", callback_data: "menu:help" },
      ],
    ],
  };
}

/** Always try to edit the known menu message; if missing or fails, send a new one */
async function renderOrSendMenu(ctx: Context & { session: MySession }) {
  const chatId = getChatId(ctx);
  const text = menuText(ctx.session);
  const encEnabled = !!ctx.session.prefs.enabled;
  const pvpEnabled = !!(ctx.session as any).pvpEnabled;
  const markup = {
    parse_mode: "HTML" as const,
    reply_markup: mainMenuMarkup(encEnabled, pvpEnabled, ctx.session.prefs.usernames),
  };
  if (ctx.session.menuMsgId) {
    try {
      await bot.api.editMessageText(chatId, ctx.session.menuMsgId, text, markup);
      return;
    } catch {}
  }
  const sent = await bot.api.sendMessage(chatId, text, markup);
  ctx.session.menuMsgId = sent.message_id;
}

/** Update the persistent menu purely by chat id */
async function refreshMenuByChatId(chatId: number) {
  const s = (await readSessionByKey(String(chatId))) ?? { prefs: { enabled: false, usernames: [] } };
  const encEnabled = !!s.prefs.enabled;
  const pvpEnabled = !!(s as any).pvpEnabled;
  if (!s.menuMsgId) return;
  try {
    await bot.api.editMessageText(
      chatId,
      s.menuMsgId,
      menuText(s),
      { parse_mode: "HTML", reply_markup: mainMenuMarkup(encEnabled, pvpEnabled, s.prefs.usernames) },
    );
  } catch {}
}

/** shared Vera card sender (expects imagePath on payload) */
async function sendCard(chatId: number, payload: VeraCardPayload) {
  const caption = await formatVeraCard(payload);
  const s = await readSessionByKey(String(chatId));
  const enabled = !!s?.prefs.enabled; // controls the small toggle on the card
  try {
    await bot.api.sendPhoto(chatId, new InputFile(payload.imagePath), {
      caption, parse_mode: "HTML", reply_markup: veraInline(enabled),
    });
  } catch {
    await bot.api.sendMessage(chatId, caption, {
      parse_mode: "HTML", reply_markup: veraInline(enabled),
    });
  }
}

/** simple PvP alert sender (text only) */
async function sendAlert(chatId: number, text: string) {
  await bot.api.sendMessage(chatId, `🎮 ${text}`);
}

/** ---------- RPC helper for commands ---------- */
async function rpc<T>(fn: () => Promise<T>, label: string, tries = 5): Promise<T> {
  let delay = 220;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      const retryable = /tempor|timeout|limit|BAD_DATA|missing response|gateway|ECONN|ETIMEDOUT|JSON|fetch/i.test(msg);
      if (!retryable || i === tries - 1) { console.warn(`[bot.rpc] fail ${label}:`, msg); throw e; }
      await new Promise(r => setTimeout(r, delay + Math.floor(Math.random() * 120)));
      delay = Math.min(delay * 2, 1600);
    }
  }
  throw new Error(`rpc retries exhausted: ${label}`);
}

/** ---------- watchers ---------- */

// Encounters (filter-only)
const encounters = createEncountersWatcher({
  getSession: (chatId) => readSessionByKey(String(chatId)),
  setSession: (chatId, s) => writeSessionByKey(String(chatId), s),
  sendCard,
});

// PvP Queue (separate toggle)
const pvpQueue = createPvpQueueWatcher({
  getSession: (chatId) => readSessionByKey(String(chatId)),
  setSession: (chatId, s) => writeSessionByKey(String(chatId), s),
  sendAlert: async (chatId, text) => {
    const sent = await bot.api.sendMessage(chatId, text, { parse_mode: "HTML" });
    return sent.message_id;
  },
  deleteAlert: async (chatId, messageId) => {
    try { await bot.api.deleteMessage(chatId, messageId); } catch {}
  },
});

/** ---------- commands ---------- */

bot.command("start", async (ctx) => {
  const s = ctx.session;
  s.prefs ??= { enabled: false, usernames: [] };
  (s as any).pvpEnabled ??= false; // separate PvP toggle
  s.awaitingFilters = false;
  s.awaitingFiltersMode = undefined;
  await renderOrSendMenu(ctx);
});
bot.command("menu", renderOrSendMenu);

bot.command("reset", async (ctx) => {
  const chatId = getChatId(ctx);
  const fresh: MySession = { prefs: { enabled: false, usernames: [] } };
  (fresh as any).pvpEnabled = false;
  await writeSessionByKey(String(chatId), fresh);
  await encounters.pause(chatId);
  await pvpQueue.pause(chatId);
  await ctx.reply("Your settings were reset. Use /start to begin again.");
});

bot.command("quests", async (ctx) => {
  try {
    const res = await rpc(
      () => entry["valhalla__getActiveDailyQuests"](),
      "getActiveDailyQuests",
    );
    const ids: number[] = (Array.isArray(res) ? res : (res?.activeDailyQuestIds ?? res?.[0] ?? []))
      .map((x: any) => Number(x))
      .filter((n: number) => Number.isFinite(n));

    if (!ids.length) {
      await ctx.reply("No active daily quests right now.");
      return;
    }

    const lines = ids.map((id, i) => {
      const q = QUESTS[id];
      const desc = q?.desc ?? `Quest #${id}`;
      return `${i + 1}. ${desc}`;
    });

    await ctx.reply(`<b>Daily Quests</b>\n${lines.join("\n")}`, { parse_mode: "HTML", reply_markup: backToMenuInline() });
  } catch (e) {
    await ctx.reply(`Failed to fetch daily quests.\n<code>${(e as Error).message}</code>`, { parse_mode: "HTML", reply_markup: backToMenuInline() });
  }
});

/** /variation — show current Clan Wisp Variation ID */
bot.command("variation", async (ctx) => {
  try {
    const v = await rpc(
      () => entry["valhalla__getClanWispVariationId"](),
      "getClanWispVariationId",
    );
    const id = Number(Array.isArray(v) ? (v as any)[0] : v);
    await ctx.reply(`Current Clan Wisp Variation ID: <b>${id}</b>`, { parse_mode: "HTML", reply_markup: backToMenuInline()});
  } catch (e) {
    await ctx.reply(`Failed to fetch variation.\n<code>${(e as Error).message}</code>`, { parse_mode: "HTML", reply_markup: backToMenuInline() });
  }
});

/** /vera <id> — send Vera card for that id (no username) */
bot.command("vera", async (ctx) => {
  const text = (ctx.message?.text ?? "").trim();
  const parts = text.split(/\s+/);
  const idStr = parts.slice(1).join("").trim(); // supports "/vera    12345"
  if (!idStr || !/^\d+$/.test(idStr)) {
    await ctx.reply("Usage: <code>/vera &lt;id&gt;</code>\nExample: <code>/vera 123456</code>", { parse_mode: "HTML" });
    return;
  }
  try {
    const veraId = BigInt(idStr);
    const v = await rpc(() => entry["valhalla__getVera"](veraId), `getVera:${idStr}`);

    const innate = {
      strength: Number((v as any).innateStats?.strength ?? (v as any)[0]?.strength ?? 0),
      dexterity: Number((v as any).innateStats?.dexterity ?? (v as any)[0]?.dexterity ?? 0),
      vitality:  Number((v as any).innateStats?.vitality  ?? (v as any)[0]?.vitality  ?? 0),
      intellect: Number((v as any).innateStats?.intellect ?? (v as any)[0]?.intellect ?? 0),
      wisdom:    Number((v as any).innateStats?.wisdom    ?? (v as any)[0]?.wisdom    ?? 0),
      charisma:  Number((v as any).innateStats?.charisma  ?? (v as any)[0]?.charisma  ?? 0),
    };
    const level       = Number((v as any).level     ?? (v as any)[2] ?? 1);
    const speciesId   = Number((v as any).species   ?? (v as any)[6] ?? 0);
    const personality = (v as any).personality !== undefined
      ? Number((v as any).personality)
      : ((v as any)[7] !== undefined ? Number((v as any)[7]) : null);

    const imagePath = `assets/vera/${speciesId}.png`;

    await sendCard(getChatId(ctx), {
      veraId,
      level,
      speciesId,
      personality,
      username: null,
      innate,
      imagePath,
    });
  } catch (e) {
    await ctx.reply(`Failed to fetch Vera.\n<code>${(e as Error).message}</code>`, { parse_mode: "HTML" });
  }
});

bot.command("help", async (ctx) => {
  await ctx.reply(
    [
      "<b>Help</b>",
      "",
      "▶️/⏸️ <b>Encounters</b> — start/stop encounter notifications (filtered by usernames).",
      "▶️/⏸️ <b>PvP</b> — start/stop PvP queue alerts (no filters).",
      "",
      "Open <b>⚙️ Settings</b> to:",
      "• 🔁 <i>Sync Encounters / PvP</i> — run a one-shot check now",
      "• 🎯 <i>Set Filters</i> — add usernames for Encounters",
      "• 🧹 <i>Manage Filters</i> — remove or clear filters",
      "",
      "<b>Commands</b>",
      "• <code>/quests</code> — list today’s 3 active Daily Quests by description.",
      "• <code>/variation</code> — show the current <i>Clan Wisp Variation ID</i>.",
      "• <code>/vera &lt;id&gt;</code> — show a Vera card for that blockchain Vera ID.",
    ].join("\n"),
    { parse_mode: "HTML", reply_markup: helpInline() },
  );
});


/** ---------- simple rate-limit ---------- */
const lastHits = new Map<number, number[]>();
bot.use(async (ctx, next) => {
  const uid = (ctx.from as any)?.id as number | undefined;
  if (!uid) return next();
  const now = Date.now();
  const windowMs = 2000;
  const arr = (lastHits.get(uid) ?? []).filter((t) => now - t < windowMs);
  if (arr.length >= 3) {
    try { if ((ctx as any).answerCallbackQuery) await (ctx as any).answerCallbackQuery({ text: "Slow down 🤖", show_alert: false }); } catch {}
    return;
  }
  arr.push(now); lastHits.set(uid, arr);
  return next();
});

/** ---------- inline menu actions ---------- */

// Settings page
bot.callbackQuery("menu:settings", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply(
    [
      "<b>Settings</b>",
      "• <b>🔁 Sync Encounters / PvP</b> — run a one-shot check now",
      "• <b>🎯 Set Filters</b> — add usernames for Encounters",
      "• <b>🧹 Manage Filters</b> — remove or clear filters",
      "",
      "Use ⬅️ Back to return to the main menu.",
    ].join("\n"),
    { parse_mode: "HTML", reply_markup: settingsInline() },
  );
});

// Sync buttons now live under settings
bot.callbackQuery("settings:sync_enc", async (ctx) => {
  await ctx.answerCallbackQuery({ text: "Syncing Encounters…" });
  const chatId = getChatId(ctx);
  queueMicrotask(() => { encounters.__pollOnce?.(chatId); });
});

bot.callbackQuery("settings:sync_pvp", async (ctx) => {
  await ctx.answerCallbackQuery({ text: "Syncing PvP…" });
  const chatId = getChatId(ctx);
  queueMicrotask(() => { pvpQueue.__pollOnce?.(chatId); });
});

bot.callbackQuery("menu:help", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply(
    [
      "<b>Help</b>",
      "",
      "▶️/⏸️ <b>Encounters</b> — start/stop encounter notifications (filtered by usernames).",
      "▶️/⏸️ <b>PvP</b> — start/stop PvP queue alerts (no filters).",
      "",
      "Open <b>⚙️ Settings</b> to:",
      "• 🔁 <i>Sync Encounters / PvP</i> — run a one-shot check now",
      "• 🎯 <i>Set Filters</i> — add usernames for Encounters",
      "• 🧹 <i>Manage Filters</i> — remove or clear filters",
      "",
      "<b>Commands</b>",
      "• <code>/quests</code> — list today’s 3 active Daily Quests by description.",
      "• <code>/variation</code> — show the current <i>Clan Wisp Variation ID</i>.",
      "• <code>/vera &lt;id&gt;</code> — show a Vera card for that blockchain Vera ID.",
    ].join("\n"),
    { parse_mode: "HTML", reply_markup: helpInline() },
  );
});
bot.callbackQuery(["menu:status", "menu:back"], async (ctx) => { await ctx.answerCallbackQuery(); await renderOrSendMenu(ctx); });

/** Encounters toggle (with filter-only enable guard) */
bot.callbackQuery("menu:toggle:enc", async (ctx) => {
  const chatId = getChatId(ctx);
  const s = (await readSessionByKey(String(chatId))) ?? { prefs: { enabled: false, usernames: [] } };

  // Guard: require at least one filter to enable encounters
  if (!s.prefs.enabled && s.prefs.usernames.length === 0) {
    await ctx.answerCallbackQuery({ text: "Add at least one filter first.", show_alert: true });
    await ctx.reply("You need at least one username filter before enabling Encounters.\nUse “🎯 Set Filters”.", { reply_markup: backToMenuInline() });
    return;
  }

  const next = !s.prefs.enabled;
  s.prefs.enabled = next;
  await writeSessionByKey(String(chatId), s);

  await ctx.answerCallbackQuery({ text: next ? "Encounters Enabled ✅" : "Encounters Paused ⏸️" });

  queueMicrotask(() => {
    if (next) encounters.enable(chatId, s);
    else encounters.pause(chatId);
  });

  await refreshMenuByChatId(chatId);
});

/** PvP toggle */
bot.callbackQuery("menu:toggle:pvp", async (ctx) => {
  const chatId = getChatId(ctx);
  const s = (await readSessionByKey(String(chatId))) ?? { prefs: { enabled: false, usernames: [] } };
  const cur = !!(s as any).pvpEnabled;
  (s as any).pvpEnabled = !cur;
  await writeSessionByKey(String(chatId), s);

  await ctx.answerCallbackQuery({ text: !cur ? "PvP Alerts Enabled ✅" : "PvP Alerts Paused ⏸️" });

  queueMicrotask(() => {
    if (!cur) pvpQueue.enable(chatId, s);
    else pvpQueue.pause(chatId);
  });

  await refreshMenuByChatId(chatId);
});

/** Filters */
bot.callbackQuery("menu:set_filters", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply("<b>Filters</b>\nChoose how you want to input names:", { parse_mode: "HTML", reply_markup: setFiltersModeInline() });
});

bot.callbackQuery("menu:manage", async (ctx) => {
  await ctx.answerCallbackQuery();
  const s = (await readSessionByKey(String(getChatId(ctx)))) ?? { prefs: { enabled: false, usernames: [] } };
  const names = s.prefs.usernames;
  const txt = names.length ? "<b>Filters</b> — tap to remove, or Clear all." : "No filters set.";
  await ctx.reply(txt, { parse_mode: "HTML", reply_markup: manageFiltersInline(names) });
});

/** filters flow */
bot.callbackQuery("filters:add", async (ctx) => {
  await ctx.answerCallbackQuery();
  const s = ctx.session;
  s.awaitingFilters = true; s.awaitingFiltersMode = "add";
  const current = s.prefs.usernames;
  await ctx.reply(
    [
      "Send username(s) to <b>add</b>, comma/newline-separated.",
      "Example:  mango, 龙战士",
      current.length ? `Current: ${current.join(", ")}` : "Current: (none)",
    ].join("\n"),
    { parse_mode: "HTML" },
  );
});

bot.callbackQuery("filters:replace", async (ctx) => {
  await ctx.answerCallbackQuery();
  const s = ctx.session;
  s.awaitingFilters = true; s.awaitingFiltersMode = "replace";
  const current = s.prefs.usernames;
  await ctx.reply(
    [
      "Send username(s) to <b>replace</b> all existing filters, comma/newline-separated.",
      "Example:  odin, 旺财",
      current.length ? `Current: ${current.join(", ")}` : "Current: (none)",
    ].join("\n"),
    { parse_mode: "HTML" },
  );
});

bot.callbackQuery(/^filter:del:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const name = decodeURIComponent(ctx.match![1]);
  const chatId = (ctx.chat as any)?.id ?? (ctx.update as any)?.callback_query?.message?.chat?.id;
  const s = (await readSessionByKey(String(chatId))) ?? { prefs: { enabled: false, usernames: [] } };

  s.prefs.usernames = s.prefs.usernames.filter((u) => u !== name);

  // AUTO-PAUSE if no filters remain and Encounters is on
  if (s.prefs.enabled && s.prefs.usernames.length === 0) {
    s.prefs.enabled = false;
    queueMicrotask(() => { encounters.pause(chatId); });
  }

  await writeSessionByKey(String(chatId), s);
  await refreshMenuByChatId(chatId);

  const pausedNote = (!s.prefs.enabled && s.prefs.usernames.length === 0)
    ? "\n\nEncounters auto-paused (no filters)."
    : "";

  await ctx.reply(`Removed filter: ${name}${pausedNote}`, { reply_markup: backToMenuInline() });
});

bot.callbackQuery("filter:clear", async (ctx) => {
  await ctx.answerCallbackQuery({ text: "Cleared" });
  const chatId = (ctx.chat as any)?.id ?? (ctx.update as any)?.callback_query?.message?.chat?.id;
  const s = (await readSessionByKey(String(chatId))) ?? { prefs: { enabled: false, usernames: [] } };

  s.prefs.usernames = [];

  // AUTO-PAUSE if Encounters is on
  if (s.prefs.enabled) {
    s.prefs.enabled = false;
    queueMicrotask(() => { encounters.pause(chatId); });
  }

  await writeSessionByKey(String(chatId), s);
  await refreshMenuByChatId(chatId);
  await ctx.reply("Cleared all filters.\n\nEncounters auto-paused (no filters).", { reply_markup: backToMenuInline() });
});

/** consume the user’s text when we’re awaiting filters */
bot.on("message:text", async (ctx, next) => {
  if (ctx.session.awaitingFilters) {
    const mode = ctx.session.awaitingFiltersMode ?? "replace";
    ctx.session.awaitingFilters = false; ctx.session.awaitingFiltersMode = undefined;

    const incoming = parseNames(ctx.message.text);
    if (mode === "add") {
      ctx.session.prefs.usernames = mergeUnicode(ctx.session.prefs.usernames, incoming);
      await writeSessionByKey(String(getChatId(ctx)), ctx.session);
      await renderOrSendMenu(ctx);
      await ctx.reply(
        incoming.length
          ? `Added: ${incoming.join(", ")}\nNow: ${ctx.session.prefs.usernames.join(", ")}`
          : "No names provided. Current filters unchanged.",
        { reply_markup: backToMenuInline() },
      );
    } else {
      ctx.session.prefs.usernames = normalizeUnique(incoming);

      // AUTO-PAUSE if replacing to empty while Encounters enabled
      let note = "";
      const chatId = getChatId(ctx);
      const cur = (await readSessionByKey(String(chatId))) ?? { prefs: { enabled: false, usernames: [] } };
      if (cur.prefs.enabled && ctx.session.prefs.usernames.length === 0) {
        cur.prefs.enabled = false;
        await writeSessionByKey(String(chatId), cur);
        queueMicrotask(() => { encounters.pause(chatId); });
        note = "\n\nEncounters auto-paused (no filters).";
      } else {
        await writeSessionByKey(String(chatId), ctx.session);
      }

      await renderOrSendMenu(ctx);
      await ctx.reply(
        incoming.length
          ? `Replaced. Now: ${ctx.session.prefs.usernames.join(", ")}`
          : "Cleared all filters." + note,
        { reply_markup: backToMenuInline() },
      );
    }
    return;
  }
  await next();
});

/** Vera card mini-toggle on the card (kept from your previous flow) */
bot.callbackQuery("vera:toggle", async (ctx) => {
  const chatId = getChatId(ctx);
  const s = (await readSessionByKey(String(chatId))) ?? { prefs: { enabled: false, usernames: [] } };

  // Guard here too: at least one filter before enabling via card button
  if (!s.prefs.enabled && s.prefs.usernames.length === 0) {
    await ctx.answerCallbackQuery({ text: "Add at least one filter first.", show_alert: true });
    return;
  }

  s.prefs.enabled = !s.prefs.enabled;
  await writeSessionByKey(String(chatId), s);

  await ctx.answerCallbackQuery({ text: s.prefs.enabled ? "Encounters Enabled ✅" : "Encounters Paused ⏸️" });

  queueMicrotask(() => {
    if (s.prefs.enabled) encounters.enable(chatId, s);
    else encounters.pause(chatId);
  });

  try { await ctx.editMessageReplyMarkup({ reply_markup: veraInline(s.prefs.enabled) }); } catch {}
  await refreshMenuByChatId(chatId);
});

bot.callbackQuery("vera:menu", async (ctx) => { await ctx.answerCallbackQuery(); await renderOrSendMenu(ctx); });

export default bot;