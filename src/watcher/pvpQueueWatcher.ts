import { ethers } from "../../deps.ts";
import { ENTRY_POINT, OPBNB_RPC_HTTP } from "../../config.ts";
import entryPointAbiJson from "../../abi/entryPoint.json" with { type: "json" };
import type { MySession } from "../state.ts";

/** ---------- config ---------- */
const POLL_MS = Number(Deno.env.get("VALHALLA_PVP_POLL_MS") ?? "2500");
const DEBUG   = (Deno.env.get("VALHALLA_DEBUG") ?? "0") === "1";

/** Battle types (final) */
const PVP_TYPES = [3, 4, 5, 6]; // Ranked 3v3, Unranked 1v1/2v2/3v3

const LABELS = new Map<number,string>([
  [3, "a ⚔️ Ranked (3v3) match"],
  [4, "an 🍃 Unranked (1v1) match"],
  [5, "an 🍃 Unranked (2v2) match"],
  [6, "an 🍃 Unranked (3v3) match"],
]);

/** ---------- utils ---------- */
const entryAbi = entryPointAbiJson as unknown as ethers.InterfaceAbi;
function dbg(...a: unknown[]) { if (DEBUG) console.log("[pvp.dbg]", ...a); }
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function rpc<T>(fn: () => Promise<T>, label: string, tries = 5): Promise<T> {
  let delay = 220;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      const retryable = /tempor|timeout|limit|BAD_DATA|missing response|gateway|ECONN|ETIMEDOUT|JSON/i.test(msg);
      if (!retryable || i === tries - 1) { console.warn(`[pvp.rpc] fail ${label}:`, msg); throw e; }
      await sleep(delay + Math.floor(Math.random() * 100));
      delay = Math.min(delay * 2, 1600);
    }
  }
  throw new Error(`rpc retries exhausted: ${label}`);
}

function unpackQueueResult(res: any): { ids: bigint[]; elos: number[] } {
  const ids  = (res?.characterIds ?? res?.[0] ?? []) as any[];
  const elos = (res?.elos ?? res?.[1] ?? []) as any[];
  return {
    ids:  Array.isArray(ids)  ? ids.map((x) => BigInt(x)) : [],
    elos: Array.isArray(elos) ? elos.map((x) => Number(x)) : [],
  };
}

// tiny name cache to avoid hammering RPC when players sit in queue
const nameCache = new Map<bigint, { name: string | null; ts: number }>();
const NAME_TTL_MS = 5 * 60_000;

async function usernameFromCharacterId(entry: ethers.Contract, charId: bigint): Promise<string | null> {
  const now = Date.now();
  const cached = nameCache.get(charId);
  if (cached && (now - cached.ts) < NAME_TTL_MS) return cached.name;

  let name: string | null = null;
  try {
    // PvE=0 often carries username; fallback to cname
    const pbd = await rpc(() => entry["valhalla__getPlayerBattleData"](charId, 0), `pbd:${String(charId)}`);
    const u = String(pbd?.username ?? "").trim();
    if (u) name = u;
  } catch {}
  if (!name) {
    try {
      const cn = await rpc(() => entry["valhalla__getCharacterNameById"](charId), `cname:${String(charId)}`);
      const u = String(cn ?? "").trim();
      if (u) name = u;
    } catch {}
  }
  nameCache.set(charId, { name, ts: now });
  return name;
}

function key(type: number, id: bigint) { return `${type}:${String(id)}`; }

/** ---------- watcher ---------- */
type SendAlertFn   = (chatId: number, text: string) => Promise<number>; // returns message_id
type DeleteAlertFn = (chatId: number, messageId: number) => Promise<void>;

export function createPvpQueueWatcher(opts: {
  getSession: (chatId: number) => Promise<MySession | undefined>;
  setSession: (chatId: number, s: MySession) => Promise<void>;
  sendAlert: SendAlertFn;
  deleteAlert: DeleteAlertFn;
}) {
  const http  = new ethers.JsonRpcProvider(OPBNB_RPC_HTTP);
  const entry = new ethers.Contract(ENTRY_POINT, entryAbi, http);

  /** For each chat: current snapshot of queue → Map<"type:id", { msgId }> */
  const liveByChat = new Map<number, Map<string, { msgId: number }>>();

  async function pollOnce(chatId: number) {
    const s = (await opts.getSession(chatId)) ?? { prefs: { enabled: false, usernames: [] } };
    if (!(s as any).pvpEnabled) return;

    // 1) fetch all queues
    const snapshots = new Map<number, { ids: bigint[]; elos: number[] }>();
    for (const t of PVP_TYPES) {
      try {
        const res = await rpc(() => entry["valhalla__getQueuedCharacterIdsByBattleType"](t), `queue:${t}`);
        snapshots.set(t, unpackQueueResult(res));
      } catch {
        snapshots.set(t, { ids: [], elos: [] });
      }
    }

    // 2) diff vs previous snapshot
    const prev = liveByChat.get(chatId) ?? new Map<string, { msgId: number }>();
    const next = new Map<string, { msgId: number }>();

    // 2a) NEW entrants → send alerts
    for (const t of PVP_TYPES) {
      const snap = snapshots.get(t)!;
      const { ids, elos } = snap;

      for (let i = 0; i < ids.length; i++) {
        const id  = ids[i];
        const elo = Number.isFinite(elos[i]) ? elos[i] : 0;
        const k = key(t, id);
        if (prev.has(k)) {
          // still in queue; carry forward
          next.set(k, prev.get(k)!);
          continue;
        }
        const username = await usernameFromCharacterId(entry, id);
        const name = username ?? `Character ${String(id)}`;
        const label = LABELS.get(t) ?? `BattleType ${t}`;
        const text = `🎮 ${name} (${elo} elo) is looking for ${label}.`;
        const msgId = await opts.sendAlert(chatId, text);
        next.set(k, { msgId });
        if (DEBUG) dbg("enter", { chatId, type: t, id: String(id), elo, msgId });
      }
    }

    // 2b) LEAVERS → delete their messages
    for (const [k, meta] of prev) {
      if (!next.has(k)) {
        try { await opts.deleteAlert(chatId, meta.msgId); } catch {}
        if (DEBUG) dbg("leave", { chatId, key: k, deleted: meta.msgId });
      }
    }

    liveByChat.set(chatId, next);
  }

  /** MULTI-CHAT timers */
  const timers = new Map<number, number>();

  return {
    async enable(chatId: number, session: MySession) {
      await opts.setSession(chatId, session);

      // clear existing ONLY for this chat
      const old = timers.get(chatId);
      if (old) clearInterval(old);

      liveByChat.set(chatId, new Map());
      console.log(`[pvp] enable chat=${chatId} (poll @ ${POLL_MS}ms)`);

      // start fresh interval for this chat
      const id = setInterval(() => { pollOnce(chatId); }, POLL_MS) as unknown as number;
      timers.set(chatId, id);

      // kick an immediate pass
      queueMicrotask(() => { pollOnce(chatId); });

      console.log(`[pvp] enabled chat=${chatId}`);
    },

    async pause(chatId: number) {
      const id = timers.get(chatId);
      if (id) { clearInterval(id); timers.delete(chatId); }
      liveByChat.delete(chatId);
      console.log(`[pvp] paused chat=${chatId}`);
    },

    __pollOnce: (chatId: number) => pollOnce(chatId),
  };
}