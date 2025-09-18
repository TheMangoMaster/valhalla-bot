import { InlineKeyboard } from "../../deps.ts";

export function mainMenuInline(enabled: boolean, usernames: string[], pvpEnabled: boolean) {
  return new InlineKeyboard()
    .text(enabled ? "⏸️ Pause Encounters" : "▶️ Enable Encounters", "menu:toggle")
    .text(pvpEnabled ? "⏸️ PvP Alerts" : "▶️ PvP Alerts", "menu:pvp_toggle").row()
    .text("⚙️ Settings", "menu:settings")
    .text("📊 Status", "menu:status").row()
    .text("❓ Help", "menu:help");
}

export function settingsInline() {
  return new InlineKeyboard()
      .text("🔁 Sync Encounters", "settings:sync_enc")
      .text("🔁 Sync PvP", "settings:sync_pvp").row()
      .text("🎯 Set Filters", "menu:set_filters")
      .text("🧹 Manage Filters", "menu:manage").row()
      .text("⬅️ Back", "menu:back");
}

export function manageFiltersInline(usernames: string[]) {
  const kb = new InlineKeyboard();
  if (usernames.length) {
    for (const u of usernames) kb.text(`❌ ${u}`, `filter:del:${encodeURIComponent(u)}`).row();
    kb.text("Clear all", "filter:clear").row();
  }
  return kb.text("⬅️ Back", "menu:back");
}

/** Inline controls shown under each Vera card */
export function veraInline(enabled: boolean) {
  return new InlineKeyboard()
    .text(enabled ? "⏸️ Pause" : "▶️ Enable", "vera:toggle")
    .text("⬅️ Menu", "vera:menu");
}

export function setFiltersModeInline() {
  return new InlineKeyboard()
    .text("➕ Add to existing", "filters:add").row()
    .text("♻️ Replace all", "filters:replace").row()
    .text("⬅️ Back", "menu:back");
}

export function helpInline() {
  return new InlineKeyboard().text("⬅️ Back to Menu", "menu:back");
}

export function backToMenuInline() {
  return new InlineKeyboard().text("⬅️ Back to Menu", "menu:back");
}
