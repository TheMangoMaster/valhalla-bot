// src/state.ts
import { session } from "../deps.ts";
import type { Context } from "../deps.ts";

/** Cursor for ordered processing */
export type Cursor = { bn: number; txi: number; li: number };

/** Per-user prefs */
export type UserPrefs = {
  enabled: boolean;
  usernames: string[];
  lastCursor?: Cursor;     // single source of truth for progress
};

/** Session object */
export type MySession = {
  prefs: UserPrefs;
  awaitingFilters?: boolean;
  awaitingFiltersMode?: "add" | "replace";
  menuMsgId?: number;
  pvpEnabled?: boolean;
};

// Detect KV availability; otherwise use file storage
const hasKV = typeof (Deno as any).openKv === "function";
const STATE_PATH = Deno.env.get("VALHALLA_STATE_PATH") ?? "./state.json";

// ---------- File storage helpers ----------
type SessionMap = Record<string, MySession>;

async function readFileMap(): Promise<SessionMap> {
  try {
    const txt = await Deno.readTextFile(STATE_PATH);
    const raw = JSON.parse(txt) as Record<string, any>;
    return raw as SessionMap;
  } catch {
    return {};
  }
}

async function writeFileMap(map: SessionMap) {
  await Deno.writeTextFile(STATE_PATH, JSON.stringify(map, null, 2));
}

console.log(
  hasKV
    ? "[session] Using Deno KV"
    : `[session] Using file storage at ${STATE_PATH}`,
);

// ---------- grammY session middleware ----------
export const sessionMiddleware = session<MySession, Context>({
  initial: (): MySession => ({
    prefs: { enabled: false, usernames: [] },
    pvpEnabled: false, 
  }),

  storage: hasKV
    ? {
        async read(key: string) {
          const kv = await (Deno as any).openKv();
          const res = await kv.get(["session", key]);
          kv.close?.();
          return (res?.value ?? undefined) as MySession | undefined;
        },
        async write(key: string, value: MySession) {
          const kv = await (Deno as any).openKv();
          await kv.set(["session", key], value);
          kv.close?.();
        },
        async delete(key: string) {
          const kv = await (Deno as any).openKv();
          await kv.delete(["session", key]);
          kv.close?.();
        },
      }
    : {
        async read(key: string) {
          const map = await readFileMap();
          return map[key];
        },
        async write(key: string, value: MySession) {
          const map = await readFileMap();
          map[key] = value;
          await writeFileMap(map);
        },
        async delete(key: string) {
          const map = await readFileMap();
          delete map[key];
          await writeFileMap(map);
        },
      },
});

// direct helpers (same backend as middleware)
export async function readSessionByKey(key: string): Promise<MySession | undefined> {
  if (hasKV) {
    const kv = await (Deno as any).openKv();
    const res = await kv.get(["session", key]);
    kv.close?.();
    return (res?.value ?? undefined) as MySession | undefined;
  } else {
    try {
      const txt = await Deno.readTextFile(STATE_PATH);
      const raw = JSON.parse(txt);
      return raw[key] as MySession | undefined;
    } catch {
      return undefined;
    }
  }
}

export async function writeSessionByKey(key: string, value: MySession): Promise<void> {
  if (hasKV) {
    const kv = await (Deno as any).openKv();
    await kv.set(["session", key], value);
    kv.close?.();
  } else {
    const map = await readFileMap();
    map[key] = value;
    await writeFileMap(map);
  }
}