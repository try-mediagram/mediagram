import { Chat, tl } from '@mtcute/web';

import { debug } from '@/lib/debug';
import type { ChatTarget } from '@/lib/telegram/chat-target';
import { getClient } from '@/lib/telegram/client';
import { kindOf } from '@/lib/telegram/dialogs';
import { withFloodWait } from '@/lib/telegram/errors';
import type { ChatKind } from '@/lib/telegram/types';

/**
 * Turning a parsed target into a chat we can open, and joining it if we must.
 *
 * The reading half lives in chat-target.ts; this is the half that talks. It all
 * runs on the browser's own MTProto session, so Laravel never learns which chat
 * was pasted — which is the whole reason a feature like this can live here at
 * all. See `.ai/rules/telegram.md`.
 */

export type ResolvedChat = {
    target: ChatTarget;
    /**
     * The chat's marked id, or null when Telegram will not name it until we
     * join — which is the whole point of a private invite.
     */
    chatId: number | null;
    title: string;
    kind: ChatKind;
    memberCount: number | null;
    /** Already in it, so there is nothing to join. */
    joined: boolean;
    /** Joining puts us in a queue for an admin rather than in the chat. */
    needsApproval: boolean;
};

/**
 * Ask Telegram what this is, without joining anything.
 *
 * For a handle or an id that is one `getPeer`. For a private invite it is
 * `messages.checkChatInvite`, called raw rather than through mtcute's
 * `getChatPreview`, because that helper throws away the one answer we most need
 * to act on: `chatInviteAlready` carries the chat itself, which is how somebody
 * who is already a member gets sent straight in instead of being offered a Join
 * button for a chat they are standing in.
 */
export async function resolveChatTarget(
    target: ChatTarget,
): Promise<ResolvedChat> {
    const tg = getClient();

    if (target.kind === 'invite') {
        const invite = await withFloodWait(() =>
            tg.call({ _: 'messages.checkChatInvite', hash: target.hash }),
        );
        debug('join', 'checked invite', invite._);

        if (invite._ === 'chatInvite') {
            return {
                target,
                chatId: null,
                title: invite.title,
                kind: inviteKind(invite),
                memberCount: invite.participantsCount,
                joined: false,
                needsApproval: Boolean(invite.requestNeeded),
            };
        }

        // chatInviteAlready and chatInvitePeek both hand back the chat. A peek
        // is a member for as long as it lasts, and treating it as one is right:
        // the media opens, and Telegram is the thing that decides when it stops.
        const chat = new Chat(invite.chat);
        return {
            target,
            chatId: chat.id,
            title: chat.displayName,
            kind: kindOf(chat),
            memberCount: null,
            joined: invite._ === 'chatInviteAlready',
            needsApproval: false,
        };
    }

    const peer = await withFloodWait(() =>
        tg.getPeer(
            target.kind === 'username' ? target.username : target.chatId,
        ),
    );

    return {
        target,
        chatId: peer.id,
        title: peer.displayName,
        kind: kindOf(peer),
        memberCount: null,
        // A conversation with a person is not something you join, so there is
        // never anything to offer there.
        joined: peer.type === 'user' ? true : peer.isMember,
        needsApproval: false,
    };
}

/**
 * Join, and come back with the id to open.
 *
 * mtcute's `joinChat` takes the invite link itself and runs
 * `messages.importChatInvite` for it, so the two shapes stay one call here. A
 * chat that queues joins returns no id, because there is nothing to open yet.
 */
export async function joinChatTarget(
    target: ChatTarget,
): Promise<{ status: 'ok'; chatId: number } | { status: 'request_sent' }> {
    const tg = getClient();

    const peer =
        target.kind === 'invite'
            ? target.link
            : target.kind === 'username'
              ? target.username
              : target.chatId;

    const result = await withFloodWait(() => tg.joinChat(peer));
    debug('join', 'joined', result.status);

    if (result.status === 'ok') {
        return { status: 'ok', chatId: result.chat.id };
    }

    if (result.status === 'request_sent') {
        return { status: 'request_sent' };
    }

    throw new Error('Telegram wants this chat opened in its own app.');
}

/**
 * A preview carries no chat object, only flags, so this is the one place a kind
 * is worked out by hand rather than by kindOf.
 */
function inviteKind(invite: tl.RawChatInvite): ChatKind {
    return invite.broadcast ? 'channel' : 'group';
}
