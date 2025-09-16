// src/bot.ts
import { Bot, InputFile } from "../deps.ts";
import type { Context } from "../deps.ts";
import { BOT_TOKEN } from "../config.ts";
import {
  sessionMiddleware,
  MySession,
  readSessionByKey,
  writeSessionByKey,
} from "./state.ts";
import {
  mainMenuInline,
  manageFiltersInline,
  veraInline,
  helpInline,
  setFiltersModeInline,
  backToMenuInline,
} from "./ui/inline.ts";
import { createMintsWatcher } from "./watcher/mintsWatcher.ts";
import { formatVeraCard } from "./format.ts";

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

function menuText(s: MySession): string {
  const { enabled, usernames } = s.prefs;
  return [
    "⚔️ <b>Valhalla Mints</b>",
    `Status: ${enabled ? "Enabled ▶️" : "Paused ⏸️"}`,
    `Filters: ${usernames.length ? usernames.join(", ") : "None"}`,
  ].join("\n");
}

/** Always try to edit the known menu message; if missing or fails, send a new one */
async function renderOrSendMenu(ctx: Context & { session: MySession }) {
  const chatId = getChatId(ctx);
  const text = menuText(ctx.session);
  const markup = {
    parse_mode: "HTML" as const,
    reply_markup: mainMenuInline(ctx.session.prefs.enabled, ctx.session.prefs.usernames),
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
  if (!s.menuMsgId) return;
  try {
    await bot.api.editMessageText(
      chatId,
      s.menuMsgId,
      menuText(s),
      { parse_mode: "HTML", reply_markup: mainMenuInline(s.prefs.enabled, s.prefs.usernames) },
    );
  } catch {}
}

/** shared card sender (expects imagePath on payload) */
async function sendCard(chatId: number, payload: VeraCardPayload) {
  const caption = await formatVeraCard(payload);
  const s = await readSessionByKey(String(chatId));
  const enabled = !!s?.prefs.enabled;
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

// single watcher: mints only
const mints = createMintsWatcher({
  getSession: (chatId) => readSessionByKey(String(chatId)),
  setSession: (chatId, s) => writeSessionByKey(String(chatId), s),
  sendCard,
});

// commands
bot.command("start", async (ctx) => {
  const s = ctx.session;
  s.prefs ??= { enabled: false, usernames: [] };
  s.awaitingFilters = false;
  s.awaitingFiltersMode = undefined;
  await renderOrSendMenu(ctx);
});
bot.command("menu", renderOrSendMenu);

bot.command("reset", async (ctx) => {
  const chatId = getChatId(ctx);
  const fresh: MySession = { prefs: { enabled: false, usernames: [] } };
  await writeSessionByKey(String(chatId), fresh);
  await mints.pause(chatId);
  await ctx.reply("Your settings were reset. Use /start to begin again.");
});

// simple rate-limit
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

// inline menu
bot.callbackQuery("menu:help", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply(
    [
      "<b>Help</b>",
      "▶️ Enable / ⏸️ Pause — start/stop mint notifications.",
      "🎯 Set Filters — type comma-separated usernames; Unicode supported.",
      "🧹 Manage Filters — remove or clear filters.",
      "📊 Status — shows current state.",
    ].join("\n"),
    { parse_mode: "HTML", reply_markup: helpInline() },
  );
});
bot.callbackQuery(["menu:status", "menu:back"], async (ctx) => { await ctx.answerCallbackQuery(); await renderOrSendMenu(ctx); });

// toggle enable/pause
bot.callbackQuery("menu:toggle", async (ctx) => {
  const chatId = getChatId(ctx);
  const s = (await readSessionByKey(String(chatId))) ?? { prefs: { enabled: false, usernames: [] } };
  const next = !s.prefs.enabled;
  s.prefs.enabled = next;
  await writeSessionByKey(String(chatId), s);

  await ctx.answerCallbackQuery({ text: next ? "Enabled ✅" : "Paused ⏸️" });

  queueMicrotask(() => {
    if (next) mints.enable(chatId, s);
    else mints.pause(chatId);
  });

  await refreshMenuByChatId(chatId);
});

bot.callbackQuery("menu:sync", async (ctx) => {
  await ctx.answerCallbackQuery({ text: "Syncing…" });
  const chatId = getChatId(ctx);
  queueMicrotask(() => { mints.__pollOnce?.(chatId); });
});

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

// filters flow
bot.callbackQuery("filters:add", async (ctx) => {
  await ctx.answerCallbackQuery();
  const s = ctx.session;
  s.awaitingFilters = true; s.awaitingFiltersMode = "add";
  const current = s.prefs.usernames;
  await ctx.reply(
    [
      "Send username(s) to <b>add</b>, comma/newline-separated (Unicode OK).",
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
      "Send username(s) to <b>replace</b> all existing filters, comma/newline-separated (Unicode OK).",
      "Example:  odin, 旺财",
      current.length ? `Current: ${current.join(", ")}` : "Current: (none)",
    ].join("\n"),
    { parse_mode: "HTML" },
  );
});

bot.callbackQuery(/^filter:del:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const name = decodeURIComponent(ctx.match![1]);
  ctx.session.prefs.usernames = ctx.session.prefs.usernames.filter((u) => u !== name);
  const chatId = getChatId(ctx);
  await writeSessionByKey(String(chatId), ctx.session);
  await refreshMenuByChatId(chatId);
  await ctx.reply(`Removed filter: ${name}`, { reply_markup: backToMenuInline() });
});

bot.callbackQuery("filter:clear", async (ctx) => {
  await ctx.answerCallbackQuery({ text: "Cleared" });
  ctx.session.prefs.usernames = [];
  const chatId = getChatId(ctx);
  await writeSessionByKey(String(chatId), ctx.session);
  await refreshMenuByChatId(chatId);
  await ctx.reply("Cleared all filters.", { reply_markup: backToMenuInline() });
});

// consume the user’s text when we’re awaiting filters
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
      await writeSessionByKey(String(getChatId(ctx)), ctx.session);
      await renderOrSendMenu(ctx);
      await ctx.reply(
        incoming.length
          ? `Replaced. Now: ${ctx.session.prefs.usernames.join(", ")}`
          : "Cleared all filters.",
        { reply_markup: backToMenuInline() },
      );
    }
    return;
  }
  await next();
});

// Vera card toggle on the card
bot.callbackQuery("vera:toggle", async (ctx) => {
  const chatId = getChatId(ctx);
  const s = (await readSessionByKey(String(chatId))) ?? { prefs: { enabled: false, usernames: [] } };
  s.prefs.enabled = !s.prefs.enabled;
  await writeSessionByKey(String(chatId), s);

  await ctx.answerCallbackQuery({ text: s.prefs.enabled ? "Enabled ✅" : "Paused ⏸️" });

  queueMicrotask(() => {
    if (s.prefs.enabled) mints.enable(chatId, s);
    else mints.pause(chatId);
  });

  try { await ctx.editMessageReplyMarkup({ reply_markup: veraInline(s.prefs.enabled) }); } catch {}
  await refreshMenuByChatId(chatId);
});

bot.callbackQuery("vera:menu", async (ctx) => { await ctx.answerCallbackQuery(); await renderOrSendMenu(ctx); });

export default bot;
