// Android ui/screens/party/PartyEffects.kt: app-wide watch party toasts and
// an availability refresh whenever the app comes to the foreground.
import { PartyRepository } from "../../../core/party/partyRepository.js";
import { PartyEventType, isPartyHost, partyMember } from "../../../core/party/partyModels.js";
import {
  PartyFriends,
  isValidFriendCode,
  normalizeFriendCode
} from "../../../core/party/partyFriends.js";
import { setRemotePartySource } from "../../../core/remote/nuvioRemoteBridge.js";
import { ProfileManager } from "../../../core/profile/profileManager.js";
import { Router } from "../../navigation/routerState.js";
import { displayTitle, showConfirmDialog, t } from "./partyUi.js";

const TOAST_DURATION_MS = 2000;
let installed = false;
let toastTimer = null;

export function showPartyToast(message) {
  const text = String(message || "").trim();
  if (!text || typeof document === "undefined") return;
  let toast = document.getElementById("partyToast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "partyToast";
    toast.className = "party-toast";
    toast.setAttribute("role", "status");
    toast.setAttribute("aria-live", "polite");
    document.body.appendChild(toast);
  }
  toast.textContent = text;
  toast.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("is-visible"), TOAST_DURATION_MS);
}

export function partyEventMessage(event) {
  switch (event?.type) {
    case PartyEventType.MemberJoined:
      return t("party_member_joined", [event.name]);
    case PartyEventType.MemberLeft:
      return t("party_member_left", [event.name]);
    case PartyEventType.Removed:
      return t("party_removed");
    case PartyEventType.Ended:
      return t("party_ended");
    case PartyEventType.MediaChanged:
      return t("party_media_changed", [event.media?.title || ""]);
    case PartyEventType.ControlChanged:
      return t(event.hostOnly ? "party_control_host_only" : "party_control_everyone");
    default:
      return "";
  }
}

function showFriendInvite(invite, repository) {
  if (repository.getState().party?.code === invite.partyCode) return;
  const sender = invite.senderName || t("party_friend_unknown", [], "Someone");
  const title = invite.title || t("party_title");
  showConfirmDialog({
    title: t("party_friend_invite_title", [], "Watch party invite"),
    message: invite.knownFriend
      ? t(
          "party_friend_invite_message",
          [sender, title],
          `${sender} invites you to watch ${title}.`
        )
      : t(
          "party_friend_invite_unknown_message",
          [sender, title],
          `${sender} (not in your friends) invites you to watch ${title}.`
        ),
    confirmLabel: t("party_join_action"),
    onConfirm: () => Router.navigate("watchParty", { code: invite.partyCode })
  });
}

// Same name source as watch party members: the active profile's name.
async function activeProfileName() {
  const activeId = String(ProfileManager.getActiveProfileId() || "1");
  const profiles = await ProfileManager.getProfiles().catch(() => []);
  const profile = profiles.find(
    (entry) => String(entry.id || entry.profileIndex || "1") === activeId
  );
  return String(profile?.name || "").trim();
}

// party.invite from the phone remote: the TV sends the invite with its own party code.
async function inviteFromRemote(repository, rawCode) {
  const party = repository.getState().party;
  if (!party) return { ok: false, code: "no_party" };
  if (party.members.length >= party.maxMembers) return { ok: false, code: "party_full" };
  const code = normalizeFriendCode(rawCode);
  if (!isValidFriendCode(code)) return { ok: false, code: "invalid_code" };
  if (code === PartyFriends.getOwnCode()) return { ok: false, code: "own_code" };
  const sent = await PartyFriends.sendInvite(PartyFriends.findByCode(code) || { code, name: "" }, {
    partyCode: party.code,
    title: displayTitle(party.media),
    fromName: partyMember(party, party.memberId)?.display_name || ""
  });
  return sent ? { ok: true } : { ok: false, code: "send_failed" };
}

export function installPartyEffects(repository = PartyRepository) {
  if (installed) return;
  installed = true;
  repository.subscribeEvents((event) => showPartyToast(partyEventMessage(event)));
  PartyFriends.setOwnNameProvider(activeProfileName);
  PartyFriends.listen((invite) => showFriendInvite(invite, repository));
  PartyFriends.installAccountSync();
  setRemotePartySource({
    getParty: () => repository.getState().party,
    subscribe: (listener) => repository.subscribeState(listener),
    invite: (friendCode) => inviteFromRemote(repository, friendCode),
    // The host ends the party for everyone, a member only leaves it (same as the party panel).
    end: () => (isPartyHost(repository.getState().party) ? repository.end() : repository.leave())
  });
  void repository.refreshAvailability();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void repository.refreshAvailability();
  });
}
