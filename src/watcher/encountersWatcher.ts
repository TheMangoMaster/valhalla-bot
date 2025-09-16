// src/watcher/encountersWatcher.ts
import { ethers } from "../../deps.ts";
import { ENTRY_POINT, OPBNB_RPC_HTTP } from "../../config.ts";
import entryPointAbiJson from "../../abi/entryPoint.json" with { type: "json" };
import type { MySession } from "../state.ts";
import { setFromEncounter } from "../watcher/attributionCache.ts";

/** ---- config ---- */
const POLL_MS           = Number(Deno.env.get("VALHALLA_POLL_MS") ?? "2000");
const BLOCK_BATCH       = Number(Deno.env.get("VALHALLA_BLOCK_BATCH") ?? "6000");
const CATCHUP_ON_ENABLE = Number(Deno.env.get("VALHALLA_CATCHUP") ?? "0") > 0;  // live-only -> set 0
const BACKFILL_BLOCKS   = Number(Deno.env.get("VALHALLA_BACKFILL_BLOCKS") ?? "12000");
const BACKFILL_LIMIT    = Number(Deno.env.get("VALHALLA_BACKFILL_LIMIT") ?? "0");
const BATTLE_TYPE       = Number(Deno.env.get("VALHALLA_BATTLE_TYPE") ?? "0");  // PvE
const DEBUG             = (Deno.env.get("VALHALLA_DEBUG") ?? "0") === "1";

/** Dedup TTLs (in blocks) */
const EVENT_DEDUP_TTL = Number(Deno.env.get("VALHALLA_EVENT_TTL") ?? "120");  // (bn, tx, veraId)
const STICKY_TTL      = Number(Deno.env.get("VALHALLA_STICKY_TTL") ?? "900"); // (charId, veraId)

/** EncounterSeed table id (bytes32) */
const ENCOUNTER_SEED = "0x746276616c68616c6c61000000000000456e636f756e74657253656564000000" as const;

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

const entryAbi   = entryPointAbiJson as unknown as ethers.InterfaceAbi;
const entryIface = new ethers.Interface(entryAbi);

/** Minimal interface for Store_SetRecord */
const storeIface = new ethers.Interface([
  "event Store_SetRecord(bytes32 tableId, bytes32[] keyTuple, bytes staticData, bytes32 encodedLengths, bytes dynamicData)"
]);

const TOPIC_STORE_SET_RECORD = ethers.id("Store_SetRecord(bytes32,bytes32[],bytes,bytes32,bytes)");

const timers   = new Map<number, number>();
const locks    = new Map<number, boolean>();
const runToken = new Map<number, number>();

function dbg(...a: unknown[]) { if (DEBUG) console.log("[encounters.dbg]", ...a); }
function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }
function bumpRun(chatId: number) { runToken.set(chatId, (runToken.get(chatId) ?? 0) + 1); return runToken.get(chatId)!; }
function isCurrent(chatId: number, token: number) { return runToken.get(chatId) === token; }

/** strictly “greater than” by (bn, txi, li) */
function isAfter(
  a: { bn: number; txi: number; li: number },
  c?: { bn: number; txi: number; li: number },
) {
  if (!c) return true;
  return (a.bn > c.bn) || (a.bn === c.bn && (a.txi > c.txi || (a.txi === c.txi && a.li > c.li)));
}

/** retry helper for public RPCs */
async function rpc<T>(fn: () => Promise<T>, label: string, tries = 5): Promise<T> {
  let delay = 250;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      const retryable = /limit exceeded|temporar|timeout|BAD_DATA|missing response|gateway/i.test(msg);
      if (!retryable || i === tries - 1) { console.warn(`[encounters.rpc] fail ${label}:`, msg); throw e; }
      await sleep(delay + Math.floor(Math.random() * 100));
      delay = Math.min(delay * 2, 2000);
    }
  }
  throw new Error(`rpc retries exhausted: ${label}`);
}

