// Anime enhancements ported from NuvioCodeineXO: filler / mixed-canon markers and hiding
// pure filler episodes. Regular per-profile settings; nothing here changes the app's look.
import { LocalStore } from "../storage/localStore.js";
import { ProfileManager } from "../profile/profileManager.js";

const KEY_PREFIX = "animeMode";
const DEFAULTS = Object.freeze({ fillerBadges: true, hideFillers: false });

function storageKey() {
  const profileId = String(ProfileManager.getActiveProfileId?.() ?? "1").trim() || "1";
  return `${KEY_PREFIX}:${profileId}`;
}

function read() {
  const stored = LocalStore.get(storageKey(), null);
  return { ...DEFAULTS, ...(stored && typeof stored === "object" ? stored : {}) };
}

export const AnimeMode = {
  get() {
    return read();
  },

  showFillerBadges() {
    return read().fillerBadges !== false;
  },

  hidingFillers() {
    const state = read();
    return state.fillerBadges !== false && state.hideFillers === true;
  },

  set(partial = {}) {
    LocalStore.set(storageKey(), { ...read(), ...partial });
  }
};
