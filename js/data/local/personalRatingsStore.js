// Personal 0-10 ratings (0.5 steps) for movies, series and episodes, kept per
// profile on this device. They are not part of Nuvio profile cloud sync.
import { LocalStore } from "../../core/storage/localStore.js";
import { ProfileManager } from "../../core/profile/profileManager.js";

const KEY = "personalRatings";
export const PERSONAL_RATING_MIN = 0;
export const PERSONAL_RATING_MAX = 10;
export const PERSONAL_RATING_STEP = 0.5;

const listeners = new Set();

export function normalizePersonalRating(value) {
  const rating = Number(value);
  if (value == null || value === "" || !Number.isFinite(rating)) return null;
  const clamped = Math.min(PERSONAL_RATING_MAX, Math.max(PERSONAL_RATING_MIN, rating));
  return Math.round(clamped / PERSONAL_RATING_STEP) * PERSONAL_RATING_STEP;
}

export function formatPersonalRating(value) {
  const rating = normalizePersonalRating(value);
  return rating == null ? "" : rating.toFixed(1);
}

// Episodes are keyed by their video id; movies and series by the item id.
export function personalRatingKey({ itemId = "", videoId = "", episode = false } = {}) {
  const id = String((episode ? videoId : itemId) || "").trim();
  return id ? `${episode ? "episode" : "title"}:${id}` : "";
}

function activeProfileId() {
  return String(ProfileManager.getActiveProfileId() ?? "1").trim() || "1";
}

// Episode cards read ratings once per card, so reuse the parsed value until
// the stored string changes.
let cachedRead = { raw: undefined, value: null };

// Callers must not mutate the result; set() works on a copy.
function readAll() {
  let raw = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch (_) {
    raw = null;
  }
  if (raw !== cachedRead.raw) {
    const stored = LocalStore.get(KEY, null);
    cachedRead = {
      raw,
      value:
        stored &&
        typeof stored === "object" &&
        stored.profiles &&
        typeof stored.profiles === "object"
          ? stored
          : { profiles: {} }
    };
  }
  return cachedRead.value;
}

export const PersonalRatingsStore = {
  get(key) {
    if (!key) return null;
    const entry = readAll().profiles[activeProfileId()]?.[key];
    return normalizePersonalRating(entry?.rating);
  },

  set(key, value, { title = "" } = {}) {
    if (!key) return;
    const rating = normalizePersonalRating(value);
    const current = readAll();
    const all = { ...current, profiles: { ...current.profiles } };
    const profileId = activeProfileId();
    const ratings = { ...(all.profiles[profileId] || {}) };
    if (rating == null) delete ratings[key];
    else ratings[key] = { rating, title: String(title || "").slice(0, 120), updatedAt: Date.now() };
    all.profiles[profileId] = ratings;
    LocalStore.set(KEY, all);
    listeners.forEach((listener) => listener(key, rating));
  },

  subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }
};
