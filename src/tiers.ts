export type InnateStats = {
  strength: number;
  dexterity: number;
  vitality: number;
  intellect: number;
  wisdom: number;
  charisma: number;
};

export function sumStats(s: InnateStats): number {
  return s.strength + s.dexterity + s.vitality + s.intellect + s.wisdom + s.charisma;
}

// Vitality uses +10 thresholds
function tierFor(statName: keyof InnateStats, value: number): string {
  const adj = statName === "vitality" ? 10 : 0;
  const RUBY    = 31 + adj;
  const DIAMOND = 26 + adj;
  const GOLD    = 21 + adj;
  const SILVER  = 16 + adj;
  const BRONZE  = 11 + adj;

  if (value >= RUBY)    return "♦️ Ruby";
  if (value >= DIAMOND) return "💎 Diamond";
  if (value >= GOLD)    return "🔶 Gold";
  if (value >= SILVER)  return "⚪️ Silver";
  if (value >= BRONZE)  return "🟤 Bronze";
  return "⚫️ Rough";
}

export function statWithTier(name: keyof InnateStats, value: number) {
  return { name, value, tier: tierFor(name, value) };
}
