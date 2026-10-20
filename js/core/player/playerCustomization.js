// Player bar layout and anime playback speed preferences.
// Play/Pause always leads the bar and the More/Back button always closes it, so
// only the controls between them are configurable.

export const PLAYER_CONTROL_PLACEMENTS = ["bar", "more", "hidden"];

export const DEFAULT_PLAYER_CONTROL_LAYOUT = [
  { id: "playNextEpisode", placement: "bar" },
  { id: "subtitleDialog", placement: "bar" },
  { id: "audioTrack", placement: "bar" },
  { id: "source", placement: "bar" },
  { id: "episodes", placement: "bar" },
  { id: "party", placement: "bar" },
  { id: "speed", placement: "more" },
  { id: "aspect", placement: "more" },
  { id: "streamInfo", placement: "more" }
];

const CONTROL_IDS = DEFAULT_PLAYER_CONTROL_LAYOUT.map((entry) => entry.id);

export const ANIME_PLAYBACK_SPEED_OPTIONS = [1.25, 1.5, 1.75, 2];
export const DEFAULT_ANIME_PLAYBACK_SPEED = 1.5;

export function normalizePlayerControlLayout(value) {
  const seen = new Set();
  const layout = [];
  (Array.isArray(value) ? value : []).forEach((entry) => {
    const id = String(entry?.id || "");
    if (!CONTROL_IDS.includes(id) || seen.has(id)) {
      return;
    }
    seen.add(id);
    const placement = PLAYER_CONTROL_PLACEMENTS.includes(entry?.placement)
      ? entry.placement
      : "bar";
    layout.push({ id, placement });
  });
  // Controls added in later versions keep their default slot.
  DEFAULT_PLAYER_CONTROL_LAYOUT.forEach((entry, defaultIndex) => {
    if (seen.has(entry.id)) {
      return;
    }
    const nextKnown = DEFAULT_PLAYER_CONTROL_LAYOUT.slice(defaultIndex + 1).find((later) =>
      seen.has(later.id)
    );
    const insertAt = nextKnown
      ? layout.findIndex((item) => item.id === nextKnown.id)
      : layout.length;
    layout.splice(insertAt, 0, { ...entry });
    seen.add(entry.id);
  });
  return layout;
}

// Orders the available controls (keyed by action) into bar and More lists.
// Controls that are unavailable for the current item are skipped without
// disturbing the relative order of the rest.
export function arrangePlayerControls(availableByAction, layout) {
  const bar = [];
  const more = [];
  normalizePlayerControlLayout(layout).forEach(({ id, placement }) => {
    const control = availableByAction[id];
    if (!control || placement === "hidden") {
      return;
    }
    (placement === "more" ? more : bar).push(control);
  });
  return { bar, more };
}

// Moves a control to a 1-based position among bar or More controls, or hides it.
export function placePlayerControl(layout, id, placement, position = Infinity) {
  const normalized = normalizePlayerControlLayout(layout);
  const moving = normalized.find((entry) => entry.id === id);
  if (!moving || !PLAYER_CONTROL_PLACEMENTS.includes(placement)) {
    return normalized;
  }
  const rest = normalized.filter((entry) => entry.id !== id);
  const group = rest.filter((entry) => entry.placement === placement);
  const index = Math.max(0, Math.min(group.length, Math.trunc(Number(position) || 1) - 1));
  const anchor = group[index];
  const insertAt = anchor
    ? rest.indexOf(anchor)
    : group.length
      ? rest.indexOf(group[group.length - 1]) + 1
      : rest.length;
  rest.splice(insertAt, 0, { id, placement });
  return rest;
}

export function getPlayerControlSlot(layout, id) {
  const normalized = normalizePlayerControlLayout(layout);
  const entry = normalized.find((item) => item.id === id);
  if (!entry) {
    return null;
  }
  const group = normalized.filter((item) => item.placement === entry.placement);
  return {
    placement: entry.placement,
    position: group.indexOf(entry) + 1,
    groupSize: group.length
  };
}

export function normalizeAnimePlaybackSpeed(value) {
  const speed = Number(value);
  return ANIME_PLAYBACK_SPEED_OPTIONS.includes(speed) ? speed : DEFAULT_ANIME_PLAYBACK_SPEED;
}

const ANIME_ID_PREFIXES = ["kitsu:", "mal:", "anilist:", "anidb:"];

function normalizeGenreNames(genres) {
  return (Array.isArray(genres) ? genres : [])
    .map((genre) =>
      String(genre?.name ?? genre ?? "")
        .trim()
        .toLowerCase()
    )
    .filter(Boolean);
}

function isJapaneseOrigin(meta) {
  const language = String(meta?.originalLanguage || meta?.original_language || "")
    .trim()
    .toLowerCase();
  if (language === "ja" || language === "jpn" || language === "japanese") {
    return true;
  }
  const countries = [meta?.country, meta?.originCountry, meta?.origin_country]
    .flat()
    .map((country) => String(country || "").toLowerCase());
  return countries.some((country) => /(^|[\s,;])(jp|jpn|japan)($|[\s,;])/.test(country));
}

export function isAnimeContent({ itemId = "", itemType = "", meta = null } = {}) {
  const id = String(itemId || meta?.id || "")
    .trim()
    .toLowerCase();
  if (ANIME_ID_PREFIXES.some((prefix) => id.startsWith(prefix))) {
    return true;
  }
  if (
    String(itemType || meta?.type || "")
      .trim()
      .toLowerCase() === "anime"
  ) {
    return true;
  }
  const genres = normalizeGenreNames(meta?.genres);
  if (genres.includes("anime")) {
    return true;
  }
  return genres.includes("animation") && isJapaneseOrigin(meta);
}
