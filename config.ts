import { load } from "./deps.ts";

const env = await load({ export: true });

export const BOT_TOKEN = (Deno.env.get("BOT_TOKEN") ?? env.BOT_TOKEN ?? "").trim();
if (!BOT_TOKEN) {
  throw new Error("BOT_TOKEN is empty or missing. Check your .env or environment.");
}
export const OPBNB_RPC_WS = Deno.env.get("OPBNB_RPC_WS") ?? env.OPBNB_RPC_WS!;
export const OPBNB_RPC_HTTP = Deno.env.get("OPBNB_RPC_HTTP") ?? env.OPBNB_RPC_HTTP!;

export const ENTRY_POINT = Deno.env.get("ENTRY_POINT") ?? env.ENTRY_POINT!;
export const VERA_ERC721 = Deno.env.get("VERA_ERC721") ?? env.VERA_ERC721!;

// config.ts
// ...your other exports...

// Default baked-in names (fallback if JSON is missing)
const DEFAULT_SPECIES: Record<number, string> = {
  1: "Bjorn",
  2: "Madhattr",
  3: "Hushroom",
  4: "Skaerrot",
  5: "Bigghaer",
  6: "Klautjasar",
  7: "Igby",
  8: "Flindorr",
  9: "Orni",
  10: "Grabbur",
  11: "Trojun",
};

// Lazy-loaded cache from assets/vera/species.json
let SPECIES_CACHE: Record<number, string> | null = null;

async function loadSpeciesJson(): Promise<Record<number, string>> {
  try {
    const text = await Deno.readTextFile("assets/vera/species.json");
    const raw = JSON.parse(text) as Record<string, string>;
    const normalized: Record<number, string> = {};
    for (const [k, v] of Object.entries(raw)) {
      const id = Number(k);
      if (Number.isFinite(id) && typeof v === "string" && v.trim()) {
        normalized[id] = v.trim();
      }
    }
    return { ...DEFAULT_SPECIES, ...normalized };
  } catch {
    // If file missing or invalid, use defaults only
    return { ...DEFAULT_SPECIES };
  }
}

/** Get a display name for speciesId, with graceful fallback */
export async function getSpeciesName(speciesId: number): Promise<string> {
  if (!SPECIES_CACHE) SPECIES_CACHE = await loadSpeciesJson();
  return SPECIES_CACHE[speciesId] ?? `Species #${speciesId}`;
}

/** Optional: expose a manual refresh if you want to hot-reload at runtime */
export async function refreshSpeciesNames() {
  SPECIES_CACHE = await loadSpeciesJson();
}

export const PERSONALITY = { 1: "Shy", 2: "Serious", 3: "Aggressive" } as const;