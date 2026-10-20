import { formatPersonalRating } from "../../../data/local/personalRatingsStore.js";
import { I18n } from "../../../i18n/index.js";

export function personalRatingButtonLabel(rating) {
  return rating == null
    ? I18n.t("personal_rating_rate", [], { fallback: "Rate" })
    : I18n.t("personal_rating_yours", [formatPersonalRating(rating)], {
        fallback: `Your rating ${formatPersonalRating(rating)}`
      });
}

// Hero circle button content: an outlined star until rated, then the rating.
export function personalRatingButtonMarkup(rating) {
  return rating == null
    ? `<span class="material-icons detail-personal-rating-icon" aria-hidden="true">star_outline</span>`
    : `<span class="detail-personal-rating-value">${formatPersonalRating(rating)}</span>`;
}
