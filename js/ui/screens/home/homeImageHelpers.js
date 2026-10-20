import { LayoutPreferences } from "../../../data/local/layoutPreferences.js";
import { shouldBlurContinueWatchingThumbnail } from "../../../core/util/episodeThumbnailPrivacy.js";
import { uniqueNonEmptyValues } from "./homeUtils.js";
import { normalizeTmdbBackdropUrl } from "../../../core/tmdb/tmdbImageUrl.js";

/**
 * Builds the ordered list of image candidates used by hero, poster and continue-watching cards.
 * @param {import("./homeTypes.js").HomeMediaSourceLike | null | undefined} item
 * @returns {string[]}
 */
export function buildHeroBackdropSources(item = null) {
  const sources = uniqueNonEmptyValues([
    normalizeTmdbBackdropUrl(item?.background),
    normalizeTmdbBackdropUrl(item?.backdrop),
    normalizeTmdbBackdropUrl(item?.backdropUrl),
    normalizeTmdbBackdropUrl(item?.landscapePoster),
    item?.poster,
    item?.thumbnail,
    item?.episodeThumbnail
  ]);
  // Hero backgrounds can fall back to episode stills. Keep series artwork, but
  // do not reveal a protected thumbnail through that fallback path.
  if (item?.heroSource !== "continueWatching" || !shouldBlurContinueWatchingThumbnail(item, {
    enabled: Boolean(LayoutPreferences.get().blurUnwatchedEpisodes),
    useEpisodeThumbnails: true
  })) return sources;
  const protectedSources = new Set(
    [item?.thumbnail, item?.episodeThumbnail].filter(Boolean).map(normalizeTmdbBackdropUrl)
  );
  return sources.filter((source) => !protectedSources.has(normalizeTmdbBackdropUrl(source)));
}

export function encodeHeroBackdropFallbacks(sources = []) {
  return sources.map((source) => encodeURIComponent(source)).join("|");
}

export function buildImageFallbackErrorHandler() {
  return "var q=(this.dataset.fallbackSrcs||'').split('|').filter(Boolean);var next=q.shift();if(next){this.dataset.fallbackSrcs=q.join('|');this.src=decodeURIComponent(next);return;}this.removeAttribute('src');this.classList.add('placeholder');";
}
