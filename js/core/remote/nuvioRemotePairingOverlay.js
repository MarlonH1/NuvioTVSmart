// On-screen pairing code for Nuvio Remote. Self-contained (inline styles) so it works on any
// route, including the player, without touching the app's stylesheets.
import { I18n } from "../../i18n/index.js";

const OVERLAY_ID = "nuvio-remote-pairing";

function t(key, params, fallback) {
  try {
    return I18n.t(key, params || [], { fallback });
  } catch (_) {
    return fallback;
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function showRemotePairingCode(code, clientName) {
  const digits = String(code || "")
    .replace(/\D/g, "")
    .slice(0, 6);
  if (digits.length !== 6 || !document.body) return;
  let overlay = document.getElementById(OVERLAY_ID);
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = OVERLAY_ID;
    overlay.setAttribute("role", "status");
    overlay.style.cssText = [
      "position:fixed",
      "right:4vw",
      "bottom:6vh",
      "z-index:2147483000",
      "min-width:30vw",
      "padding:2.4vh 2.2vw",
      "border-radius:2.2vh",
      "background:rgba(14,15,19,0.94)",
      "border:1px solid rgba(255,255,255,0.12)",
      "box-shadow:0 2vh 6vh rgba(0,0,0,0.55)",
      "color:#fff",
      "font-family:inherit",
      "pointer-events:none"
    ].join(";");
    document.body.appendChild(overlay);
  }
  const boxes = digits
    .split("")
    .map(
      (digit, index) =>
        `<span style="display:inline-flex;align-items:center;justify-content:center;width:4.2vw;height:9vh;` +
        `margin-right:${index === 2 ? "1.6vw" : "0.6vw"};border-radius:1.4vh;background:rgba(255,255,255,0.08);` +
        `border:1px solid rgba(255,255,255,0.18);font-size:5.2vh;font-weight:700">${digit}</span>`
    )
    .join("");
  overlay.innerHTML = `
    <div style="font-size:2.2vh;letter-spacing:0.08em;text-transform:uppercase;opacity:0.6">Nuvio Remote</div>
    <div style="font-size:3.2vh;font-weight:700;margin:0.8vh 0 2vh">${escapeHtml(
      t("nuvio_remote_pair_title", [clientName || "Phone"], `Pair ${clientName || "phone"}`)
    )}</div>
    <div style="display:flex">${boxes}</div>
    <div style="font-size:2.1vh;opacity:0.65;margin-top:2vh">${escapeHtml(
      t("nuvio_remote_pair_hint", [], "Enter this code on your phone.")
    )}</div>`;
}

export function hideRemotePairingCode() {
  const overlay = typeof document !== "undefined" ? document.getElementById(OVERLAY_ID) : null;
  if (overlay) overlay.remove();
}
