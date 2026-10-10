/**
 * What a raw MTProto update says about the chats on screen.
 *
 * The session runs with `disableUpdates`, so there is no updates manager to
 * hand us parsed `Message`s. Raw updates still reach `onServerUpdate`, and
 * these are read for the only things the chat needs from them: which chat
 * moved, which message, and whether this account wrote it. The message itself
 * is then fetched through the normal path, so nothing here has to be trusted
 * to describe it.
 *
 * Imports nothing, so it can be tested without a session.
 */

export type MessageEvent =
    | {
          type: 'new';
          chatId: number;
          messageId: number;
          outgoing: boolean;
          /** Plain text of the message, when the update carried it. */
          text: string;
          /** Telegram's own "don't make a sound" flag. */
          silent: boolean;
          /** The message mentions this account. */
          mentioned: boolean;
      }
    | { type: 'edit'; chatId: number; messageId: number }
    | { type: 'delete'; chatId: number | null; messageIds: number[] }
    | { type: 'read-outbox'; chatId: number; maxId: number }
    | {
          type: 'typing';
          chatId: number;
          /** Who is doing it; in a private chat, the chat itself. */
          userId: number | null;
          /** What they are doing, or null when they stopped. */
          action: TypingAction | null;
      };

/** What the other side is busy with, in the words the header shows. */
export type TypingAction =
    | 'typing'
    | 'recording-voice'
    | 'recording-video'
    | 'uploading-photo'
    | 'uploading-video'
    | 'uploading-file'
    | 'choosing-sticker';

const TYPING_ACTIONS: Record<string, TypingAction> = {
    sendMessageTypingAction: 'typing',
    sendMessageRecordAudioAction: 'recording-voice',
    sendMessageUploadAudioAction: 'recording-voice',
    sendMessageRecordRoundAction: 'recording-video',
    sendMessageUploadRoundAction: 'recording-video',
    sendMessageRecordVideoAction: 'recording-video',
    sendMessageUploadPhotoAction: 'uploading-photo',
    sendMessageUploadVideoAction: 'uploading-video',
    sendMessageUploadDocumentAction: 'uploading-file',
    sendMessageChooseStickerAction: 'choosing-sticker',
};

/**
 * The action Telegram named, or null for a cancel. Anything else it may grow
 * (game play, emoji interactions) reads as plain typing rather than vanishing.
 */
function typingAction(action: unknown): TypingAction | null {
    if (!isRaw(action) || action._ === 'sendMessageCancelAction') return null;
    return TYPING_ACTIONS[action._] ?? 'typing';
}

type Raw = { _: string; [key: string]: unknown };

/** Telegram's channel ids are marked by sitting below -10^12. */
const CHANNEL_MARK = 1_000_000_000_000;

function isRaw(value: unknown): value is Raw {
    return (
        typeof value === 'object' &&
        value !== null &&
        typeof (value as Raw)._ === 'string'
    );
}

/** The id the rest of the app uses for a peer — the "marked" one. */
export function markedPeerId(peer: unknown): number | null {
    if (!isRaw(peer)) return null;
    if (peer._ === 'peerUser' && typeof peer.userId === 'number')
        return peer.userId;
    if (peer._ === 'peerChat' && typeof peer.chatId === 'number')
        return -peer.chatId;
    if (peer._ === 'peerChannel' && typeof peer.channelId === 'number')
        return -(CHANNEL_MARK + peer.channelId);
    return null;
}

function fromMessage(message: unknown): MessageEvent | null {
    if (!isRaw(message) || message._ !== 'message') return null;
    const chatId = markedPeerId(message.peerId);
    if (chatId === null || typeof message.id !== 'number') return null;
    return {
        type: 'new',
        chatId,
        messageId: message.id,
        outgoing: message.out === true,
        text: typeof message.message === 'string' ? message.message : '',
        silent: message.silent === true,
        mentioned: message.mentioned === true,
    };
}

function editOf(message: unknown): MessageEvent | null {
    if (!isRaw(message)) return null;
    const chatId = markedPeerId(message.peerId);
    if (chatId === null || typeof message.id !== 'number') return null;
    return { type: 'edit', chatId, messageId: message.id };
}

