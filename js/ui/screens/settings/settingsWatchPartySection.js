// Android ui/screens/party/PartySettingsContent.kt: the Watch party entry in Settings,
// plus the friend list used for one-step invites.
import { Router } from "../../navigation/routerState.js";
import { PartyRepository } from "../../../core/party/partyRepository.js";
import { formatPartyCode } from "../../../core/party/partyModels.js";
import {
  PartyFriends,
  formatFriendCode,
  isValidFriendCode,
  normalizeFriendCode
} from "../../../core/party/partyFriends.js";
import { displayTitle, showConfirmDialog, t } from "../party/partyUi.js";
import { SECTION_META } from "./settingsScreenHelpers-03-clamp-subtitle-text-opacity.js";

const FRIEND_ERRORS = {
  invalid_code: ["party_friend_error_code", "Enter the 12-character friend code."],
  own_code: ["party_friend_error_own", "That's your own friend code."],
  missing_name: ["party_friend_error_name", "Enter a name."],
  too_many: ["party_friend_error_full", "Your friend list is full."]
};

function friendError(error) {
  const [key, fallback] = FRIEND_ERRORS[error] || FRIEND_ERRORS.invalid_code;
  return t(key, [], fallback);
}

export function isWatchPartySectionVisible() {
  return PartyRepository.isAvailable();
}

function registerFriendActions(friends) {
  this.actionMap.set("watchParty:friendCode", () => {});
  this.actionMap.set("watchParty:addFriend", () => {
    this.openTextDialog({
      title: t("party_friend_add_code", [], "Friend code"),
      placeholder: "XXXX-XXXX-XXXX",
      returnFocusKey: "watchParty:addFriend",
      saveLabel: t("party_friend_next", [], "Next"),
      onSubmit: (value) => {
        const code = normalizeFriendCode(value);
        if (!isValidFriendCode(code) || code === PartyFriends.getOwnCode()) {
          this.textDialog.statusMessage = friendError(
            isValidFriendCode(code) ? "own_code" : "invalid_code"
          );
          this.render();
          return false;
        }
        // The code dialog closes after this returns, so open the name step next tick.
        setTimeout(() => {
          this.openTextDialog({
            title: t("party_friend_add_name", [], "Friend's name"),
            value: PartyFriends.findByCode(code)?.name || "",
            returnFocusKey: "watchParty:addFriend",
            onSubmit: (name) => {
              const error = PartyFriends.add(code, name);
              if (error) {
                this.textDialog.statusMessage = friendError(error);
                this.render();
                return false;
              }
              return true;
            }
          });
          this.render();
        }, 0);
        return true;
      }
    });
  });
  friends.forEach((friend) => {
    this.actionMap.set(`watchParty:friend:${friend.code}`, () => {
      showConfirmDialog({
        title: t("party_friend_remove_title", [friend.name], `Remove ${friend.name}?`),
        message: t(
          "party_friend_remove_message",
          [],
          "They keep your friend code, so they can still send you invites."
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
  return `
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
      ${friends
        .map((friend) =>
          this.renderActionRow({
            focusKey: `watchParty:friend:${friend.code}`,
            title: friend.name,
            subtitle: formatFriendCode(friend.code),
            value: t("party_remove"),
            leadingIcon: "person"
          })
        )
        .join("")}
      ${this.renderActionRow({
        focusKey: "watchParty:addFriend",
        title: t("party_friend_add", [], "Add friend"),
        subtitle: t(
          "party_friend_add_sub",
          [],
          "Enter their friend code to invite them from a watch party."
        ),
        leadingIcon: "person_add"
      })}`;
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
        <div class="settings-stack">${row}${renderFriendRows.call(this, friends)}</div>
      </div>
    `;
}
