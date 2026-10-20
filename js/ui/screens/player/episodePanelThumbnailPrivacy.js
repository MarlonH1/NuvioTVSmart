import { ProfileManager } from "../../../core/profile/profileManager.js";
import { episodeKey } from "../../../core/player/episodeShuffle.js";
import { LayoutPreferences } from "../../../data/local/layoutPreferences.js";
import { watchedItemsRepository } from "../../../data/repository/watchedItemsRepository.js";
import { watchProgressRepository } from "../../../data/repository/watchProgressRepository.js";
import { watchedItemsShareIdentity } from "../../../data/repository/watchedIdentity.js";
import { isWatchProgressCompleted } from "../../../domain/model/watchProgress.js";

export async function refreshEpisodePanelWatchedState(screen) {
  // Unknown state is protected immediately, before the first panel render.
  screen.episodePanelWatchedKeys = new Set();
  const request = {};
  screen.episodePanelWatchedRequest = request;
  if (!LayoutPreferences.get().blurUnwatchedEpisodes) return;
  const profileId = ProfileManager.getActiveProfileId();
  const mountToken = screen.playerMountToken;
  const contentId = screen.params?.itemId || screen.params?.contentId;
  if (!contentId) return;
  const reference = { ...screen.params, contentId };
  const [watched, progress] = await Promise.all([
    watchedItemsRepository.getAll(5000, profileId).catch(() => []),
    watchProgressRepository.getAll(profileId).catch(() => [])
  ]);
  if (
    screen.episodePanelWatchedRequest !== request ||
    !screen.isActiveMountToken(mountToken) ||
    ProfileManager.getActiveProfileId() !== profileId
  )
    return;
  const completed = [...watched, ...progress.filter(isWatchProgressCompleted)].filter((item) =>
    watchedItemsShareIdentity(item, reference)
  );
  screen.episodePanelWatchedKeys = new Set(
    screen.episodes
      .filter((episode) =>
        completed.some(
          (item) =>
            (item.videoId && item.videoId === episode.id) ||
            (item.season != null &&
              item.episode != null &&
              episodeKey(item) === episodeKey(episode))
        )
      )
      .map(episodeKey)
  );
  // Update only images, preserving remote focus and the selected season.
  screen.uiRefs?.root?.querySelectorAll("[data-episode-index]").forEach((card) => {
    const episode = screen.episodes[Number(card.dataset.episodeIndex)];
    card
      .querySelector(".player-episode-thumb")
      ?.classList.toggle(
        "is-blurred",
        Boolean(LayoutPreferences.get().blurUnwatchedEpisodes) &&
          !screen.episodePanelWatchedKeys.has(episodeKey(episode))
      );
  });
}

export function shouldBlurPlayerEpisode(screen, episode) {
  return (
    Boolean(LayoutPreferences.get().blurUnwatchedEpisodes) &&
    !screen.episodePanelWatchedKeys?.has(episodeKey(episode))
  );
}
