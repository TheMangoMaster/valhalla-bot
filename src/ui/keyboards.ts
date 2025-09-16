import { Keyboard } from "../../deps.ts";

export const mainMenu = () =>
  new Keyboard()
    .text("▶️ Enable Mints").text("⏸️ Pause Mints").row()
    .text("🎯 Set Filters").text("🧹 Manage Filters").row()
    .text("📊 Status").text("❓ Help")
    .resized();
