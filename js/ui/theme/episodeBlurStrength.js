import { LayoutPreferences } from "../../data/local/layoutPreferences.js";

// Episode artwork CSS reads this variable, so a strength change applies to
// cards that are already rendered.
export function applyEpisodeBlurStrength(strength = LayoutPreferences.get().episodeBlurStrength) {
  if (typeof document === "undefined") {
    return;
  }
  document.documentElement.style.setProperty(
    "--episode-blur-strength",
    `${Number(strength) || 12}px`
  );
}
