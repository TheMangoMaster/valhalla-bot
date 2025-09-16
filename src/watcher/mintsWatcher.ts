// src/watcher/mintsWatcher.ts
import { ethers } from "../../deps.ts";
import { ENTRY_POINT, OPBNB_RPC_HTTP, VERA_ERC721 } from "../../config.ts";
import entryPointAbiJson from "../../abi/entryPoint.json" with { type: "json" };
import type { MySession } from "../state.ts";
import { setFromEncounter, getAttribution } from "./attributionCache.ts";

/** ---- config ---- */
const POLL_MS                 = Number(Deno.env.get("VALHALLA_POLL_MS") ?? "2000");
const BLOCK_BATCH             = Number(Deno.env.get("VALHALLA_BLOCK_BATCH") ?? "6000");
const LIVE_LATEST_BACKSCAN    = Number(Deno.env.get("VALHALLA_MINT_BACKSCAN_BLOCKS") ?? "2400");
const ATTRIB_BACKSCAN_BLOCKS  = Number(Deno.env.get("VALHALLA_ATTRIB_BACKSCAN_BLOCKS") ?? "8000");
const BATTLE_TYPE             = Number(Deno.env.get("VALHALLA_BATTLE_TYPE") ?? "0");  // 0 = PvE
const PROBE_MAX_CHARACTERS    = Number(Deno.env.get("VALHALLA_PROBE_MAX") ?? "300");
const ATTRIB_MAX_RETRIES      = Number(Deno.env.get("VALHALLA_ATTRIB_MAX_RETRIES") ?? "8");
const DEBUG                   = (Deno.env.get("VALHALLA_DEBUG") ?? "0") === "1";

/** Dedup TTL (blocks) for (bn, tx, tokenId) */
const EVENT_DEDUP_TTL = Number(Deno.env.get("VALHALLA_EVENT_TTL") ?? "120");

/** VeraTokenBacklog table id (tbvalhalla…VeraTokenBacklog) */
const TABLE_VERA_TOKEN_BACKLOG =
  "0x746276616c68616c6c6100000000000056657261546f6b656e4261636b6c6f67".toLowerCase();

/** ERC-721 Transfer(address indexed from, address indexed to, uint256 indexed tokenId) */
const erc721Iface = new ethers.Interface([
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
]);
const TOPIC_TRANSFER = ethers.id("Transfer(address,address,uint256)");
const ZERO_TOPIC     = "0x".padEnd(66, "0"); // topic1 == from == 0x0...0 → mint

/** Store events (MUD-style World) */
const storeSetIface = new ethers.Interface([
  "event Store_SetRecord(bytes32 tableId, bytes32[] keyTuple, bytes staticData, bytes32 encodedLengths, bytes dynamicData)",
]);
const storeDelIface = new ethers.Interface([
  "event Store_DeleteRecord(bytes32 tableId, bytes32[] keyTuple)",
]);
const TOPIC_STORE_SET_RECORD    = ethers.id("Store_SetRecord(bytes32,bytes32[],bytes,bytes32,bytes)");
const TOPIC_STORE_DELETE_RECORD = ethers.id("Store_DeleteRecord(bytes32,bytes32[])");

/** Known interesting tables (match by ASCII substring; we’ll check args.tableId AND topic[1]) */
const ASCII_MATCHES = [
  "VeraTokenBacklog",
  "VeraPointTokenBacklog",
  "VRFEncounterRequest",
  "Encounter",              // broad — but we still validate keyTuple entries
];

/** ---- helpers ---- */
const entryAbi = entryPointAbiJson as unknown as ethers.InterfaceAbi;
function dbg(...a: unknown[]) { if (DEBUG) console.log("[mints.dbg]", ...a); }
function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

type MaybeAttrib = { charId?: bigint; username?: string | null };

// detect bytes32-encoded address (left-padded to 32 bytes)
function bytes32ToAddressOrNull(b32: string): string | null {
  if (typeof b32 !== "string" || !b32.startsWith("0x") || b32.length !== 66) return null;
  const tail = b32.slice(2+24); // last 20 bytes = 40 hex chars
  const head = b32.slice(2, 2+24);
  if (!/^[0-9a-fA-F]{24}$/.test(head) || !/^[0-9a-fA-F]{40}$/.test(tail)) return null;
  // reject all-zero
  if (/^0+$/.test(tail)) return null;
  return ("0x" + tail).toLowerCase();
}