function fromUpdate(update: unknown): MessageEvent[] {
    if (!isRaw(update)) return [];

    switch (update._) {
        case 'updateNewMessage':
        case 'updateNewChannelMessage': {
            const event = fromMessage(update.message);
            return event ? [event] : [];
        }
        case 'updateEditMessage':
        case 'updateEditChannelMessage': {
            const event = editOf(update.message);
            return event ? [event] : [];
        }
        case 'updateDeleteMessages':
            // A private or basic-group delete names no chat: message ids are
            // account-wide there, so every open stream has to look.
            return Array.isArray(update.messages)
                ? [
                      {
                          type: 'delete',
                          chatId: null,
                          messageIds: update.messages as number[],
                      },
                  ]
                : [];
        case 'updateDeleteChannelMessages':
            return typeof update.channelId === 'number' &&
                Array.isArray(update.messages)
                ? [
                      {
                          type: 'delete',
                          chatId: -(CHANNEL_MARK + update.channelId),
                          messageIds: update.messages as number[],
                      },
                  ]
                : [];
        case 'updateReadHistoryOutbox': {
            const chatId = markedPeerId(update.peer);
            return chatId !== null && typeof update.maxId === 'number'
                ? [{ type: 'read-outbox', chatId, maxId: update.maxId }]
                : [];
        }
        case 'updateReadChannelOutbox':
            return typeof update.channelId === 'number' &&
                typeof update.maxId === 'number'
                ? [
                      {
                          type: 'read-outbox',
                          chatId: -(CHANNEL_MARK + update.channelId),
                          maxId: update.maxId,
                      },
                  ]
                : [];
        case 'updateUserTyping':
            return typeof update.userId === 'number'
                ? [
                      {
                          type: 'typing',
                          chatId: update.userId,
                          userId: update.userId,
                          action: typingAction(update.action),
                      },
                  ]
                : [];
        case 'updateChatUserTyping':
            return typeof update.chatId === 'number'
                ? [
                      {
                          type: 'typing',
                          chatId: -update.chatId,
                          userId: markedPeerId(update.fromId),
                          action: typingAction(update.action),
                      },
                  ]
                : [];
        case 'updateChannelUserTyping':
            return typeof update.channelId === 'number'
                ? [
                      {
                          type: 'typing',
                          chatId: -(CHANNEL_MARK + update.channelId),
                          userId: markedPeerId(update.fromId),
                          action: typingAction(update.action),
                      },
                  ]
                : [];
        default:
            return [];
    }
}

/**
 * Every message event inside one server push.
 *
 * Telegram wraps the same news several ways: a lone `updateShort`, a batch in
 * `updates` / `updatesCombined`, and two compact forms for private and group
 * text (`updateShortMessage`, `updateShortChatMessage`) that carry no peer
 * object at all.
 */
export function messageEventsFrom(updates: unknown): MessageEvent[] {
    if (!isRaw(updates)) return [];

    switch (updates._) {
        case 'updateShort':
            return fromUpdate(updates.update);
        case 'updates':
        case 'updatesCombined':
            return Array.isArray(updates.updates)
                ? updates.updates.flatMap(fromUpdate)
                : [];
        case 'updateShortMessage':
            return typeof updates.userId === 'number' &&
                typeof updates.id === 'number'
                ? [
                      {
                          type: 'new',
                          chatId: updates.userId,
                          messageId: updates.id,
                          outgoing: updates.out === true,
                          text:
                              typeof updates.message === 'string'
                                  ? updates.message
                                  : '',
                          silent: updates.silent === true,
                          mentioned: updates.mentioned === true,
                      },
                  ]
                : [];
        case 'updateShortChatMessage':
            return typeof updates.chatId === 'number' &&
                typeof updates.id === 'number'
                ? [
                      {
                          type: 'new',
                          chatId: -updates.chatId,
                          messageId: updates.id,
                          outgoing: updates.out === true,
                          text:
                              typeof updates.message === 'string'
                                  ? updates.message
                                  : '',
                          silent: updates.silent === true,
                          mentioned: updates.mentioned === true,
                      },
                  ]
                : [];
        default:
            return [];
    }
}
