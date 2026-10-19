// Nuvio Remote: phone-as-remote toggle. Only shown on webOS, where the root daemon can run.
import { Platform } from "../../../platform/index.js";
import { I18n } from "../../../i18n/index.js";
import {
  isNuvioRemoteConnected,
  isNuvioRemoteEnabled,
  setNuvioRemoteEnabled
} from "../../../core/remote/nuvioRemoteBridge.js";
import { SECTION_META } from "./settingsScreenHelpers-03-clamp-subtitle-text-opacity.js";

function t(key, fallback) {
  return I18n.t(key, [], { fallback });
}

export function isNuvioRemoteSectionVisible() {
  return Platform.isWebOS();
}

export function renderNuvioRemoteSection() {
  const enabled = isNuvioRemoteEnabled();
  this.actionMap.set("nuvioRemote:enabled", () => setNuvioRemoteEnabled(!isNuvioRemoteEnabled()));
  this.actionMap.set("nuvioRemote:status", () => {});
  const status = !enabled
    ? t("nuvio_remote_status_off", "Off")
    : isNuvioRemoteConnected()
      ? t("nuvio_remote_status_connected", "Connected")
      : t("nuvio_remote_status_missing", "Not found. Install the service on the TV.");
  return `
      ${this.renderSectionHeader(SECTION_META.find((item) => item.id === "nuvioRemote"))}
      <div class="settings-group-card">
        <div class="settings-stack">
          ${this.renderToggleRow({
            focusKey: "nuvioRemote:enabled",
            title: t("nuvio_remote_toggle_title", "Allow phone remote"),
            subtitle: t(
              "nuvio_remote_toggle_subtitle",
              "Needs the Nuvio Remote service (rooted TV)"
            ),
            checked: enabled
          })}
          ${this.renderActionRow({
            focusKey: "nuvioRemote:status",
            title: t("nuvio_remote_status_title", "Service"),
            value: status,
            leadingIcon: "settings_remote"
          })}
        </div>
      </div>
    `;
}
