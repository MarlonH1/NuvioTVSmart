/* eslint-disable no-unused-vars */
import * as internals from "./settingsScreenContext.js";
import {
  ANIME_PLAYBACK_SPEED_OPTIONS,
  DEFAULT_PLAYER_CONTROL_LAYOUT,
  getPlayerControlSlot,
  placePlayerControl
} from "../../../core/player/playerCustomization.js";
import { playerControlLabel, playerControlSlotLabel } from "./settingsScreenPlaybackMarkup-03-controls.js";

export function registerPlaybackActionsPart03(model) {
  const { PlayerSettingsStore, t } = internals;
  this.actionMap.set("playback:toggle:controls", () => {
    this.toggleExpandedSection("playback", "controls");
  });

  (model.player.playerControlLayout || []).forEach(({ id }) => {
    const focusKey = `playback:controlLayout:${id}`;
    this.actionMap.set(focusKey, () => {
      const layout = PlayerSettingsStore.get().playerControlLayout;
      const current = getPlayerControlSlot(layout, id);
      const countIn = (placement) => layout.filter((entry) => entry.placement === placement && entry.id !== id).length + 1;
      const slotOptions = (placement) =>
        Array.from({ length: countIn(placement) }, (_, index) => ({
          id: `${placement}:${index + 1}`,
          label: playerControlSlotLabel(t, { placement, position: index + 1 })
        }));
      this.openOptionDialog({
        title: playerControlLabel(t, id),
        options: [...slotOptions("bar"), ...slotOptions("more"), { id: "hidden:1", label: playerControlSlotLabel(t, null) }],
        selectedId: `${current.placement}:${current.placement === "hidden" ? 1 : current.position}`,
        returnFocusKey: focusKey,
        onSelect: (option) => {
          const [placement, position] = String(option.id).split(":");
          PlayerSettingsStore.set({
            playerControlLayout: placePlayerControl(PlayerSettingsStore.get().playerControlLayout, id, placement, Number(position))
          });
        }
      });
    });
  });

  this.actionMap.set("playback:controlLayout:reset", () => {
    PlayerSettingsStore.set({ playerControlLayout: DEFAULT_PLAYER_CONTROL_LAYOUT });
  });

  this.actionMap.set("playback:animeSpeed", () => {
    PlayerSettingsStore.set({
      animePlaybackSpeedEnabled: !PlayerSettingsStore.get().animePlaybackSpeedEnabled
    });
  });

  this.actionMap.set("playback:animeSpeedValue", () => {
    this.openOptionDialog({
      title: t("player_anime_speed_value", {}, "Anime speed"),
      options: ANIME_PLAYBACK_SPEED_OPTIONS.map((speed) => ({
        id: speed,
        label: `${speed.toFixed(speed % 1 ? 2 : 0)}x`
      })),
      selectedId: PlayerSettingsStore.get().animePlaybackSpeed,
      returnFocusKey: "playback:animeSpeedValue",
      onSelect: (option) => {
        PlayerSettingsStore.set({ animePlaybackSpeed: Number(option.id) });
      }
    });
  });
}
