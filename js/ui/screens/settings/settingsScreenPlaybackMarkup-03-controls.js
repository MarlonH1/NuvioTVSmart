/* eslint-disable no-unused-vars */
import * as internals from "./settingsScreenContext.js";
import { getPlayerControlSlot } from "../../../core/player/playerCustomization.js";

export const PLAYER_CONTROL_LABELS = {
  playNextEpisode: ["next_episode_label", "Next episode"],
  subtitleDialog: ["subtitle_dialog_title", "Subtitles"],
  audioTrack: ["audio_dialog_title", "Audio"],
  source: ["sources_title", "Sources"],
  episodes: ["episodes_panel_title", "Episodes"],
  party: ["party_title", "Watch party"],
  speed: ["player_playback_speed", "Playback speed"],
  aspect: ["player_more_aspect_ratio", "Aspect Ratio"],
  streamInfo: ["cd_stream_info", "Stream info"]
};

export function playerControlLabel(t, id) {
  const [key, fallback] = PLAYER_CONTROL_LABELS[id] || [id, id];
  return t(key, {}, fallback);
}

export function playerControlSlotLabel(t, slot) {
  if (!slot || slot.placement === "hidden") {
    return t("player_controls_hidden", {}, "Hidden");
  }
  return slot.placement === "more"
    ? t("player_controls_more_position", { position: slot.position }, `More · ${slot.position}`)
    : t("player_controls_bar_position", { position: slot.position }, `Bar · ${slot.position}`);
}

export function renderPlaybackControlsBody(model) {
  const { t } = internals;
  const layout = model.player.playerControlLayout || [];
  const speed = Number(model.player.animePlaybackSpeed || 1.5);
  return `
          <div class="settings-stack">
            ${layout
              .map(({ id }) =>
                this.renderActionRow({
                  focusKey: `playback:controlLayout:${id}`,
                  title: playerControlLabel(t, id),
                  subtitle: t("player_controls_row_sub", {}, "Choose its position in the player bar, move it to More, or hide it."),
                  value: playerControlSlotLabel(t, getPlayerControlSlot(layout, id))
                })
              )
              .join("")}
            ${this.renderActionRow({
              focusKey: "playback:controlLayout:reset",
              title: t("player_controls_reset", {}, "Reset control order"),
              subtitle: t("player_controls_reset_sub", {}, "Restore the default player bar."),
              value: ""
            })}
            ${this.renderToggleRow({
              focusKey: "playback:animeSpeed",
              title: t("player_anime_speed", {}, "Anime playback speed"),
              subtitle: t("player_anime_speed_sub", {}, "Start anime movies and episodes at a fixed speed. Other titles stay at 1x."),
              checked: Boolean(model.player.animePlaybackSpeedEnabled)
            })}
            ${
              model.player.animePlaybackSpeedEnabled
                ? this.renderActionRow({
                    focusKey: "playback:animeSpeedValue",
                    title: t("player_anime_speed_value", {}, "Anime speed"),
                    subtitle: t("player_anime_speed_value_sub", {}, "You can still change the speed during playback."),
                    value: `${speed.toFixed(speed % 1 ? 2 : 0)}x`
                  })
                : ""
            }
          </div>
        `;
}
