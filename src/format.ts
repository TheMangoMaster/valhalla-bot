import { InnateStats, statWithTier, sumStats } from "./tiers.ts";
import { PERSONALITY, getSpeciesName } from "../config.ts";

export async function formatVeraCard(params: {
  veraId: bigint;
  level: number;
  speciesId: number;
  personality?: number | null;
  username?: string | null;
  innate: InnateStats;
}) {
  const speciesName = await getSpeciesName(params.speciesId);

  const stats = (["strength","dexterity","vitality","intellect","wisdom","charisma"] as const)
    .map(k => statWithTier(k, params.innate[k]));
  const total = sumStats(params.innate);
  const persona = params.personality ? PERSONALITY[params.personality as 1|2|3] : "—";

  const user = params.username || "Unknown";

  const isBoss = params.speciesId >= 200 || params.speciesId === 255; // tweak rule as you like
  const speciesLabel = isBoss ? `${speciesName} <b>(BOSS)</b>` : speciesName;

  const lines = [
    `🪄 Vera #<code>${params.veraId}</code> Encountered!`,
    ``,
    `Species: <b>${speciesLabel}</b>`,
    `Lv ${params.level} · Personality: <b>${persona}</b>`,
    `Player: <code>${user}</code>`,
    ``,
    `<b>Stats:</b>`,
    ...stats.map(s => `• ${label(s.name)}: <b>${s.value}</b> · ${s.tier}`),
    ``,
    `✨ Total Stats: <b>${total}</b>`,
  ];

  return lines.join("\n");
}

function label(k: keyof InnateStats) {
  const m: Record<string,string> = {
    strength: "STR",
    dexterity: "DEX",
    vitality: "VIT",
    intellect: "INT",
    wisdom: "WIS",
    charisma: "CHR",
  };
  return m[k];
}
