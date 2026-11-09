// Filler / mixed-canon episode markers from AnimeFillerList, ported from NuvioCodeineXO.
// Requests go through the platform service fetch so the site's missing CORS headers don't matter.
import { LocalStore } from "../storage/localStore.js";
import { PluginServiceClient } from "../../platform/pluginServiceClient.js";
import { AnimeMode } from "./animeMode.js";

const AFL_BASE_URL = "https://www.animefillerlist.com";
const CACHE_PREFIX = "animeFillerCache:v2:";
const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml"
};
const ANIME_ID_PREFIXES = ["kitsu:", "mal:", "anidb:", "anilist:"];

const statusByVideoId = new Map();
// Same markers by show + season + episode, saved per show so Continue Watching and the player
// can show them later (also after a restart) without reloading the show.
const SHOW_PREFIX = "animeFillerShow:v1:";
const showCache = new Map();

function showMarkers(metaId) {
  const id = String(metaId || "");
  if (!id) return null;
  if (!showCache.has(id)) {
    const stored = LocalStore.get(SHOW_PREFIX + id, null);
    showCache.set(id, stored && typeof stored === "object" ? stored : {});
  }
  return showCache.get(id);
}
const resolvedMetaIds = new Set();
let showDirectory = null;

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

export function isAnimeMeta(meta) {
  if (!meta) return false;
  if (String(meta.type || "").toLowerCase() === "anime") return true;
  const id = String(meta.id || "").toLowerCase();
  if (ANIME_ID_PREFIXES.some((prefix) => id.startsWith(prefix))) return true;
  const genres = (Array.isArray(meta.genres) ? meta.genres : []).map((genre) =>
    String(genre).toLowerCase()
  );
  if (genres.includes("anime")) return true;
  const japanese =
    /\b(jp|jpn|japan)\b/i.test(String(meta.country || "")) ||
    /^(ja|jpn|japanese)\b/i.test(String(meta.language || ""));
  return genres.includes("animation") && japanese;
}

export function slugify(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function cleanShowTitle(title) {
  return String(title || "")
    .replace(/\s*\([^)]*\)/g, "")
    .replace(/:/g, "")
    .replace(/-/g, " ")
    .trim()
    .toLowerCase();
}

export function parseAflHtml(html) {
  const fillers = new Set();
  const mixed = new Set();
  const condensed =
    /<div class="([^"]*(?:filler|mixed)[^"]*)"[^>]*>[\s\S]*?<span class="Episodes">([\s\S]*?)<\/span>/g;
  let match;
  while ((match = condensed.exec(html))) {
    const target = /mixed/i.test(match[1]) ? mixed : /filler/i.test(match[1]) ? fillers : null;
    if (!target) continue;
    const text = match[2].replace(/<[^>]+>/g, " ");
    const ranges = /(\d+)(?:\s*-\s*(\d+))?/g;
    let range;
    while ((range = ranges.exec(text))) {
      const start = Number(range[1]);
      const end = range[2] ? Number(range[2]) : start;
      if (end >= start && end - start < 2000) {
        for (let episode = start; episode <= end; episode += 1) target.add(episode);
      }
    }
  }
  const rows = /<tr class="([^"]+)"[^>]*>\s*<td class="Number">(\d+)<\/td>/g;
  while ((match = rows.exec(html))) {
    const episode = Number(match[2]);
    if (/mixed/i.test(match[1])) mixed.add(episode);
    else if (/filler/i.test(match[1])) fillers.add(episode);
  }
  mixed.forEach((episode) => fillers.delete(episode));
  return { fillers, mixed };
}

async function fetchText(url) {
  const response = await PluginServiceClient.fetch({
    url,
    method: "GET",
    headers: HEADERS,
    timeoutMs: 8000
  });
  return response?.ok ? String(response.body || "") : null;
}

async function findSlugInDirectory(title) {
  if (!showDirectory) {
    const html = await fetchText(`${AFL_BASE_URL}/shows`).catch(() => null);
    if (!html) return null;
    showDirectory = new Map();
    const links = /<a href="\/shows\/([^"]+)">([^<]+)<\/a>/g;
    let match;
    while ((match = links.exec(html))) showDirectory.set(cleanShowTitle(match[2]), match[1]);
  }
  const target = cleanShowTitle(title);
  if (!target) return null;
  if (showDirectory.has(target)) return showDirectory.get(target);
  for (const [name, slug] of showDirectory) {
    if (name.length > 3 && (name.includes(target) || target.includes(name))) return slug;
  }
  return null;
}

async function fetchFillerEpisodes(name) {
  const candidates = [slugify(name)];
  if (String(name).includes(":")) {
    candidates.push(slugify(String(name).split(":")[0]), slugify(String(name).replace(/:/g, "")));
  }
  const unique = [...new Set(candidates.filter(Boolean))];
  for (const slug of unique) {
    const html = await fetchText(`${AFL_BASE_URL}/shows/${slug}`).catch(() => null);
    if (html) {
      const parsed = parseAflHtml(html);
      if (parsed.fillers.size || parsed.mixed.size) return parsed;
    }
  }
  const matched = await findSlugInDirectory(name);
  if (matched && !unique.includes(matched)) {
    const html = await fetchText(`${AFL_BASE_URL}/shows/${matched}`).catch(() => null);
    if (html) return parseAflHtml(html);
  }
  return { fillers: new Set(), mixed: new Set() };
}