async function usernameFromCharacterId(entry: ethers.Contract, charId: bigint): Promise<string | null> {
  try {
    const battleType = Number(Deno.env.get("VALHALLA_BATTLE_TYPE") ?? "0");
    const pbd = await rpc(() => entry["valhalla__getPlayerBattleData"](charId, battleType), `pbd:${String(charId)}`);
    const u = String(pbd?.username ?? "").trim();
    if (u) return u;
  } catch {}
  try {
    const cn = await rpc(() => entry["valhalla__getCharacterNameById"](charId), `cname:${String(charId)}`);
    const u = String(cn ?? "").trim();
    if (u) return u;
  } catch {}
  return null;
}

// confirm that a character’s current opponent list contains the minted token
async function characterOwnsOpponentVera(entry: ethers.Contract, charId: bigint, tokenId: bigint): Promise<boolean> {
  try {
    const ids: bigint[] = await rpc(() => entry["valhalla__getOpponentVeraIds"](charId), `oppIds:${String(charId)}`);
    return Array.isArray(ids) && ids.some(v => BigInt(v) === tokenId);
  } catch { return false; }
}

async function rpc<T>(fn: () => Promise<T>, label: string, tries = 5): Promise<T> {
  let delay = 250;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      const retryable = /limit exceeded|temporar|timeout|BAD_DATA|missing response|gateway/i.test(msg);
      if (!retryable || i === tries - 1) { console.warn(`[mints.rpc] fail ${label}:`, msg); throw e; }
      await sleep(delay + Math.floor(Math.random() * 100));
      delay = Math.min(delay * 2, 2000);
    }
  }
  throw new Error(`rpc retries exhausted: ${label}`);
}

function parseLogOrNull(iface: ethers.Interface, lg: unknown): ethers.LogDescription | null {
  try { return iface.parseLog(lg as any); } catch { return null; }
}

function isAfter(a: { bn: number; txi: number; li: number }, c?: { bn: number; txi: number; li: number }) {
  if (!c) return true;
  return (a.bn > c.bn) || (a.bn === c.bn && (a.txi > c.txi || (a.txi === c.txi && a.li > c.li)));
}

const seenEventPerChat = new Map<number, Map<string, number>>();
function seenWithTtl(chatId: number, key: string, bn: number, ttl: number): boolean {
  let m = seenEventPerChat.get(chatId);
  if (!m) { m = new Map(); seenEventPerChat.set(chatId, m); }
  const exp = m.get(key) ?? 0;
  if (exp >= bn) return true;
  m.set(key, bn + ttl);
  if (m.size > 6000) m.clear();
  return false;
}

