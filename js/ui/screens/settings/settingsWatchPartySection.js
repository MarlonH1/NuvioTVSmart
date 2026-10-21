// Android ui/screens/party/PartySettingsContent.kt: the Watch party entry in Settings,
// plus a Friends subsection used for one-step invites.
import { Router } from "../../navigation/routerState.js";
import { PartyRepository } from "../../../core/party/partyRepository.js";
import { formatPartyCode } from "../../../core/party/partyModels.js";
import {
  FRIEND_CODE_LENGTH,
  PartyFriends,
  formatFriendCode,
  friendDisplayName,
  normalizeFriendCode
} from "../../../core/party/partyFriends.js";
import { displayTitle, escapeHtml, showConfirmDialog, t } from "../party/partyUi.js";
import { SECTION_META } from "./settingsScreenHelpers-03-clamp-subtitle-text-opacity.js";

const FRIEND_ERRORS = {
  invalid_code: ["party_friend_error_code", "Enter the 12-character friend code."],
  own_code: ["party_friend_error_own", "That's your own friend code."],
  too_many: ["party_friend_error_full", "Your friend list is full."]
};

function friendError(error) {
  const [key, fallback] = FRIEND_ERRORS[error] || FRIEND_ERRORS.invalid_code;
  return t(key, [], fallback);
}

export function isWatchPartySectionVisible() {
  return PartyRepository.isAvailable();
}

// Upper-cases, drops anything outside the code alphabet and groups as XXXX-XXXX-XXXX.
function formatCodeInput(value) {
  return formatFriendCode(normalizeFriendCode(value).slice(0, FRIEND_CODE_LENGTH));
}

function registerFriendActions(friends) {
  this.actionMap.set("watchParty:friendCode", () => {});
  this.actionMap.set("watchParty:toggle:friends", () => {
    this.toggleExpandedSection("watchParty", "friends");
  });
  this.actionMap.set("watchParty:addFriend", () => {
    this.openTextDialog({
      title: t("party_friend_add_code", [], "Friend code"),
      placeholder: "XXXX-XXXX-XXXX",
      format: formatCodeInput,
      autocapitalize: "characters",
      returnFocusKey: "watchParty:addFriend",
      saveLabel: t("party_friend_add", [], "Add friend"),
      onSubmit: (value) => {
        // The friend's own app answers with their name; no need to type one.
        const error = PartyFriends.add(value);
        if (error) {
          this.textDialog.statusMessage = friendError(error);
          this.render();
          return false;
        }
        return true;
      }
    });
  });
  friends.forEach((friend) => {
    const name = friendDisplayName(friend);
    this.actionMap.set(`watchParty:friend:${friend.code}`, () => {
      showConfirmDialog({
        title: t("party_friend_remove_title", [name], `Remove ${name}?`),
        message: t(
          "party_friend_remove_message",
          [],
          "You are removed from their friends as well."
        ),
        confirmLabel: t("party_remove"),
        onConfirm: () => {
          PartyFriends.remove(friend.code);
          this.render();
        }
      });
    });
  });
}

function renderFriendRows(friends) {
  this.ensureExpandedState("watchParty");
  const expanded = Boolean(this.expandedSections.watchParty?.friends);
  const friendList = friends.length
    ? friends
        .map((friend) =>
          this.renderActionRow({
            focusKey: `watchParty:friend:${friend.code}`,
            title: friendDisplayName(friend),
            subtitle: friend.name
              ? formatFriendCode(friend.code)
              : t("party_friend_name_pending", [], "Waiting for their name"),
            value: t("party_remove"),
            leadingIcon: "person"
          })
        )
        .join("")
    : `<p class="settings-row-subtitle">${escapeHtml(
        t("party_friend_none", [], "Add friends to invite them from a watch party.")
      )}</p>`;
  return `
      <div class="settings-group-heading">
        <div class="settings-group-title">${escapeHtml(t("party_friends_heading", [], "Friends"))}</div>
      </div>
      <div class="settings-group-card">
        <div class="settings-stack">
          ${this.renderActionRow({
            focusKey: "watchParty:friendCode",
            title: t("party_friend_own_code", [], "Your friend code"),
            subtitle: t(
              "party_friend_own_code_sub",
              [],
              "Share it so friends can invite you to their watch party."
            ),
            value: formatFriendCode(PartyFriends.getOwnCode()),
            leadingIcon: "badge"
          })}
          ${this.renderActionRow({
            focusKey: "watchParty:addFriend",
            title: t("party_friend_add", [], "Add friend"),
            subtitle: t(
              "party_friend_add_sub",
              [],
              "Enter their friend code to invite them from a watch party."
            ),
            leadingIcon: "person_add"
          })}
          ${this.renderCollapsibleRow({
            focusKey: "watchParty:toggle:friends",
            title: t("party_friends_list", [friends.length], `Your friends (${friends.length})`),
            subtitle: t(
              "party_friends_list_sub",
              [],
              "Everyone you can invite. Select a friend to remove them."
            ),
            expanded,
            bodyHtml: `<div class="settings-stack">${friendList}</div>`
          })}
        </div>
      </div>`;
}

export function renderWatchPartySection() {
  const party = PartyRepository.getState().party;
  const friends = PartyFriends.list();
  this.actionMap.set("watchParty:open", () => Router.navigate("watchParty"));
  registerFriendActions.call(this, friends);
  const row = party
    ? this.renderActionRow({
        focusKey: "watchParty:open",
        title: displayTitle(party.media),
        subtitle: t("party_seats", [party.members.length, party.maxMembers]),
        value: formatPartyCode(party.code),
        leadingIcon: "groups"
      })
    : this.renderActionRow({
        focusKey: "watchParty:open",
        title: t("party_join_title"),
        subtitle: PartyRepository.canUse()
          ? t("party_join_description")
          : t("party_sign_in_required"),
        leadingIcon: "groups"
      });
  return `
      ${this.renderSectionHeader(SECTION_META.find((item) => item.id === "watchParty"))}
      <div class="settings-group-card">
        <div class="settings-stack">${row}</div>
      </div>
      ${renderFriendRows.call(this, friends)}
    `;
}
