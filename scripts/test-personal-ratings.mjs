import assert from "node:assert/strict";

const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key)
};

const { ProfileManager } = await import("../js/core/profile/profileManager.js");
let activeProfile = "1";
ProfileManager.getActiveProfileId = () => activeProfile;

const { PersonalRatingsStore, formatPersonalRating, normalizePersonalRating, personalRatingKey } =
  await import("../js/data/local/personalRatingsStore.js");
const { normalizePlayerControlLayout } = await import("../js/core/player/playerCustomization.js");

assert.equal(normalizePersonalRating(7.3), 7.5, "rounds to the nearest 0.5");
assert.equal(normalizePersonalRating(7.2), 7);
assert.equal(normalizePersonalRating(-3), 0, "clamps below 0");
assert.equal(normalizePersonalRating(12), 10, "clamps above 10");
assert.equal(normalizePersonalRating(0), 0, "0 is a valid rating");
assert.equal(normalizePersonalRating(null), null);
assert.equal(normalizePersonalRating("abc"), null);
assert.equal(formatPersonalRating(8), "8.0");
assert.equal(formatPersonalRating(null), "");

const movie = personalRatingKey({ itemId: "tt0111161" });
const episode = personalRatingKey({
  itemId: "tt14115938",
  videoId: "tt14115938:1:1",
  episode: true
});
assert.equal(movie, "title:tt0111161");
assert.equal(episode, "episode:tt14115938:1:1");
assert.equal(personalRatingKey({ itemId: "" }), "", "no id, no key");
assert.notEqual(
  personalRatingKey({ itemId: "x" }),
  personalRatingKey({ videoId: "x", episode: true }),
  "titles and episodes never share a key"
);

const events = [];
PersonalRatingsStore.subscribe((key, rating) => events.push([key, rating]));
PersonalRatingsStore.set(movie, 9.5, { title: "The Shawshank Redemption" });
PersonalRatingsStore.set(episode, 0);
assert.equal(PersonalRatingsStore.get(movie), 9.5);
assert.equal(PersonalRatingsStore.get(episode), 0);
assert.deepEqual(events, [
  [movie, 9.5],
  [episode, 0]
]);

activeProfile = "2";
assert.equal(PersonalRatingsStore.get(movie), null, "ratings are per profile");
PersonalRatingsStore.set(movie, 4);
activeProfile = "1";
assert.equal(PersonalRatingsStore.get(movie), 9.5);

PersonalRatingsStore.set(movie, null);
assert.equal(PersonalRatingsStore.get(movie), null, "null removes the rating");
activeProfile = "2";
assert.equal(PersonalRatingsStore.get(movie), 4, "removal only affects the active profile");

storage.set("personalRatings", "{broken");
assert.equal(PersonalRatingsStore.get(movie), null, "corrupt storage reads as empty");

const layout = normalizePlayerControlLayout([{ id: "source", placement: "bar" }]);
assert.deepEqual(
  layout.at(-1),
  { id: "rate", placement: "more" },
  "existing layouts gain Rate in More"
);

console.log("Personal ratings: all checks passed.");
