import { ethers } from "../../deps.ts";
import { ENTRY_POINT, OPBNB_RPC_HTTP } from "../../config.ts";
import entryPointAbiJson from "../../abi/entryPoint.json" with { type: "json" };
import type { MySession } from "../state.ts";

/** ---- config ---- */
const POLL_MS               = Number(Deno.env.get("VALHALLA_POLL_MS") ?? "2500");
const BATTLE_TYPE           = Number(Deno.env.get("VALHALLA_BATTLE_TYPE") ?? "0"); // 0 = PvE
const DEBUG                 = (Deno.env.get("VALHALLA_DEBUG") ?? "0") === "1";
const MAX_USERNAME_FAIL_TTL = Number(Deno.env.get("VALHALLA_NAME_FAIL_TTL") ?? "60000"); // 60s cache for failed lookups
const EVENT_DEDUP_TTL       = Number(Deno.env.get("VALHALLA_EVENT_TTL") ?? "120"); // shape only, not used here

type SendFn = (
  chatId: number,
  payload: {
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
  },
) => Promise<void>;

const entryAbi = entryPointAbiJson as unknown as ethers.InterfaceAbi;

function dbg(...a: unknown[]) { if (DEBUG) console.log("[encByFilter.dbg]", ...a); }
function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

/** JsonRpc with retry */
async function rpc<T>(fn: () => Promise<T>, label: string, tries = 5): Promise<T> {
  let delay = 250;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      const retryable = /limit exceeded|temporar|timeout|BAD_DATA|missing response|gateway|ECONNRESET|ETIMEDOUT|fetch/i.test(msg);
      if (!retryable || i === tries - 1) { console.warn(`[encByFilter.rpc] fail ${label}:`, msg); throw e; }
      await sleep(delay + Math.floor(Math.random() * 120));
      delay = Math.min(delay * 2, 2000);
    }
  }
  throw new Error(`rpc retries exhausted: ${label}`);
}

/** ————— entry helpers ————— */
async function getVera(entry: ethers.Contract, veraId: bigint) {
  const v = await rpc(() => entry["valhalla__getVera"](veraId), `getVera:${String(veraId)}`);
  return {
    level: Number(v.level),
    speciesId: Number(v.species),
    personality: v.personality !== undefined ? Number(v.personality) : null,
    innate: {
      strength: Number(v.innateStats.strength),
      dexterity: Number(v.innateStats.dexterity),
      vitality: Number(v.innateStats.vitality),
      intellect: Number(v.innateStats.intellect),
      wisdom: Number(v.innateStats.wisdom),
      charisma: Number(v.innateStats.charisma),
    },
  };
}

/** Try common function names to resolve username -> characterId */
async function resolveCharacterId(entry: ethers.Contract, name: string): Promise<bigint | null> {
  const tries: Array<() => Promise<bigint | null>> = [
    async () => {
      try {
        const id = await rpc(() => entry["valhalla__getCharacterIdByName"](name), `getCharacterIdByName:${name}`);
        const b = BigInt(id);
        return b > 0n ? b : null;
      } catch { return null; }
    },
    async () => {
      try {
        const id = await rpc(() => entry["valhalla__getPlayerIdByUsername"](name), `getPlayerIdByUsername:${name}`);
        const playerId = BigInt(id);
        if (playerId <= 0n) return null;
        const selected = await rpc(() => entry["valhalla__getSelectedCharacterIdByPlayerId"](playerId), `getSelectedCharacterIdByPlayerId:${playerId}`);
        const charId = BigInt(selected);
        return charId > 0n ? charId : null;
      } catch { return null; }
    },
    async () => {
      try {
        const addr = await rpc(() => entry["valhalla__getAddressByUsername"](name), `getAddressByUsername:${name}`);
        if (typeof addr !== "string" || !addr.startsWith("0x")) return null;
        const selected = await rpc(() => entry["valhalla__getSelectedCharacterId"](addr), `getSelectedCharacterId:${addr}`);
        const charId = BigInt(selected);
        return charId > 0n ? charId : null;
      } catch { return null; }
    },
  ];

  for (const t of tries) {
    const r = await t();
    if (r && r > 0n) return r;
  }
  return null;
}

