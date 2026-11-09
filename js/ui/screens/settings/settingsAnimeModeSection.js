// Anime settings (filler markers ported from NuvioCodeineXO).
import { ProfileManager } from "../../../core/profile/profileManager.js";
import { AnimeMode } from "../../../core/anime/animeMode.js";

export function renderAnimeModeSection() {
  const state = AnimeMode.get();
  const pid = ProfileManager.getActiveProfileId();
  const mount = this.settingsMountToken;
  const current = () =>
    this.isMounted &&
    this.activeSection === "animeMode" &&
    this.settingsMountToken === mount &&
    ProfileManager.getActiveProfileId() === pid;

  this.actionMap.set(
    "anime:fillerBadges",
    () => current() && AnimeMode.set({ fillerBadges: !AnimeMode.get().fillerBadges })
  );
  this.actionMap.set(
    "anime:hideFillers",
    () => current() && AnimeMode.set({ hideFillers: !AnimeMode.get().hideFillers })
  );

  const rows = [
    this.renderToggleRow({
      focusKey: "anime:fillerBadges",
      title: "Filler Markers",
      subtitle: "Mark filler and mixed-canon anime episodes (AnimeFillerList).",
      checked: state.fillerBadges !== false
    })
  ];
  if (state.fillerBadges !== false) {
    rows.push(
      this.renderToggleRow({
        focusKey: "anime:hideFillers",
        title: "Hide Filler Episodes",
        subtitle:
          "Leave pure filler episodes out of episode lists and up-next. Mixed-canon episodes stay.",
        checked: state.hideFillers === true
      })
    );
  }
  return `<div class="settings-stack">${rows.join("")}</div>`;
}
