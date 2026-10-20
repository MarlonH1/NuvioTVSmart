/* eslint-disable no-unused-vars */
import * as internals from "./playerScreenContext.js";

import { PartyRepository } from "../../../core/party/partyRepository.js";
import { PlayerSettingsStore } from "../../../data/local/playerSettingsStore.js";
import { arrangePlayerControls } from "../../../core/player/playerCustomization.js";
import { PersonalRatingsStore, formatPersonalRating } from "../../../data/local/personalRatingsStore.js";

export function createPlayerScreenMethods28() {
  const { PlayerController, t, clamp, escapeHtml } = internals;

  return {
    unbindVideoEvents() {
      this.videoListeners.forEach(({ target, eventName, handler }) => {
        target?.removeEventListener?.(eventName, handler);
      });
      this.videoListeners = [];
    },
    getPlaybackControlPaused() {
      const conversion = PlayerController.webOsDtsAudioState;
      // Native decoder pauses during a track reload are not user commands.
      if (conversion && (conversion.preparing || conversion.cancelReload || conversion.buffering)) {
        return conversion.controlPaused;
      }
      return this.paused;
    },
    getControlDefinitions() {
      const paused = this.getPlaybackControlPaused();
      const uiState = this.getPlayerUiState();
      const nextEpisode = this.resolveNextEpisodeInfo();
      const available = {};

      if (nextEpisode?.hasAired && !this.nextEpisodeLaunching) {
        available.playNextEpisode = {
          action: "playNextEpisode",
          icon: "assets/icons/ic_player_skip_next.svg",
          useMask: true,
          title: t("next_episode_label", {}, "Next episode")
        };
      }

      available.subtitleDialog = {
        action: "subtitleDialog",
        icon: "assets/icons/ic_player_subtitles.svg",
        title: t("subtitle_dialog_title", {}, "Subtitles")
      };

      available.audioTrack = {
        action: "audioTrack",
        icon:
          this.selectedAudioTrackIndex >= 0 || this.selectedManifestAudioTrackId
            ? "assets/icons/ic_player_audio_filled.svg"
            : "assets/icons/ic_player_audio_outline.svg",
        useMask: true,
        title: t("audio_dialog_title", {}, "Audio")
      };

      available.source = {
        action: "source",
        icon: "assets/icons/ic_player_source.svg",
        title: t("sources_title", {}, "Sources")
      };

      if (Array.isArray(uiState.episodesAll) && uiState.episodesAll.length) {
        available.episodes = {
          action: "episodes",
          icon: "assets/icons/ic_player_episodes.svg",
          title: t("episodes_panel_title", {}, "Episodes")
        };
      }

      if (this.isPartyButtonAvailable?.()) {
        available.party = {
          action: "party",
          icon: "assets/icons/ic_player_party.svg",
          useMask: true,
          title: t("party_title", {}, "Watch party"),
          className: PartyRepository.getState().party ? "is-party-active" : ""
        };
      }

      if (this.getPlaybackSpeedOptions().length > 1) {
        const playbackSpeed = this.getPlaybackSpeed();
        available.speed = {
          action: "speed",
          label: `${playbackSpeed.toFixed(playbackSpeed % 1 ? 2 : 0)}x`,
          title: t("player_playback_speed", {}, "Playback speed")
        };
      }

      available.aspect = {
        action: "aspect",
        icon: "assets/icons/ic_player_aspect_ratio.svg",
        title: t("player_more_aspect_ratio", {}, "Aspect Ratio")
      };

      const personalRating = PersonalRatingsStore.get(this.getPersonalRatingKey());
      available.rate = {
        action: "rate",
        label: personalRating == null ? "☆" : `★ ${formatPersonalRating(personalRating)}`,
        title: t("personal_rating_rate", [], "Rate")
      };

      available.streamInfo = { action: "streamInfo", label: "ⓘ", title: t("cd_stream_info", {}, "Stream info") };

      const { bar, more } = arrangePlayerControls(available, PlayerSettingsStore.get().playerControlLayout);
      const playPause = {
        action: "playPause",
        label: paused ? ">" : "II",
        icon: paused ? "assets/icons/ic_player_play.svg" : "assets/icons/ic_player_pause.svg",
        title: "Play/Pause",
        primary: true
      };

      if (!more.length) {
        this.moreActionsVisible = false;
        return [playPause, ...bar];
      }

      if (!this.moreActionsVisible) {
        return [
          playPause,
          ...bar,
          {
            action: "more",
            label: ">",
            title: t("player_more_actions_title", {}, "More Actions")
          }
        ];
      }

      return [playPause, ...bar, ...more, { action: "backFromMore", label: "<", title: t("player_go_back", {}, "Back") }];
    },
    getFirstMoreControlAction() {
      const layout = PlayerSettingsStore.get().playerControlLayout;
      const barActions = new Set(layout.filter((entry) => entry.placement === "bar").map((entry) => entry.id));
      const controls = this.getControlDefinitions();
      return controls.find((entry) => !["playPause", "backFromMore", "more"].includes(entry.action) && !barActions.has(entry.action))
        ?.action;
    },
    getControlRenderSignature(controls = this.getControlDefinitions()) {
      return JSON.stringify(
        controls.map((control) => [
          control.action || "",
          control.label || "",
          control.icon || "",
          control.title || "",
          Boolean(control.primary),
          Boolean(control.useMask),
          control.className || ""
        ])
      );
    },
    renderControlButtons() {
      if (this.isExternalFrameMode()) {
        return;
      }
      const wrap = this.uiRefs?.controlButtons;
      if (!wrap) {
        return;
      }

      if (this.isPostPlayVisible() || this.isPostPlayLoading()) {
        wrap.innerHTML = "";
        this.renderedControlSignature = "";
        this.syncPlayerOverlayLayoutState();
        return;
      }

      const controls = this.getControlDefinitions();
      const controlRenderSignature = this.getControlRenderSignature(controls);
      if (this.stickyProgressFocus && this.controlsVisible && !this.isDialogOpen() && this.isSeekBarAvailable()) {
        this.controlFocusZone = "progress";
      }
      this.controlFocusIndex = clamp(this.controlFocusIndex, 0, Math.max(0, controls.length - 1));

      const mountedButtons = Array.from(wrap.querySelectorAll(".player-control-btn"));
      const controlsMatchDom =
        mountedButtons.length === controls.length &&
        mountedButtons.every((button, index) => button.dataset.action === String(controls[index]?.action || ""));
      if (!controlsMatchDom || this.renderedControlSignature !== controlRenderSignature) {
        wrap.innerHTML = controls
          .map(
            (control) => `
            <button class="player-control-btn focusable${control.primary ? " is-primary" : ""}${control.className ? ` ${escapeHtml(control.className)}` : ""}"
                    data-action="${control.action}"
                    title="${escapeHtml(control.title || "")}">
              ${
                control.icon
                  ? control.primary || control.useMask
                    ? `<span class="player-control-icon player-control-icon-mask" style="-webkit-mask-image:url('${escapeHtml(control.icon)}');mask-image:url('${escapeHtml(control.icon)}');" aria-hidden="true"></span>`
                    : `<img class="player-control-icon" src="${control.icon}" alt="" aria-hidden="true" />`
                  : `<span class="player-control-label">${escapeHtml(control.label || "")}</span>`
              }
            </button>
          `
          )
          .join("");
      }
      this.renderedControlSignature = controlRenderSignature;

      const buttons = Array.from(wrap.querySelectorAll(".player-control-btn"));
      buttons.forEach((button, index) => {
        button.classList.toggle("focused", this.controlFocusZone === "buttons" && index === this.controlFocusIndex);
      });
      const progressShell = this.uiRefs?.progressShell;
      if (progressShell) {
        progressShell.classList.toggle("focused", this.controlFocusZone === "progress");
      }

      if (this.controlFocusZone === "progress") {
        buttons.forEach((button) => {
          if (typeof button.blur === "function") {
            button.blur();
          }
        });
        if (progressShell && document.activeElement !== progressShell && typeof progressShell.focus === "function") {
          progressShell.focus();
        }
      } else if (this.controlFocusZone === "buttons") {
        if (progressShell && document.activeElement === progressShell && typeof progressShell.blur === "function") {
          progressShell.blur();
        }
        const focusedButton = buttons[this.controlFocusIndex] || null;
        if (focusedButton && document.activeElement !== focusedButton && typeof focusedButton.focus === "function") {
          focusedButton.focus();
        }
      } else if (this.controlFocusZone === "skipIntro" || this.controlFocusZone === "nextEpisode") {
        buttons.forEach((button) => {
          if (typeof button.blur === "function") {
            button.blur();
          }
        });
        if (progressShell && document.activeElement === progressShell && typeof progressShell.blur === "function") {
          progressShell.blur();
        }
      }
      this.syncSkipIntroFocusState();
      this.renderNextEpisodeCard();
      this.syncNextEpisodeCardFocusState();
      this.syncPlayerOverlayLayoutState();
      this.renderBitmapSubtitleAtCurrentTime();
    },
    syncControlFocusDom() {
      if (this.isExternalFrameMode()) {
        return;
      }
      const wrap = this.uiRefs?.controlButtons;
      if (!wrap) {
        return;
      }

      const controls = this.getControlDefinitions();
      const buttons = Array.from(wrap.querySelectorAll(".player-control-btn"));
      const controlsMatchDom = buttons.every((button, index) => button.dataset.action === String(controls[index]?.action || ""));
      // This path is used only when focus moves. If playback state changed the
      // available controls without rendering them first, fall back to the full
      // state render instead of focusing a stale button.
      if (
        buttons.length !== controls.length ||
        !controlsMatchDom ||
        this.renderedControlSignature !== this.getControlRenderSignature(controls)
      ) {
        this.renderControlButtons();
        return;
      }

      this.controlFocusIndex = clamp(this.controlFocusIndex, 0, Math.max(0, controls.length - 1));
      buttons.forEach((button, index) => {
        button.classList.toggle("focused", this.controlFocusZone === "buttons" && index === this.controlFocusIndex);
      });

      const progressShell = this.uiRefs?.progressShell;
      progressShell?.classList.toggle("focused", this.controlFocusZone === "progress");

      if (this.controlFocusZone === "progress") {
        buttons.forEach((button) => button.blur?.());
        if (progressShell && document.activeElement !== progressShell) {
          progressShell.focus?.();
        }
      } else if (this.controlFocusZone === "buttons") {
        if (progressShell && document.activeElement === progressShell) {
          progressShell.blur?.();
        }
        const focusedButton = buttons[this.controlFocusIndex] || null;
        if (focusedButton && document.activeElement !== focusedButton) {
          focusedButton.focus?.();
        }
      } else if (this.controlFocusZone === "skipIntro" || this.controlFocusZone === "nextEpisode") {
        buttons.forEach((button) => button.blur?.());
        if (progressShell && document.activeElement === progressShell) {
          progressShell.blur?.();
        }
      }

      // Preserve the non-markup side effects of renderControlButtons().
      this.syncSkipIntroFocusState();
      this.renderNextEpisodeCard();
      this.syncNextEpisodeCardFocusState();
      this.syncPlayerOverlayLayoutState();
      this.renderBitmapSubtitleAtCurrentTime();
    },
    isDialogOpen() {
      return (
        this.subtitleDialogVisible ||
        this.subtitleTimingDialogVisible ||
        this.subtitleDelayOverlayVisible ||
        this.audioDialogVisible ||
        this.sourcesPanelVisible ||
        this.episodePanelVisible ||
        this.speedDialogVisible ||
        Boolean(this.partyPanelVisible)
      );
    },
    syncPlayerOverlayLayoutState() {
      const root = this.uiRefs?.root;
      if (!root) {
        return;
      }
      const postPlayState = this.getPostPlayState();
      const postPlayVisible = Boolean(postPlayState.isVisible);
      const postPlayTrailer = Boolean(postPlayState.isTrailerPlaying);
      const postPlayTrailerConsumed = Boolean(postPlayVisible && postPlayState.hasAutoPlayedTrailer);
      root.classList.toggle("controls-visible", Boolean(this.controlsVisible) && !this.isExternalFrameMode() && !postPlayVisible);
      root.classList.toggle("post-play-visible", postPlayVisible);
      root.classList.toggle("post-play-loading", Boolean(postPlayState.isLoadingRecommendation));
      root.classList.toggle("post-play-trailer", postPlayTrailer);
      root.classList.toggle("post-play-trailer-consumed", postPlayTrailerConsumed);
      root.classList.toggle("post-play-returning", Boolean(postPlayState.hasReturnedToPlayer));
      this.container?.classList.toggle("post-play-visible", postPlayVisible);
      this.container?.classList.toggle("post-play-trailer", postPlayTrailer);
      this.container?.classList.toggle("post-play-trailer-consumed", postPlayTrailerConsumed);
      this.container?.classList.toggle("post-play-returning", Boolean(postPlayState.hasReturnedToPlayer));
      this.syncPostPlayPlayerSurface(postPlayState);
      this.syncPlayerActionOverlayOffset();
    },
    cancelPostPlayPlayerSurfaceAnimation() {
      if (this.postPlayPlayerSurfaceAnimationFrame == null) {
        return;
      }
      if (this.postPlayPlayerSurfaceAnimationUsesRaf) {
        globalThis.cancelAnimationFrame?.(this.postPlayPlayerSurfaceAnimationFrame);
      } else {
        clearTimeout(this.postPlayPlayerSurfaceAnimationFrame);
      }
      this.postPlayPlayerSurfaceAnimationFrame = null;
    }
  };
}
