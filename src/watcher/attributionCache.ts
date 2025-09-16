// src/watcher/attributionCache.ts
// Short-lived mapping: veraId -> { charId, username, expiresAt }
const TTL_MS = Number(Deno.env.get("VALHALLA_ATTRIB_TTL_MS") ?? "1800000"); // 5 min

type Attrib = { charId: bigint; username: string | null; expiresAt: number };

const map = new Map<string, Attrib>(); // key as string(veraId)

function now() { return Date.now(); }
function keyOf(veraId: bigint) { return String(veraId); }

function prune() {
  const t = now();
  if (map.size > 5000) {
    for (const [k, v] of map) if (v.expiresAt <= t) map.delete(k);
  } else {
    // light pruning
    for (const [k, v] of map) { if (v.expiresAt <= t) { map.delete(k); break; } }
  }
}

export function setFromEncounter(veraId: bigint, charId: bigint, username: string | null) {
  prune();
  map.set(keyOf(veraId), { charId, username, expiresAt: now() + TTL_MS });
}

export function getAttribution(veraId: bigint): { charId: bigint; username: string | null } | null {
  prune();
  const v = map.get(keyOf(veraId));
  if (!v) return null;
  if (v.expiresAt <= now()) { map.delete(keyOf(veraId)); return null; }
  return { charId: v.charId, username: v.username };
}