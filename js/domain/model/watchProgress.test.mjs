import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isPlaybackPositionComplete,
  isWatchProgressCompleted,
  isWatchProgressInProgress,
  watchProgressCompletedThreshold
} from "./watchProgress.js";

test("Simkl playback at 80 percent counts as completed", () => {
  const progress = { source: "simkl_playback", progressPercent: 80 };

  assert.equal(watchProgressCompletedThreshold(progress), 0.8);
  assert.equal(isWatchProgressCompleted(progress), true);
  assert.equal(isWatchProgressInProgress(progress), false);
});

test("Simkl playback below 80 percent remains in progress", () => {
  const progress = { source: "simkl_playback", progressPercent: 79.99 };

  assert.equal(isWatchProgressCompleted(progress), false);
  assert.equal(isWatchProgressInProgress(progress), true);
});

test("local progress below 85 percent stays in progress", () => {
  const progress = { source: "local", progressPercent: 84 };

  assert.equal(watchProgressCompletedThreshold(progress), 0.85);
  assert.equal(isWatchProgressCompleted(progress), false);
  assert.equal(isWatchProgressInProgress(progress), true);
});

test("playback counts as watched from 85 percent or once the credits start", () => {
  const hour = 3600000;
  assert.equal(isPlaybackPositionComplete(hour * 0.84, hour), false);
  assert.equal(isPlaybackPositionComplete(hour * 0.85, hour), true);
  assert.equal(isPlaybackPositionComplete(hour * 0.8, hour, hour * 0.8), true);
  assert.equal(isPlaybackPositionComplete(hour * 0.8 - 1, hour, hour * 0.8), false);
  // Credits in the first half are not trusted.
  assert.equal(isPlaybackPositionComplete(hour * 0.5, hour, hour * 0.3), false);
});