export function createEncountersWatcher(opts: {
  getSession: (chatId: number) => Promise<MySession | undefined>;
  setSession: (chatId: number, s: MySession) => Promise<void>;
  sendCard: SendFn;
}) {
  const http  = new ethers.JsonRpcProvider(OPBNB_RPC_HTTP);
  const entry = new ethers.Contract(ENTRY_POINT, entryAbi, http);

  async function latestBlock() {
    return await rpc(() => http.getBlockNumber(), "getBlockNumber");
  }

  /** username from a known character id (no relayer guessing) */
  async function usernameFromCharacterId(charId: bigint): Promise<string | null> {
    try {
      try {
        const data = await rpc(
          () => entry["valhalla__getPlayerBattleData"](charId, BATTLE_TYPE),
          `getPlayerBattleData:${String(charId)}:${BATTLE_TYPE}`,
        );
        const u = String(data?.username ?? "").trim();
        if (u) return u;
      } catch {}
      try {
        const cname = String(
          await rpc(
            () => entry["valhalla__getCharacterNameById"](charId),
            `getCharacterNameById:${String(charId)}`,
          ),
        ).trim();
        if (cname) return cname;
      } catch {}
    } catch {}
    return null;
  }

  /** per-chat dedup with TTL */
  const seenEventPerChat = new Map<number, Map<string, number>>(); // key: bn:tx:veraId
  const seenStickyPerChat = new Map<number, Map<string, number>>(); // key: charId:veraId

  function seenWithTtl(
    mapPerChat: Map<number, Map<string, number>>,
    chatId: number,
    key: string,
    bn: number,
    ttl: number,
  ): boolean {
    let m = mapPerChat.get(chatId);
    if (!m) { m = new Map(); mapPerChat.set(chatId, m); }
    const exp = m.get(key) ?? 0;
    if (exp >= bn) return true;
    m.set(key, bn + ttl);
    if (m.size > 6000) m.clear(); // simple GC
    return false;
  }

  function usernamePass(list: string[], name: string | null) {
    if (!list.length) return true;          // no filters = allow all
    if (!name) return false;                // filters set, but we couldn't resolve a name => skip
    const collator = new Intl.Collator(undefined, { sensitivity: "base" });
    return list.some((u) => collator.compare(u, name) === 0);
  }

  async function isEnabled(chatId: number) {
    const s = await opts.getSession(chatId);
    return !!s?.prefs.enabled;
  }

  /** hydrate vera stats */
  async function hydrateVera(veraId: bigint) {
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

  /**
   * Query Store_SetRecord logs in [from..to], keep only EncounterSeed rows, ASC.
   * Important change: read logs from the STORE (address if provided) or by topic0 only.
   */
  async function getEncounterRowsAsc(fromBlock: number, toBlock: number) {
    type Row = { h: string; bn: number; txi: number; li: number; charId: bigint };
    const out: Row[] = [];

    for (let from = fromBlock; from <= toBlock; from += BLOCK_BATCH) {
      const to = Math.min(toBlock, from + BLOCK_BATCH - 1);

      const filter: ethers.Filter = {
        fromBlock: BigInt(from),
        toBlock: BigInt(to),
        // IMPORTANT: do NOT set address here.
        // We filter by topics only so we catch the Store/World emitter.
        topics: [
          TOPIC_STORE_SET_RECORD,               // topic0
          ENCOUNTER_SEED.toLowerCase(),         // topic1 = indexed tableId
        ],
      };

      const logs = await rpc(() => http.getLogs(filter), `getLogs:SetRecord:${from}-${to}`);

      for (const lg of logs) {
        let parsed: ethers.LogDescription | null = null;
        try { parsed = storeIface.parseLog(lg); } catch { parsed = null; }
        if (!parsed) continue;

        // Already filtered by tableId via topic1, but keep the guard cheap.
        const tableId = String(parsed.args?.tableId ?? "").toLowerCase();
        if (tableId !== ENCOUNTER_SEED.toLowerCase()) continue;

        const keyTuple = parsed.args?.keyTuple as unknown as string[] | undefined;
        if (!Array.isArray(keyTuple) || keyTuple.length === 0) continue;

        // keyTuple[0] = characterId as bytes32 (uint256 big-endian)
        const k0 = keyTuple[0];
        if (typeof k0 !== "string" || !k0.startsWith("0x") || k0.length !== 66) continue;

        let charId: bigint;
        try { charId = BigInt(k0); } catch { continue; }

        const bn  = Number(lg.blockNumber);
        const li  = Number((lg as any).index ?? (lg as any).logIndex ?? 0);
        const txi = Number((lg as any).transactionIndex ?? 0);
        const h   = lg.transactionHash;

        out.push({ h, bn, txi, li, charId });
      }

      await sleep(10);
    }

    out.sort((a, b) => (a.bn - b.bn) || (a.txi - b.txi) || (a.li - b.li));
    if (BACKFILL_LIMIT > 0 && out.length > BACKFILL_LIMIT) return out.slice(-BACKFILL_LIMIT);

    if (DEBUG) console.log(`[encounters.dbg] getEncounterRowsAsc rows=${out.length} from=${fromBlock} to=${toBlock}`);
    return out;
  }

  /** Given a character, send the (fresh) opponent veras (usually 1) with perfect attribution. */
  async function sendEncounterForCharacter(
    chatId: number,
    bn: number,
    txHash: string,
    charId: bigint,
    session: MySession,
    token: number,
  ) {
    const username = await usernameFromCharacterId(charId);

    // Retry a couple times so state is visible after the log
    let opp: Array<{ blockchainId: bigint }> = [];
    for (let i = 0; i < 3; i++) {
      opp = await rpc(
        () => entry["valhalla__getOpponentVerasInBattle"](charId),
        `getOpponentVerasInBattle:${String(charId)}`
      );
      if (Array.isArray(opp) && opp.length) break;
      await sleep(250 + i * 250); // 250ms, 500ms
    }

    if (DEBUG) console.log(`[encounters.dbg] char=${String(charId)} opp_count=${opp?.length ?? 0} bn=${bn}`);

    let anySent = false;

    for (const o of opp) {
      const veraId = BigInt(o.blockchainId);

      // Cache attribution so Mint watcher can show the real player later
      try { setFromEncounter(veraId, charId, username); } catch {}

      // event-level/sticky dedup as you had...
      const ek = `${bn}:${txHash}:${String(veraId)}`;
      if (seenWithTtl(seenEventPerChat, chatId, ek, bn, EVENT_DEDUP_TTL)) continue;
      const sk = `${String(charId)}:${String(veraId)}`;
      if (seenWithTtl(seenStickyPerChat, chatId, sk, bn, STICKY_TTL)) continue;

      const hv = await hydrateVera(veraId);
      const imagePath = `assets/vera/${hv.speciesId}.png`;

      if (!usernamePass(session.prefs.usernames, username)) continue;

      await opts.sendCard(chatId, {
        veraId,
        imagePath,
        level: hv.level,
        speciesId: hv.speciesId,
        personality: hv.personality,
        username: username ?? `#${String(charId)}`,
        innate: hv.innate,
      });
    }

    return anySent;
  }

  async function pollOnce(chatId: number, token?: number) {
    const tk = token ?? runToken.get(chatId) ?? 0;
    if (!isCurrent(chatId, tk)) return;
    if (locks.get(chatId)) return;
    locks.set(chatId, true);
    try {
      const s = (await opts.getSession(chatId)) ?? { prefs: { enabled: false, usernames: [] } };
      if (!s.prefs.enabled) return;

      const head = await latestBlock();
      const cur  = s.prefs.lastCursor;
      const fromBn = cur ? cur.bn : head;  // live-only: start at head
      if (head < fromBn) return;

      const rows = await getEncounterRowsAsc(fromBn, head);
      const todo = rows.filter((r) => isAfter({ bn: r.bn, txi: r.txi, li: r.li }, cur));

      let last: { bn: number; txi: number; li: number } | undefined;

      for (const { h, bn, txi, li, charId } of todo) {
        await sendEncounterForCharacter(chatId, bn, h, charId, s, tk);
        last = { bn, txi, li };
      }

      if (last) {
        s.prefs.lastCursor = last;
        await opts.setSession(chatId, s);
      }
    } catch (e) {
      console.warn("[encounters.poll] error", (e as Error)?.message ?? e);
    } finally {
      locks.set(chatId, false);
    }
  }

  /** Backfill from recent blocks (ordered), pause-aware. */
  async function runBackfill(chatId: number, head: number, token: number) {
    const from = Math.max(0, head - BACKFILL_BLOCKS);
    let rows = await getEncounterRowsAsc(from, head);
    if (BACKFILL_LIMIT > 0 && rows.length > BACKFILL_LIMIT) rows = rows.slice(-BACKFILL_LIMIT);
    console.log(`[encounters] backfill txs=${rows.length} (window ${head - from + 1} blocks, limit ${BACKFILL_LIMIT})`);

    let s = (await opts.getSession(chatId)) ?? { prefs: { enabled: false, usernames: [] } };
    let cur = s.prefs.lastCursor;

    for (const { h, bn, txi, li, charId } of rows) {
      if (!isCurrent(chatId, token) || !(await isEnabled(chatId))) {
        console.log(`[encounters] backfill aborted: paused (chat=${chatId})`);
        break;
      }
      if (cur && !isAfter({ bn, txi, li }, cur)) continue;

      await sendEncounterForCharacter(chatId, bn, h, charId, s, token);
      cur = { bn, txi, li };

      // light persistence as we go
      s.prefs.lastCursor = cur;
      await opts.setSession(chatId, s);
    }
  }

  return {
    async enable(chatId: number, session: MySession) {
      const old = timers.get(chatId); if (old) { clearInterval(old); timers.delete(chatId); }

      const token = bumpRun(chatId);
      await opts.setSession(chatId, session);

      const head = await latestBlock();
      console.log(`[encounters] enable chat=${chatId} head=${head} (polling @ ${POLL_MS}ms)`);

      if (CATCHUP_ON_ENABLE) {
        await runBackfill(chatId, head, token);
      } else {
        // live-only: baseline cursor so we start strictly after current head
        session.prefs.lastCursor = { bn: head, txi: 9_999_999, li: 9_999_999 };
        await opts.setSession(chatId, session);
      }

      const tid = setInterval(() => { pollOnce(chatId, token); }, POLL_MS) as unknown as number;
      timers.set(chatId, tid);
      console.log(`[encounters] enabled (polling) chat=${chatId}`);
    },

    async pause(chatId: number) {
      const tid = timers.get(chatId);
      if (tid) { clearInterval(tid); timers.delete(chatId); }
      bumpRun(chatId); // invalidate in-flight work
      console.log(`[encounters] paused chat=${chatId}`);
    },

    __pollOnce: (chatId: number) => pollOnce(chatId),
  };
}
