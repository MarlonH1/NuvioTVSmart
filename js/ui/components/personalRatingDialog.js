// Picker for personal ratings: Up/Down (or the -/+ buttons) change the value
// in 0.5 steps between 0 and 10; Save stores it, Remove clears it.
import { NuvioDialog } from "./nuvioDialog.js";
import { I18n } from "../../i18n/index.js";
import {
  PERSONAL_RATING_MAX,
  PERSONAL_RATING_MIN,
  PERSONAL_RATING_STEP,
  formatPersonalRating,
  normalizePersonalRating
} from "../../data/local/personalRatingsStore.js";

const DEFAULT_START_RATING = 7;

function t(key, params, fallback) {
  return I18n.t(key, params, { fallback });
}

export function showPersonalRatingDialog({ title, rating = null, onSave }) {
  const hadRating = normalizePersonalRating(rating) != null;
  let value = hadRating ? normalizePersonalRating(rating) : DEFAULT_START_RATING;
  let valueEl = null;
  let barEl = null;
  let dialog = null;

  const sync = () => {
    if (valueEl) valueEl.textContent = formatPersonalRating(value);
    if (barEl) barEl.style.width = `${(value / PERSONAL_RATING_MAX) * 100}%`;
  };
  const step = (delta) => {
    value = normalizePersonalRating(value + delta * PERSONAL_RATING_STEP);
    sync();
  };
  const close = () => dialog?.destroy();

  dialog = new NuvioDialog({
    title: t("personal_rating_title", [], "Your rating"),
    subtitle: title || null,
    widthVw: 43.75,
    panelClassName: "personal-rating-dialog",
    // Up raises and Down lowers the rating; Left/Right still move between buttons.
    onVerticalNavigate: (direction) => {
      step(direction < 0 ? 1 : -1);
      return true;
    },
    content: () => {
      const wrap = document.createElement("div");
      wrap.className = "personal-rating-body";
      wrap.innerHTML = `
        <div class="personal-rating-value-row">
          <span class="personal-rating-star" aria-hidden="true">★</span>
          <span class="personal-rating-value"></span>
          <span class="personal-rating-max">/ ${PERSONAL_RATING_MAX}</span>
        </div>
        <div class="personal-rating-bar"><span></span></div>
        <div class="personal-rating-hint"></div>`;
      valueEl = wrap.querySelector(".personal-rating-value");
      barEl = wrap.querySelector(".personal-rating-bar span");
      wrap.querySelector(".personal-rating-hint").textContent = t(
        "personal_rating_hint",
        [],
        `Up/Down changes the rating in ${PERSONAL_RATING_STEP} steps (${PERSONAL_RATING_MIN}-${PERSONAL_RATING_MAX}).`
      );
      sync();
      return wrap;
    },
    // Focus starts on the first button, so Save comes first: set the value with
    // Up/Down, then press OK.
    buttons: [
      {
        key: "save",
        label: t("common.save", {}, "Save"),
        onAction: () => {
          close();
          onSave(value);
        }
      },
      ...(hadRating
        ? [
            {
              key: "remove",
              label: t("personal_rating_remove", [], "Remove"),
              danger: true,
              onAction: () => {
                close();
                onSave(null);
              }
            }
          ]
        : []),
      { key: "cancel", label: t("common.cancel", {}, "Cancel"), onAction: close },
      // Pointer remotes can't use Up/Down, so keep explicit step buttons too.
      { key: "lower", label: `− ${PERSONAL_RATING_STEP}`, onAction: () => step(-1) },
      { key: "raise", label: `+ ${PERSONAL_RATING_STEP}`, onAction: () => step(1) }
    ],
    actionsClassName: "personal-rating-actions"
  });
  dialog.mount(document.body);
  return dialog;
}
