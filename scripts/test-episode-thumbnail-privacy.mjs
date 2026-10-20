import assert from "node:assert/strict";
import { build } from "esbuild";
import { shouldBlurContinueWatchingThumbnail as blur } from "../js/core/util/episodeThumbnailPrivacy.js";

const episode = { contentType: "series", positionMs: 300, durationMs: 1000 };
const enabled = { enabled: true, useEpisodeThumbnails: true };
assert.equal(blur(episode, enabled), true, "partially watched episode stays protected");
assert.equal(blur({ ...episode, positionMs: 900 }, enabled), false, "completed episode is revealed");
assert.equal(blur({ ...episode, isNextUp: true, positionMs: 1000 }, enabled), true, "Next Up ignores inherited previous progress");
assert.equal(blur({ ...episode, isNextUp: true, isWatched: true }, enabled), false, "watched shuffle selections are revealed");
assert.equal(blur({ ...episode, contentType: "movie" }, enabled), false);
assert.equal(blur({ ...episode, contentType: "anime" }, enabled), true);
assert.equal(blur(episode, { ...enabled, useEpisodeThumbnails: false }), false);
assert.equal(blur(episode, { ...enabled, enabled: false }), false);
assert.equal(blur({ ...episode, isNextUp: true }, { ...enabled, enabled: false, blurNextUp: true }), true);
assert.equal(blur({ ...episode, source: "simkl_playback", positionMs: 800 }, enabled), false);

// Bundle the real privacy loader with controlled repository/profile dependencies.
// Exercise delayed reads without bringing the browser or tracking network into Node.
const state = {
  enabled: true,
  profile: "one",
  watched: async () => [],
  progress: async () => []
};
globalThis.__thumbnailPrivacyTest = state;
const mocks = {
  "profileManager.js": "export const ProfileManager = { getActiveProfileId: () => globalThis.__thumbnailPrivacyTest.profile };",
  "layoutPreferences.js": "export const LayoutPreferences = { get: () => ({ blurUnwatchedEpisodes: globalThis.__thumbnailPrivacyTest.enabled }) };",
  "watchedItemsRepository.js": "export const watchedItemsRepository = { getAll: (...args) => globalThis.__thumbnailPrivacyTest.watched(...args) };",
  "watchProgressRepository.js": "export const watchProgressRepository = { getAll: (...args) => globalThis.__thumbnailPrivacyTest.progress(...args) };"
};
async function load(entry) {
  const result = await build({
    entryPoints: [entry], bundle: true, write: false, platform: "node", format: "esm",
    plugins: [{
      name: "controlled-repositories",
      setup(builder) {
        builder.onResolve({ filter: /\.js$/ }, (args) => {
          const name = args.path.split("/").pop();
          return mocks[name] ? { path: name, namespace: "mock" } : undefined;
        });
        builder.onLoad({ filter: /.*/, namespace: "mock" }, (args) => ({ contents: mocks[args.path] }));
      }
    }]
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}
const { refreshEpisodePanelWatchedState: refresh, shouldBlurPlayerEpisode } = await load("js/ui/screens/player/episodePanelThumbnailPrivacy.js");
function screen() {
  const episodes = [1, 2, 3].map((episode) => ({ id: `show:1:${episode}`, season: 1, episode }));
  const blurred = [true, true, true];
  return {
    params: { itemId: "show", itemType: "series" },
    episodes, blurred, playerMountToken: 1,
    isActiveMountToken(token) { return this.playerMountToken === token; },
    uiRefs: { root: { querySelectorAll: () => episodes.map((_, index) => ({
      dataset: { episodeIndex: String(index) },
      querySelector: () => ({ classList: { toggle: (_, value) => { blurred[index] = value; } } })
    })) } }
  };
}
state.watched = async () => [
  { contentId: "show", season: 1, episode: 1 },
  { contentId: "other-show", season: 1, episode: 3 }
];
state.progress = async () => [
  { contentId: "show", videoId: "show:1:2", positionMs: 900, durationMs: 1000 }
];
const first = screen();
await refresh(first);
assert.deepEqual(first.blurred, [false, false, true], "watched and completed episodes revealed, unrelated show ignored");
assert.equal(shouldBlurPlayerEpisode(first, first.episodes[2]), true);
assert.equal(shouldBlurPlayerEpisode(first, first.episodes[0]), false);

let resolveWatched;
state.watched = () => new Promise((resolve) => { resolveWatched = resolve; });
state.progress = async () => [];
const delayed = screen();
delayed.episodePanelWatchedKeys = new Set(["1:1"]);
const pending = refresh(delayed);
assert.equal(shouldBlurPlayerEpisode(delayed, delayed.episodes[0]), true, "stale state is cleared before the first render");
state.profile = "two";
resolveWatched([{ contentId: "show", season: 1, episode: 1 }]);
await pending;
assert.deepEqual(delayed.blurred, [true, true, true], "late result cannot reveal another profile's artwork");

state.watched = async () => { throw new Error("offline"); };
const offline = screen();
await refresh(offline);
assert.deepEqual(offline.blurred, [true, true, true], "failed lookup stays protected");
state.enabled = false;
assert.equal(shouldBlurPlayerEpisode(offline, offline.episodes[0]), false);

state.enabled = true;
const { buildHeroBackdropSources } = await load("js/ui/screens/home/homeImageHelpers.js");
const hero = { ...episode, heroSource: "continueWatching", background: "series.jpg", thumbnail: "spoiler.jpg", episodeThumbnail: "spoiler.jpg" };
assert.deepEqual(buildHeroBackdropSources(hero), ["series.jpg"], "hero fallbacks cannot reveal protected episode stills");
assert.ok(buildHeroBackdropSources({ ...hero, isWatched: true }).includes("spoiler.jpg"));
delete globalThis.__thumbnailPrivacyTest;
console.log("Episode thumbnail privacy: all checks passed.");
