// Picker for personal ratings, laid out like a TV slider: the slider is focused
// first and Left/Right change the value in 0.5 steps (digits jump to a whole
// number); OK saves. Down moves to Save/Remove/Cancel, Up returns to the slider.
import { NuvioDialog } from "./nuvioDialog.js";
import { I18n } from "../../i18n/index.js";
import {
  PERSONAL_RATING_MAX,
  PERSONAL_RATING_STEP,
  formatPersonalRating,
  normalizePersonalRating
} from "../../data/local/personalRatingsStore.js";

const DEFAULT_START_RATING = 7;

function t(key, params, fallback) {
  return I18n.t(key, params, { fallback });
}

function digitOf(event) {
  const keyCode = Number(event?.keyCode || 0);
  if (keyCode >= 48 && keyCode <= 57) return keyCode - 48;
  if (keyCode >= 96 && keyCode <= 105) return keyCode - 96;
  return null;
}

class PersonalRatingDialog extends NuvioDialog {
  constructor({ value, onSave, ...options }) {
    super(options);
    this.value = value;
    this.onSave = onSave;
    this.zone = "slider";
    this.sliderEl = null;
    this.valueEl = null;
    this.barEl = null;
  }

  setValue(next) {
    this.value = normalizePersonalRating(next);
    if (this.valueEl) this.valueEl.textContent = formatPersonalRating(this.value);
    if (this.barEl) this.barEl.style.width = `${(this.value / PERSONAL_RATING_MAX) * 100}%`;
  }

  step(direction) {
    this.setValue(this.value + direction * PERSONAL_RATING_STEP);
  }

  save() {
    this.destroy();
    this.onSave(this.value);
  }

  focusSlider() {
    this.zone = "slider";
    this._buttonEls.forEach((el) => el.classList.remove("focused"));
    this.sliderEl?.classList.add("focused");
    this.sliderEl?.focus({ preventScroll: true });
  }

  // NuvioDialog focuses its first button after mounting; keep the slider instead.
  _focusIndex(index) {
    if (this.zone === "slider") {
      this.focusSlider();
      return;
    }
    this.sliderEl?.classList.remove("focused");
    super._focusIndex(index);
  }

  _onKey(event) {
    if (this._destroyed) return;
    const key = this._eventKey(event);
    if (key.isBack) {
      super._onKey(event);
      return;
    }
    if (this.zone === "slider") {
      const digit = digitOf(event);
      const handled =
        key.isLeft || key.isRight || key.isDown || key.isUp || key.isEnter || digit != null;
      if (!handled) return;
      event.preventDefault();
      event.stopPropagation();
      if (key.isLeft) this.step(-1);
      else if (key.isRight) this.step(1);
      else if (digit != null) this.setValue(digit);
      else if (key.isEnter) this.save();
      else if (key.isDown) {
        this.zone = "buttons";
        this._focusIndex(0);
      }
      return;
    }
    if (key.isUp) {
      event.preventDefault();
      event.stopPropagation();
      this.focusSlider();
      return;
    }
    if (key.isDown) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    super._onKey(event);
  }
}

export function showPersonalRatingDialog({ title, rating = null, onSave }) {
  const hadRating = normalizePersonalRating(rating) != null;
  let dialog = null;
  dialog = new PersonalRatingDialog({
    value: hadRating ? normalizePersonalRating(rating) : DEFAULT_START_RATING,
    onSave,
    title: t("personal_rating_title", [], "Your rating"),
    subtitle: title || null,
    widthVw: 43.75,
    panelClassName: "personal-rating-dialog",
    actionsClassName: "personal-rating-actions",
    content: () => {
      const wrap = document.createElement("div");
      wrap.className = "personal-rating-body";
      wrap.innerHTML = `
        <div class="personal-rating-slider" tabindex="-1">
          <span class="personal-rating-step" data-step="-1" aria-hidden="true">‹</span>
          <div class="personal-rating-center">
            <div class="personal-rating-value-row">
              <span class="personal-rating-star" aria-hidden="true">★</span>
              <span class="personal-rating-value"></span>
              <span class="personal-rating-max">/ ${PERSONAL_RATING_MAX}</span>
            </div>
            <div class="personal-rating-bar"><span></span></div>
          </div>
          <span class="personal-rating-step" data-step="1" aria-hidden="true">›</span>
        </div>
        <div class="personal-rating-hint"></div>`;
      wrap.querySelector(".personal-rating-hint").textContent = t(
        "personal_rating_hint",
        [],
        "Left/Right changes the rating, OK saves."
      );
      dialog.sliderEl = wrap.querySelector(".personal-rating-slider");
      dialog.valueEl = wrap.querySelector(".personal-rating-value");
      dialog.barEl = wrap.querySelector(".personal-rating-bar span");
      // Pointer remotes: click the arrows to step, or the slider to focus it.
      wrap.querySelectorAll(".personal-rating-step").forEach((arrow) => {
        arrow.addEventListener("click", (event) => {
          event.stopPropagation();
          dialog.focusSlider();
          dialog.step(Number(arrow.dataset.step));
        });
      });
      dialog.sliderEl.addEventListener("click", () => dialog.focusSlider());
      dialog.setValue(dialog.value);
      return wrap;
    },
    buttons: [
      { key: "save", label: t("common.save", {}, "Save"), onAction: () => dialog.save() },
      ...(hadRating
        ? [
            {
              key: "remove",
              label: t("personal_rating_remove", [], "Remove"),
              danger: true,
              onAction: () => {
                dialog.destroy();
                onSave(null);
              }
            }
          ]
        : []),
      { key: "cancel", label: t("common.cancel", {}, "Cancel"), onAction: () => dialog.destroy() }
    ]
  });
  dialog.mount(document.body);
  return dialog;
}