/** bytes32 -> printable ASCII-ish (drop nulls) */
function asciiFromBytes32Hex(hexLower: string): string {
  try {
    const h = hexLower.startsWith("0x") ? hexLower.slice(2) : hexLower;
    const bytes = new Uint8Array(h.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(h.slice(i*2, i*2+2), 16);
    const noZeros = Array.from(bytes).filter(b => b !== 0);
    const s = new TextDecoder().decode(new Uint8Array(noZeros));
    return s.replace(/[^\x20-\x7E]/g, "");
  } catch { return ""; }
}

/** ---- attribution strategies ---- */

/** A) Same-tx scan: parse ALL store logs; match tableId by ASCII substring; try all keyTuple[i] */
async function tryAttributionFromSameTx(
  http: ethers.JsonRpcProvider,
  entry: ethers.Contract,
  txHash: string,
  tokenId: bigint,
): Promise<MaybeAttrib> {
  // wait for receipt
  let rcpt: ethers.TransactionReceipt | null = null;
  {
    let delay = 300;
    for (let i = 0; i < 10; i++) {
      rcpt = await rpc(() => http.getTransactionReceipt(txHash), `getTxReceipt:${txHash}`);
      if (rcpt) break;
      await sleep(delay);
      delay = Math.min(delay + 250, 2000);
    }
  }
  if (!rcpt) return {};

  if (DEBUG) console.log("[mints.attrib] scan tx logs", { txHash, logs: rcpt.logs?.length ?? 0 });

  // 1) STRICT: Store_DeleteRecord + VeraTokenBacklog
  for (const lg of rcpt.logs ?? []) {
    const t0 = (lg.topics?.[0] ?? "").toLowerCase();
    const t1 = (lg.topics?.[1] ?? "").toLowerCase();
    if (t0 !== TOPIC_STORE_DELETE_RECORD || t1 !== TABLE_VERA_TOKEN_BACKLOG) continue;

    const parsed = parseLogOrNull(storeDelIface, lg);
    if (!parsed) continue;

    const keyTuple = parsed.args?.keyTuple as unknown as string[] | undefined;
    if (!Array.isArray(keyTuple) || keyTuple.length === 0) continue;

    for (let i = 0; i < keyTuple.length; i++) {
      const k = keyTuple[i];
      // first try address→selectedCharacterId
      const addr = bytes32ToAddressOrNull(k);
      if (addr) {
        try {
          const selectedId64 = await rpc(
            () => entry["valhalla__getSelectedCharacterId"](addr),
            `selId:${addr}`
          );
          const charId = BigInt(selectedId64);
          if (charId > 0n && await characterOwnsOpponentVera(entry, charId, tokenId)) {
            const username = await usernameFromCharacterId(entry, charId);
            if (username) {
              setFromEncounter(tokenId, charId, username);
              if (DEBUG) console.log("[mints.attrib] backlog strict HIT (addr→char)", {
                tokenId: String(tokenId), playerId: String(charId), username, idx: i
              });
              return { charId, username };
            }
          }
        } catch {}
      }

      // then try uint→characterId
      try {
        const charId = BigInt(k);
        if (charId > 0n && await characterOwnsOpponentVera(entry, charId, tokenId)) {
          const username = await usernameFromCharacterId(entry, charId);
          if (username) {
            setFromEncounter(tokenId, charId, username);
            if (DEBUG) console.log("[mints.attrib] backlog strict HIT (charId)", {
              tokenId: String(tokenId), playerId: String(charId), username, idx: i
            });
            return { charId, username };
          }
        }
      } catch {}
    }
  }

  // 2) BROAD: any Store_{Set,Delete} in the tx — try all keys as addr/uint
  for (const lg of rcpt.logs ?? []) {
    const t0 = (lg.topics?.[0] ?? "").toLowerCase();
    if (t0 !== TOPIC_STORE_SET_RECORD && t0 !== TOPIC_STORE_DELETE_RECORD) continue;

    const parsed = t0 === TOPIC_STORE_SET_RECORD
      ? parseLogOrNull(storeSetIface, lg)
      : parseLogOrNull(storeDelIface, lg);
    if (!parsed) continue;

    const keyTuple = parsed.args?.keyTuple as unknown as string[] | undefined;
    if (!Array.isArray(keyTuple) || keyTuple.length === 0) continue;

    for (let i = 0; i < keyTuple.length; i++) {
      const k = keyTuple[i];

      const addr = bytes32ToAddressOrNull(k);
      if (addr) {
        try {
          const selectedId64 = await rpc(
            () => entry["valhalla__getSelectedCharacterId"](addr),
            `selId:${addr}`
          );
          const charId = BigInt(selectedId64);
          if (charId > 0n && await characterOwnsOpponentVera(entry, charId, tokenId)) {
            const username = await usernameFromCharacterId(entry, charId);
            if (username) {
              setFromEncounter(tokenId, charId, username);
              if (DEBUG) console.log("[mints.attrib] same-tx HIT (addr→char)", {
                tokenId: String(tokenId), playerId: String(charId), username, idx: i
              });
              return { charId, username };
            }
          }
        } catch {}
      }

      try {
        const charId = BigInt(k);
        if (charId > 0n && await characterOwnsOpponentVera(entry, charId, tokenId)) {
          const username = await usernameFromCharacterId(entry, charId);
          if (username) {
            setFromEncounter(tokenId, charId, username);
            if (DEBUG) console.log("[mints.attrib] same-tx HIT (charId)", {
              tokenId: String(tokenId), playerId: String(charId), username, idx: i
            });
            return { charId, username };
          }
        }
      } catch {}
    }
  }

  if (DEBUG) console.log("[mints.attrib] same-tx MISS", { txHash });
  return {};
}

/** B) Opponent probe: look through queued characters; see who has this veraId as opponent */
async function tryAttributionByOpponentProbe(
  entry: ethers.Contract,
  tokenId: bigint,
): Promise<MaybeAttrib> {
  let charIds: bigint[] = [];
  try {
    const res = await rpc(
      () => entry["valhalla__getQueuedCharacterIdsByBattleType"](BATTLE_TYPE),
      `getQueuedCharacterIdsByBattleType:${BATTLE_TYPE}`,
    );
    const arr = (res?.characterIds ?? res?.[0] ?? []) as unknown[];
    charIds = (Array.isArray(arr) ? arr : []).slice(0, PROBE_MAX_CHARACTERS).map((x) => BigInt(x as any));
  } catch {
    charIds = [];
  }

  for (const charId of charIds) {
    try {
      const ids = await rpc(() => entry["valhalla__getOpponentVeraIds"](charId), `getOpponentVeraIds:${String(charId)}`);
      const list = Array.isArray(ids) ? ids.map((x: any) => BigInt(x)) : [];
      if (list.some((v) => v === tokenId)) {
        const username = await usernameFromCharacterId(entry, charId) ?? null;
        setFromEncounter(tokenId, charId, username);
        if (DEBUG) console.log("[mints.attrib] probe HIT", { tokenId: String(tokenId), charId: String(charId), username });
        return { charId, username };
      }
    } catch {}
  }
  if (DEBUG) console.log("[mints.attrib] probe MISS", { tokenId: String(tokenId), size: charIds.length });
  return {};
}

/** C) EncounterSeed backscan (best-effort): scan recent Store_SetRecord for EncounterSeed and map opponents */
async function getEncounterRowsAsc(http: ethers.JsonRpcProvider, fromBlock: number, toBlock: number) {
  type Row = { bn: number; txi: number; li: number; charId: bigint; txHash: string };
  const out: Row[] = [];

  // Broad scan of SetRecord; we’ll accept anything whose ascii hints at Encounter
  for (let from = fromBlock; from <= toBlock; from += BLOCK_BATCH) {
    const to = Math.min(toBlock, from + BLOCK_BATCH - 1);
    const filter: ethers.Filter = { fromBlock: BigInt(from), toBlock: BigInt(to), topics: [TOPIC_STORE_SET_RECORD] };
    const logs = await rpc(() => http.getLogs(filter), `enc.getLogs:${from}-${to}`);

    for (const lg of logs) {
      const parsed = parseLogOrNull(storeSetIface, lg);
      if (!parsed) continue;
      const t1 = String(parsed.args?.tableId ?? "").toLowerCase();
      const ascii = asciiFromBytes32Hex(t1);
      if (!/encounter/i.test(ascii)) continue;

      const kt = parsed.args?.keyTuple as unknown as string[] | undefined;
      if (!Array.isArray(kt) || kt.length === 0) continue;
      const k0 = kt[0];
      if (typeof k0 !== "string" || !k0.startsWith("0x") || k0.length !== 66) continue;

      let charId: bigint;
      try { charId = BigInt(k0); } catch { continue; }

      const bn  = Number(lg.blockNumber);
      const li  = Number((lg as any).index ?? (lg as any).logIndex ?? 0);
      const txi = Number((lg as any).transactionIndex ?? 0);
      const h   = lg.transactionHash;
      out.push({ bn, txi, li, charId, txHash: h });
    }
    await sleep(3);
  }

  out.sort((a,b) => (a.bn - b.bn) || (a.txi - b.txi) || (a.li - b.li));
  return out;
}

async function populateAttributionNearMint(
  http: ethers.JsonRpcProvider,
  entry: ethers.Contract,
  mintBn: number,
  tokenId: bigint,
): Promise<MaybeAttrib> {
  const from = Math.max(0, mintBn - ATTRIB_BACKSCAN_BLOCKS);
  const rows = await getEncounterRowsAsc(http, from, mintBn);
  for (const r of rows) {
    let opp: Array<bigint> = [];
    try {
      const arr = await rpc(() => entry["valhalla__getOpponentVeraIds"](r.charId), `attrib.getOpp:${String(r.charId)}`);
      opp = (Array.isArray(arr) ? arr.map((x: any) => BigInt(x)) : []);
    } catch { continue; }
    if (opp.some(id => id === tokenId)) {
      const username = await usernameFromCharacterId(entry, r.charId) ?? null;
      setFromEncounter(tokenId, r.charId, username);
      if (DEBUG) console.log("[mints.attrib] backscan HIT", { tokenId: String(tokenId), charId: String(r.charId), username });
      return { charId: r.charId, username };
    }
  }
  if (DEBUG) console.log("[mints.attrib] backscan MISS", { tokenId: String(tokenId), scanned: rows.length });
  return {};
}

/** ---- watcher core ---- */
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

export function createMintsWatcher(opts: {
  getSession: (chatId: number) => Promise<MySession | undefined>;
  setSession: (chatId: number, s: MySession) => Promise<void>;
  sendCard: SendFn;
}) {
  const http  = new ethers.JsonRpcProvider(OPBNB_RPC_HTTP);
  const entry = new ethers.Contract(ENTRY_POINT, entryAbi, http);

  async function latestBlock() {
    return await rpc(() => http.getBlockNumber(), "getBlockNumber");
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

  /** scan Transfer mints in [from..to], ASC */
  async function getMintLogsAsc(fromBlock: number, toBlock: number) {
    type Row = { h: string; bn: number; txi: number; li: number; tokenId: bigint };
    const out: Row[] = [];

    for (let from = fromBlock; from <= toBlock; from += BLOCK_BATCH) {
      const to = Math.min(toBlock, from + BLOCK_BATCH - 1);

      const filter: ethers.Filter = {
        fromBlock: BigInt(from),
        toBlock: BigInt(to),
        address: VERA_ERC721,
        topics: [
          TOPIC_TRANSFER,   // topic0
          ZERO_TOPIC,       // topic1 == from == 0x0...0 → mint
        ],
      };

      const logs = await rpc(() => http.getLogs(filter), `getLogs:Mint:${from}-${to}`);

      for (const lg of logs) {
        const parsed = parseLogOrNull(erc721Iface, lg);
        if (parsed === null) continue;

        const tokenId = BigInt(parsed.args?.tokenId ?? 0n);
        const bn  = Number(lg.blockNumber);
        const li  = Number((lg as any).index ?? (lg as any).logIndex ?? 0);
        const txi = Number((lg as any).transactionIndex ?? 0);
        const h   = lg.transactionHash;
        out.push({ h, bn, txi, li, tokenId });
      }

      await sleep(5);
    }

    out.sort((a, b) => (a.bn - b.bn) || (a.txi - b.txi) || (a.li - b.li));
    return out;
  }

  /** pending queue: mints waiting for attribution */
  type Pending = { chatId: number; bn: number; txHash: string; tokenId: bigint; attempts: number; firstSeen: number };
  const pending = new Map<string, Pending>(); // key: tokenId string

  function pendKey(tokenId: bigint) { return String(tokenId); }

  type MaybeAttrib = { charId?: bigint; username?: string | null };

  async function tryResolveAttribution(
    bn: number,
    txHash: string,
    tokenId: bigint,
  ): Promise<MaybeAttrib> {
    // cache?
    let attrib: MaybeAttrib | null = getAttribution(tokenId);
    if (attrib?.username) return attrib;

    // A) same-tx (now checks addr→selectedChar and charId)
    attrib = await tryAttributionFromSameTx(http, entry, txHash, tokenId);
    if (attrib?.username) return attrib;

    // B) probe
    attrib = await tryAttributionByOpponentProbe(entry, tokenId);
    if (attrib?.username) return attrib;

    // C) backscan
    attrib = await populateAttributionNearMint(http, entry, bn, tokenId);
    if (attrib?.username) return attrib;

    return {}; // fallback empty object if nothing found
  }

  async function processPending(session: MySession) {
    const now = Date.now();
    for (const [k, p] of Array.from(pending)) {
      // exponential-ish backoff: wait 0.5s * (attempts+1)^2 between tries, capped by the poll loop anyway
      const nextDelay = 500 * Math.pow(p.attempts + 1, 2);
      if (now - p.firstSeen < nextDelay) continue;

      const attrib = await tryResolveAttribution(p.bn, p.txHash, p.tokenId);
      if (attrib?.username) {
        await sendCardWithResolved(session, p.chatId, p.bn, p.txHash, p.tokenId, attrib.username);
        pending.delete(k);
      } else {
        p.attempts++;
        if (p.attempts >= ATTRIB_MAX_RETRIES) {
          if (DEBUG) console.log("[mints.attrib] giving up (no player yet)", { tokenId: k, attempts: p.attempts });
          pending.delete(k);
        } else {
          pending.set(k, p); // keep trying
        }
      }
    }
  }

  async function sendCardWithResolved(
    session: MySession,
    chatId: number,
    bn: number,
    txHash: string,
    tokenId: bigint,
    username: string | null,
  ) {
    const hv = await hydrateVera(tokenId);
    const imagePath = `assets/vera/${hv.speciesId}.png`;

    dbg("mint.send", { chatId, bn, species: hv.speciesId, token: String(tokenId), tx: txHash, username });

    await opts.sendCard(chatId, {
      veraId: tokenId,
      imagePath,
      level: hv.level,
      speciesId: hv.speciesId,
      personality: hv.personality,
      username: username ?? undefined,
      innate: hv.innate,
    });
  }

  /** send a single mint card — only if username is resolved; otherwise enqueue pending */
  async function handleMint(
    chatId: number,
    bn: number,
    txHash: string,
    tokenId: bigint,
    session: MySession,
  ) {
    // dedup event-level
    const ek = `${bn}:${txHash}:${String(tokenId)}`;
    if (seenWithTtl(chatId, ek, bn, EVENT_DEDUP_TTL)) return false;

    const attrib = await tryResolveAttribution(bn, txHash, tokenId);
    if (attrib?.username) {
      setFromEncounter(tokenId, attrib.charId ?? 0n, attrib.username);
      await sendCardWithResolved(session, chatId, bn, txHash, tokenId, attrib.username);
      return true;
    }

    // queue for retry (do NOT send with owner)
    const key = pendKey(tokenId);
    if (!pending.has(key)) {
      pending.set(key, { chatId, bn, txHash, tokenId, attempts: 0, firstSeen: Date.now() });
      if (DEBUG) console.log("[mints.attrib] queued pending", { tokenId: String(tokenId) });
    }
    return false;
  }

  /** poll live range (cursor..head] and process mints + pending attribution */
  async function pollOnce(chatId: number) {
    const s = (await opts.getSession(chatId)) ?? { prefs: { enabled: false, usernames: [] } };
    if (!s.prefs.enabled) return;

    // 1) retry pending first (keeps latency low once attribution appears)
    await processPending(s);

    // 2) then look for fresh mints
    const head = await latestBlock();
    const cur  = s.prefs.lastCursor;
    const from = cur ? cur.bn : head; // live-only baseline at head
    if (head < from) return;

    const rows = await getMintLogsAsc(from, head);
    const todo = rows.filter((r) => isAfter({ bn: r.bn, txi: r.txi, li: r.li }, cur));

    let last: { bn: number; txi: number; li: number } | undefined;
    for (const { h, bn, txi, li, tokenId } of todo) {
      await handleMint(chatId, bn, h, tokenId, s);
      last = { bn, txi, li };
    }

    if (last) {
      s.prefs.lastCursor = last;
      await opts.setSession(chatId, s);
    }
  }

  /** one-shot: show latest mint once (only if we can attribute it) */
  async function sendLatestMintOnce(chatId: number) {
    const head = await latestBlock();
    const from = Math.max(0, head - LIVE_LATEST_BACKSCAN);
    const rows = await getMintLogsAsc(from, head);
    if (!rows.length) { dbg("latestMint.none", { window: LIVE_LATEST_BACKSCAN }); return; }
    const last = rows[rows.length - 1];
    const s = (await opts.getSession(chatId)) ?? { prefs: { enabled: false, usernames: [] } };
    await handleMint(chatId, last.bn, last.h, last.tokenId, s);
  }

  let tid: number | undefined;

  return {
    async enable(chatId: number, session: MySession) {
      if (tid) { clearInterval(tid); tid = undefined; }
      await opts.setSession(chatId, session);

      const head = await latestBlock();
      console.log(`[mints] enable chat=${chatId} head=${head} (polling @ ${POLL_MS}ms)`);

      // baseline first so one-shot/poll ordering is deterministic
      session.prefs.lastCursor = { bn: head, txi: 9_999_999, li: 9_999_999 };
      await opts.setSession(chatId, session);

      // try to show the latest (only if attributed)
      await sendLatestMintOnce(chatId);

      // start live polling
      tid = setInterval(() => { pollOnce(chatId); }, POLL_MS) as unknown as number;
      console.log(`[mints] enabled (polling) chat=${chatId}`);
    },

    async pause(chatId: number) {
      if (tid) { clearInterval(tid); tid = undefined; }
      pending.clear();
      console.log(`[mints] paused chat=${chatId}`);
    },

    __pollOnce: (chatId: number) => pollOnce(chatId),
  };
}