function cachedEpisodes(key) {
  const stored = LocalStore.get(CACHE_PREFIX + key, null);
  if (!stored || typeof stored !== "object") return null;
  return { fillers: new Set(stored.f || []), mixed: new Set(stored.m || []) };
}

/** Absolute anime episode number per video, counting through regular seasons in order. */
function absoluteNumbers(videos) {
  const regular = videos
    .filter((video) => Number(video.season) > 0 && Number(video.episode) > 0)
    .sort((a, b) => Number(a.season) - Number(b.season) || Number(a.episode) - Number(b.episode));
  const seasons = [...new Set(regular.map((video) => Number(video.season)))];
  const result = new Map();
  if (seasons.length <= 1) {
    regular.forEach((video) => result.set(video.id, Number(video.episode)));
    return result;
  }
  regular.forEach((video, index) => result.set(video.id, index + 1));
  return result;
}

export const AnimeFiller = {
  statusFor(videoId) {
    return statusByVideoId.get(String(videoId || "")) || null;
  },

  /** Marker by video id when known, else by show + season + episode (saved per show). */
  statusForEpisode({ metaId, season, episode, videoId } = {}) {
    const byVideo = videoId ? this.statusFor(videoId) : null;
    if (byVideo) return byVideo;
    if (season == null || episode == null) return null;
    return showMarkers(metaId)?.[`${Number(season)}:${Number(episode)}`] || null;
  },

  /** Badge markup for an episode known by show + season + episode. */
  episodeBadgeHtml(args = {}, extraClass = "") {
    if (!AnimeMode.showFillerBadges()) return "";
    const status = this.statusForEpisode(args);
    if (!status) return "";
    const label = status === "mixed" ? "MIXED" : "FILLER";
    const cls = `anime-episode-badge anime-episode-badge-${status}${extraClass ? ` ${extraClass}` : ""}`;
    return `<span class="${cls}" data-anime-badge><i></i>${escapeHtml(label)}</span>`;
  },

  badgeHtml(videoId) {
    if (!AnimeMode.showFillerBadges()) return "";
    const status = this.statusFor(videoId);
    if (!status) return "";
    const label = status === "mixed" ? "MIXED" : "FILLER";
    return `<span class="anime-episode-badge anime-episode-badge-${status}" data-anime-badge><i></i>${escapeHtml(label)}</span>`;
  },

  /** Drops pure filler episodes when Anime Mode is set to hide them (mixed canon stays). */
  filterEpisodes(episodes) {
    const list = Array.isArray(episodes) ? episodes : [];
    if (!AnimeMode.hidingFillers()) return list;
    return list.filter((episode) => this.statusFor(episode?.id) !== "filler");
  },

  /** Adds badges to episode cards already on screen (data can arrive after first render). */
  decorate(root) {
    if (!root?.querySelectorAll) return;
    root.querySelectorAll(".series-episode-card[data-video-id]").forEach((card) => {
      const existing = card.querySelector("[data-anime-badge]");
      const html = this.badgeHtml(card.getAttribute("data-video-id"));
      if (existing) {
        if (!html) existing.remove();
        return;
      }
      if (!html) return;
      const anchor = card.querySelector(".series-episode-badge");
      if (anchor) anchor.insertAdjacentHTML("afterend", html);
    });
  },

  async resolve(meta) {
    if (!AnimeMode.showFillerBadges() || !meta?.id || !isAnimeMeta(meta)) return false;
    const videos = Array.isArray(meta.videos) ? meta.videos : [];
    if (!videos.length || resolvedMetaIds.has(meta.id)) return resolvedMetaIds.has(meta.id);
    resolvedMetaIds.add(meta.id);
    try {
      const cacheKey = `id:${meta.id}`;
      let episodes = cachedEpisodes(cacheKey);
      if (!episodes) {
        episodes = await fetchFillerEpisodes(meta.name);
        LocalStore.set(CACHE_PREFIX + cacheKey, {
          f: [...episodes.fillers],
          m: [...episodes.mixed]
        });
      }
      if (!episodes.fillers.size && !episodes.mixed.size) return false;
      const markers = {};
      const videoById = new Map(videos.map((video) => [String(video.id), video]));
      absoluteNumbers(videos).forEach((absolute, videoId) => {
        const status = episodes.mixed.has(absolute)
          ? "mixed"
          : episodes.fillers.has(absolute)
            ? "filler"
            : null;
        if (!status) return;
        statusByVideoId.set(videoId, status);
        const video = videoById.get(String(videoId));
        if (video) markers[`${Number(video.season)}:${Number(video.episode)}`] = status;
      });
      showCache.set(String(meta.id), markers);
      LocalStore.set(SHOW_PREFIX + meta.id, markers);
      return true;
    } catch (error) {
      console.warn("Anime filler lookup failed", error);
      return false;
    }
  }
};