/** read current opponent vera ids for a character (several ABI variants exist) */
async function getOpponentVeraIds(entry: ethers.Contract, charId: bigint): Promise<bigint[]> {
  const tryFns: Array<() => Promise<bigint[]>> = [
    async () => {
      try {
        const res = await rpc(() => entry["valhalla__getOpponentVeraIds"](charId), `getOpponentVeraIds:${String(charId)}`);
        return (Array.isArray(res) ? res : (res?.[0] ?? []))?.map((x: any) => BigInt(x)) ?? [];
      } catch { return []; }
    },
    async () => {
      try {
        const res = await rpc(() => entry["valhalla__getOpponentVerasInBattle"](charId), `getOpponentVerasInBattle:${String(charId)}`);
        const arr = Array.isArray(res) ? res : (res?.[0] ?? []);
        return arr.map((x: any) => BigInt((x?.blockchainId ?? x)));
      } catch { return []; }
    },
    async () => {
      try {
        const battleId = await rpc(() => entry["valhalla__getCharacterBattleId"](charId), `getCharacterBattleId:${String(charId)}`);
        const bid = BigInt(battleId);
        if (bid <= 0n) return [];
        const res = await rpc(() => entry["valhalla__getOpponentVeraIdsByBattleId"](bid), `getOpponentVeraIdsByBattleId:${String(bid)}`);
        return (Array.isArray(res) ? res : (res?.[0] ?? [])).map((x: any) => BigInt(x));
      } catch { return []; }
    },
  ];

  for (const f of tryFns) {
    const ids = await f();
    if (ids.length) return ids;
  }
  return [];
}

/** seen cache per chat to avoid duplicate cards */
const seenByChat = new Map<number, Set<string>>();
function alreadySent(chatId: number, veraId: bigint): boolean {
  let s = seenByChat.get(chatId);
  if (!s) { s = new Set(); seenByChat.set(chatId, s); }
  const k = String(veraId);
  if (s.has(k)) return true;
  if (s.size > 5000) s.clear();
  s.add(k);
  return false;
}

/** username -> charId cache (+negative cache) */
const charIdCache = new Map<string, { id: bigint | null; ts: number }>();
async function getCharIdCached(entry: ethers.Contract, username: string): Promise<bigint | null> {
  const key = username.toLowerCase();
  const now = Date.now();
  const cached = charIdCache.get(key);
  if (cached) {
    if (cached.id === null) {
      if (now - cached.ts < MAX_USERNAME_FAIL_TTL) return null;
    } else {
      if (now - cached.ts < 10 * 60_000) return cached.id;
    }
  }
  const id = await resolveCharacterId(entry, username);
  charIdCache.set(key, { id, ts: now });
  return id;
}

export function createEncountersWatcher(opts: {
  getSession: (chatId: number) => Promise<MySession | undefined>;
  setSession: (chatId: number, s: MySession) => Promise<void>;
  sendCard: SendFn;
}) {
  const http  = new ethers.JsonRpcProvider(OPBNB_RPC_HTTP);
  const entry = new ethers.Contract(ENTRY_POINT, entryAbi, http);

  async function hydrateAndSend(chatId: number, username: string, veraId: bigint) {
    if (alreadySent(chatId, veraId)) return;
    const v = await getVera(entry, veraId);
    const imagePath = `assets/vera/${v.speciesId}.png`;

    dbg("send", { chatId, username, veraId: String(veraId), species: v.speciesId });
    await opts.sendCard(chatId, {
      veraId,
      imagePath,
      level: v.level,
      speciesId: v.speciesId,
      personality: v.personality,
      username,
      innate: v.innate,
    });
  }

  async function pollOnce(chatId: number) {
    const s = (await opts.getSession(chatId)) ?? { prefs: { enabled: false, usernames: [] } };
    if (!s.prefs.enabled) return;

    // nothing to do if no filters for this chat
    const filters = (s.prefs.usernames ?? []).map((n) => n.trim()).filter(Boolean);
    if (filters.length === 0) { dbg("no filters", { chatId }); return; }

    for (const name of filters) {
      const charId = await getCharIdCached(entry, name);
      if (!charId || charId <= 0n) { dbg("name->charId MISS", { name }); continue; }

      const opponentIds = await getOpponentVeraIds(entry, charId);
      if (!opponentIds.length) { dbg("no opponents", { name, charId: String(charId) }); continue; }

      for (const veraId of opponentIds) {
        await hydrateAndSend(chatId, name, veraId);
      }
    }
  }

  /** MULTI-CHAT: keep one interval per chat */
  const timers = new Map<number, number>();

  return {
    async enable(chatId: number, session: MySession) {
      await opts.setSession(chatId, session);

      // clear existing ONLY for this chat
      const old = timers.get(chatId);
      if (old) clearInterval(old);

      console.log(`[encounters] enable chat=${chatId} (filter-only @ ${POLL_MS}ms)`);

      // start fresh interval for this chat
      const id = setInterval(() => { pollOnce(chatId); }, POLL_MS) as unknown as number;
      timers.set(chatId, id);

      // kick an immediate pass so user sees something right away
      queueMicrotask(() => { pollOnce(chatId); });

      console.log(`[encounters] enabled (filter-only) chat=${chatId}`);
    },

    async pause(chatId: number) {
      const id = timers.get(chatId);
      if (id) { clearInterval(id); timers.delete(chatId); }
      console.log(`[encounters] paused chat=${chatId}`);
    },

    __pollOnce: (chatId: number) => pollOnce(chatId),
  };
}