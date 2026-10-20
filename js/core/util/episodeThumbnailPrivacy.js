import { isWatchProgressCompleted } from "../../domain/model/watchProgress.js";

export function shouldBlurContinueWatchingThumbnail(item = {}, options = {}) {
  const type = String(item.contentType || item.type || "").toLowerCase();
  if (!["series", "tv", "anime"].includes(type) || !options.useEpisodeThumbnails) return false;
  if (item.isWatched || (!item.isNextUp && isWatchProgressCompleted(item))) return false;
  // The global option also protects partially watched episodes. Keep the older
  // Next Up switch working independently when global protection is disabled.
  return Boolean(options.enabled || (options.blurNextUp && item.isNextUp));
}
