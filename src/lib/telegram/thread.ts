import type { FileLocation, Message } from '@mtcute/web';

import { blobCache } from '@/lib/blob-cache';
import { getClient } from '@/lib/telegram/client';
import { rememberPeerAvatar } from '@/lib/telegram/dialogs';
import { withFloodWait } from '@/lib/telegram/errors';
import { mediaItemFromMessage } from '@/lib/telegram/media';
import {
    applyChosenReactions,
    FALLBACK_REACTIONS,
    nextChosenReactions,
    spellAsChat,
} from '@/lib/telegram/reactions';
import type {
    ChatHistoryOffset,
    ChatHistoryPage,
    ThreadMessage,
    ThreadMessageKind,
    ThreadPage,
    ThreadReaction,
} from '@/lib/telegram/types';

type ThreadGlobals = typeof globalThis & {
    __mediagramAudioFiles?: Map<string, FileLocation>;
    __mediagramAudioUrls?: Map<string, string>;
};

const threadGlobals = globalThis as ThreadGlobals;
if (!threadGlobals.__mediagramAudioFiles) {
    threadGlobals.__mediagramAudioFiles = new Map();
}
if (!threadGlobals.__mediagramAudioUrls) {
    threadGlobals.__mediagramAudioUrls = new Map();
}
const audioFiles = threadGlobals.__mediagramAudioFiles;
const audioUrls = threadGlobals.__mediagramAudioUrls;

function audioKey(chatId: number, messageId: number) {
    return `${chatId}:${messageId}`;
}

function unixFromIso(iso: string) {
    return Math.floor(new Date(iso).getTime() / 1000);
}

function mergeById(messages: ThreadMessage[]) {
    const map = new Map<number, ThreadMessage>();
    for (const message of messages) map.set(message.id, message);
    return [...map.values()].sort((a, b) => a.id - b.id);
}

function reactionsFromMessage(message: Message): ThreadReaction[] {
    const list = message.reactions?.reactions ?? [];
    const out: ThreadReaction[] = [];
    for (const item of list) {
        if (item.isPaid) continue;
        if (typeof item.emoji !== 'string') continue;
        out.push({
            emoji: item.emoji,
            count: item.count,
            chosen: item.order !== null,
        });
    }
    return out;
}

function kindFromMessage(message: Message): ThreadMessageKind {
    const media = message.media;
    if (!media) return message.text ? 'text' : 'other';
    if (media.type === 'photo') return 'photo';
    if (media.type === 'video') return media.isAnimation ? 'gif' : 'video';
    if (media.type === 'audio') return 'audio';
    if (media.type === 'voice') return 'voice';
    if (media.type === 'document') return 'file';
    return message.text ? 'text' : 'other';
}

export function normalizeThreadMessage(
    message: Message,
    chatId: number,
): ThreadMessage | null {
    if (message.isService && !message.text) return null;
    const media = message.media;
    const kind = kindFromMessage(message);
    if (media && (media.type === 'audio' || media.type === 'voice')) {
        audioFiles.set(audioKey(chatId, message.id), media);
    }
    const sender = message.sender;
    return {
        id: message.id,
        chatId,
        date: message.date.toISOString(),
        dateUnix: Math.floor(message.date.getTime() / 1000),
        senderId: sender.id,
        senderName: message.isOutgoing ? 'You' : sender.displayName,
        senderUsername: sender.username ?? undefined,
        senderAvatarPreview: rememberPeerAvatar(sender),
        text: message.text,
        replyToId: message.replyToMessage?.id ?? undefined,
        kind,
        duration:
            media && (media.type === 'audio' || media.type === 'voice')
                ? media.duration
                : media && media.type === 'video'
                  ? media.duration
                  : undefined,
        audioTitle:
            media && media.type === 'audio'
                ? (media.title ?? undefined)
                : undefined,
        audioPerformer:
            media && media.type === 'audio'
                ? (media.performer ?? undefined)
                : undefined,
        fileName:
            media && 'fileName' in media
                ? (media.fileName ?? undefined)
                : undefined,
        mimeType: media && 'mimeType' in media ? media.mimeType : undefined,
        isOutgoing: message.isOutgoing,
        isEdited: message.editDate !== null,
        reactions: reactionsFromMessage(message),
        // Normalising here registers the source too, so a thumbnail can be
        // downloaded later without fetching the message again.
        media: mediaItemFromMessage(message, chatId) ?? undefined,
    };
}

/**
 * Which reactions a chat takes, and how many this account may leave at once.
 *
 * Both halves of "the reactions don't work" live here. A chat can allow every
 * reaction, a hand-picked few, or none at all (`chatReactionsSome` /
 * `chatReactionsNone`), and a row of buttons drawn without asking offers
 * reactions Telegram will refuse. Free accounts may also leave only one
 * reaction per message, which is why the limit travels with the list.
 */
export type ChatReactionSet = {
    /** Emoticons the chat takes, in Telegram's own spelling. Empty means off. */
    emojis: string[];
    /** How many different reactions this account may leave on one message. */
    maxChosen: number;
};

const reactionSets = new Map<number, Promise<ChatReactionSet>>();
let popular: Promise<string[]> | null = null;
let premium: Promise<boolean> | null = null;

/**
 * The reactions Telegram itself offers, which is what a chat allowing "all"
 * means. Asked once per session — the list is the same for every chat.
 */
function popularReactions(isPremium: boolean): Promise<string[]> {
    popular ??= withFloodWait(() =>
        getClient().call({ _: 'messages.getAvailableReactions', hash: 0 }),
    )
        .then((answer) =>
            answer._ === 'messages.availableReactions'
                ? answer.reactions
                      .filter(
                          (item) =>
                              !item.inactive && (!item.premium || isPremium),
                      )
                      .map((item) => item.reaction)
                : FALLBACK_REACTIONS,
        )
        .catch(() => FALLBACK_REACTIONS);

    return popular;
}

function isPremiumAccount(): Promise<boolean> {
    premium ??= withFloodWait(() => getClient().getMe())
        .then((me) => me.isPremium)
        .catch(() => false);

    return premium;
}

export function loadChatReactions(chatId: number): Promise<ChatReactionSet> {
    let set = reactionSets.get(chatId);
    if (!set) {
        set = fetchChatReactions(chatId).catch((error) => {
            // A chat we could not ask about must not be remembered as one with
            // no reactions — the next open should ask again.
            reactionSets.delete(chatId);
            throw error;
        });
        reactionSets.set(chatId, set);
    }
    return set;
}

/**
 * Forget what the reactions looked like, because the account has changed.
 *
 * Premium is an account fact and a chat's list is read as that account, so both
 * are wrong the moment somebody signs in as somebody else. Called from
 * `logout()`, beside the media caches.
 */
export function clearReactionCaches() {
    reactionSets.clear();
    popular = null;
    premium = null;
}

async function fetchChatReactions(chatId: number): Promise<ChatReactionSet> {
    const isPremium = await isPremiumAccount();
    // Telegram's own cap: one reaction per message, three with Premium.
    const maxChosen = isPremium ? 3 : 1;

    // A conversation with a person has no list of its own — every reaction
    // Telegram publishes is on the table.
    if (chatId >= 0) {
        return { emojis: await popularReactions(isPremium), maxChosen };
    }

    const full = await withFloodWait(() => getClient().getFullChat(chatId));
    const available =
        full.full._ === 'channelFull' || full.full._ === 'chatFull'
            ? full.full.availableReactions
            : undefined;

    if (available?._ === 'chatReactionsNone') {
        return { emojis: [], maxChosen };
    }

    // Only `chatReactionsNone` means off. A chat that says nothing at all is a
    // chat we have not been told about, and hiding the row on a maybe is worse
    // than offering Telegram's own set and letting it answer.
    if (!available || available._ === 'chatReactionsAll') {
        return { emojis: await popularReactions(isPremium), maxChosen };
    }

    return {
        // Custom-emoji reactions are Premium stickers we cannot draw, so they
        // are dropped rather than offered as a button that renders as nothing.
        emojis: available.reactions.flatMap((item) =>
            item._ === 'reactionEmoji' ? [item.emoticon] : [],
        ),
        maxChosen,
    };
}

/**
 * Toggle one reaction on a message.
 *
 * `messages.sendReaction` sets this account's whole reaction set rather than
 * adding to it, so the set is worked out first (`nextChosenReactions`) against
 * the limit the account actually has. What goes over the wire is the emoji as
 * the caller received it from Telegram — never one typed here — because
 * Telegram matches its list byte for byte.
 */
export async function sendThreadReaction(
    message: ThreadMessage,
    emoji: string,
): Promise<ThreadMessage> {
    const { emojis, maxChosen } = await loadChatReactions(message.chatId);
    const { chosen } = nextChosenReactions(message.reactions, emoji, maxChosen);
    const spelled = chosen.map((item) => spellAsChat(item, emojis));

    const result = await withFloodWait(() =>
        getClient().sendReaction({
            chatId: message.chatId,
            message: message.id,
            emoji: spelled.length > 0 ? spelled : null,
        }),
    );

    if (result) {
        const next = normalizeThreadMessage(result, message.chatId);
        if (next) return next;
    }

    // Telegram answers with the edited message for a channel post but not for
    // every chat, so the counts are worked out here when it does not.
    return {
        ...message,
        reactions: applyChosenReactions(message.reactions, spelled),
    };
}

const BATCH = 5;

async function history(
    chatId: number,
    params: {
        id: number;
        date: number;
        limit: number;
        addOffset?: number;
    },
) {
    const page = await withFloodWait(() =>
        getClient().getHistory(chatId, {
            offset: { id: params.id, date: params.date },
            limit: params.limit,
            addOffset: params.addOffset,
        }),
    );
    const messages: ThreadMessage[] = [];
    for (const message of page) {
        const item = normalizeThreadMessage(message, chatId);
        if (item) messages.push(item);
    }
    return messages;
}

function splitUntilVideo(
    messages: ThreadMessage[],
    afterId: number,
): Pick<ThreadPage, 'messages' | 'nextVideo' | 'hasNewer'> {
    const ordered = mergeById(messages).filter((item) => item.id > afterId);
    const shown: ThreadMessage[] = [];
    for (let index = 0; index < ordered.length; index += 1) {
        const message = ordered[index];
        if (message.kind === 'video') {
            return { messages: shown, nextVideo: message, hasNewer: false };
        }
        shown.push(message);
        if (shown.length === BATCH) {
            const peek = ordered[index + 1];
            if (peek?.kind === 'video') {
                return { messages: shown, nextVideo: peek, hasNewer: false };
            }
            return {
                messages: shown,
                hasNewer: Boolean(peek) || ordered.length > BATCH,
            };
        }
    }
    return { messages: shown, hasNewer: false };
}

export async function loadThreadAround(
    chatId: number,
    messageId: number,
    dateIso: string,
): Promise<ThreadPage> {
    const date = unixFromIso(dateIso);
    const [currentBatch, newer] = await Promise.all([
        withFloodWait(() => getClient().getMessages(chatId, [messageId])),
        history(chatId, {
            id: messageId,
            date,
            limit: BATCH + 1,
            addOffset: -(BATCH + 1),
        }),
    ]);
    let current: ThreadMessage | undefined;
    for (const message of currentBatch) {
        if (!message) continue;
        const item = normalizeThreadMessage(message, chatId);
        if (item) current = item;
    }
    return {
        current,
        ...splitUntilVideo(newer, messageId),
    };
}

export async function loadNewerThread(
    chatId: number,
    newest: ThreadMessage,
): Promise<ThreadPage> {
    const newer = await history(chatId, {
        id: newest.id,
        date: newest.dateUnix,
        limit: BATCH + 1,
        addOffset: -(BATCH + 1),
    });
    return splitUntilVideo(newer, newest.id);
}

/** How much of a chat one page of the rail's stream reads. */
const HISTORY_PAGE = 24;

/**
 * What an export asks for instead.
 *
 * 100 is Telegram's own ceiling for `messages.getHistory`. The rail wants a
 * short page because it is filling a scroller a screen at a time; a run that
 * has to walk a whole chat wants the fewest round trips it can get, and the
 * difference is four times less waiting on a long history.
 */
export const HISTORY_PAGE_MAX = 100;

/** Telegram's ceiling for one `messages.getMessages` call. */
const MESSAGES_PER_CALL = 100;

/**
 * A page of the chat itself, oldest first.
 *
 * The rail reads a chat the way Telegram does — the most recent message last —
 * so every page comes back ascending and paging runs backwards from `before`,
 * which is the oldest message already on screen. Telegram answers newest-first
 * whatever we ask, so the ordering is done here rather than trusted.
 */
export async function loadChatHistory(
    chatId: number,
    before?: ChatHistoryOffset,
    limit: number = HISTORY_PAGE,
): Promise<ChatHistoryPage> {
    const page = await withFloodWait(() =>
        getClient().getHistory(chatId, {
            limit,
            offset: before,
        }),
    );

    const messages: ThreadMessage[] = [];
    for (const message of page) {
        const item = normalizeThreadMessage(message, chatId);
        if (item) messages.push(item);
    }
    const ordered = mergeById(messages);
    const oldest = ordered[0];

    return {
        messages: ordered,
        // A short page is the top of the chat. Counting the raw answer rather
        // than what survived normalising is deliberate: a page of nothing but
        // service messages is still a page Telegram had more behind.
        nextOffset:
            page.length < limit || !oldest
                ? undefined
                : { id: oldest.id, date: oldest.dateUnix },
    };
}

/**
 * Named messages, in the order they were asked for.
 *
 * An export scoped to the grid's filters knows which media it wants but not
 * who sent it — `searchChatMedia` answers in `MediaItem`s, which carry a
 * caption and no sender. Reading the messages back is what lets a filtered
 * export still produce a transcript rather than a bare list of files.
 *
 * Batched at 100 because that is all `messages.getMessages` takes, the same
 * ceiling `loadMediaItems` works to.
 */
export async function loadThreadMessages(
    chatId: number,
    messageIds: number[],
): Promise<ThreadMessage[]> {
    const found = new Map<number, ThreadMessage>();

    for (let at = 0; at < messageIds.length; at += MESSAGES_PER_CALL) {
        const batch = messageIds.slice(at, at + MESSAGES_PER_CALL);
        const messages = await withFloodWait(() =>
            getClient().getMessages(chatId, batch),
        );

        for (const message of messages) {
            if (!message) continue;
            const item = normalizeThreadMessage(message, chatId);
            if (item) found.set(item.id, item);
        }
    }

    // A deleted message comes back null and a service message is dropped by
    // normalising, so the answer is shorter than the ids asked for. That is
    // correct — a hole is better than a placeholder claiming to be a message.
    return messageIds
        .map((id) => found.get(id))
        .filter((message): message is ThreadMessage => message !== undefined);
}

export async function downloadThreadAudio(
    chatId: number,
    messageId: number,
    mimeType?: string,
): Promise<string> {
    const key = audioKey(chatId, messageId);
    const cached = audioUrls.get(key) ?? blobCache.get(`audio:${key}`, 'full');
    if (cached) return cached;
    const file = audioFiles.get(key);
    if (!file) throw new Error('That audio is no longer available.');
    const bytes = await withFloodWait(() => getClient().downloadAsBuffer(file));
    const url = blobCache.put(
        `audio:${key}`,
        bytes,
        mimeType || 'audio/mpeg',
        'full',
    );
    audioUrls.set(key, url);
    return url;
}

/**
 * The newest messages of a chat, oldest first.
 *
 * What the stream asks for when Telegram says something new arrived: the
 * newest page is merged over what is on screen rather than reloading every
 * page the reader has scrolled through.
 */
export async function loadLatestMessages(
    chatId: number,
    limit = 20,
): Promise<ThreadMessage[]> {
    const { messages } = await loadChatHistory(chatId, undefined, limit);
    return messages;
}

/** Send plain text, optionally as a reply. Answers with the sent message. */
export async function sendChatText(
    chatId: number,
    text: string,
    replyTo?: number,
): Promise<ThreadMessage | null> {
    const sent = await withFloodWait(() =>
        getClient().sendText(chatId, text, replyTo ? { replyTo } : undefined),
    );
    return normalizeThreadMessage(sent, chatId);
}

/** Replace the text of one of this account's own messages. */
export async function editChatText(
    chatId: number,
    messageId: number,
    text: string,
): Promise<ThreadMessage | null> {
    const edited = await withFloodWait(() =>
        getClient().editMessage({ chatId, message: messageId, text }),
    );
    return normalizeThreadMessage(edited, chatId);
}

/**
 * Delete messages. `revoke` removes them for everyone, which is the default
 * Telegram offers for your own messages; without it they only leave this
 * account's copy of the chat.
 */
export async function deleteChatMessages(
    chatId: number,
    messageIds: number[],
    revoke: boolean,
): Promise<void> {
    await withFloodWait(() =>
        getClient().deleteMessagesById(chatId, messageIds, { revoke }),
    );
}

/** Mark everything up to `maxId` as read, which also clears the unread badge. */
export async function markChatRead(
    chatId: number,
    maxId?: number,
): Promise<void> {
    await withFloodWait(() =>
        getClient().readHistory(chatId, maxId ? { maxId } : undefined),
    );
}

/** Tell the other side this account is typing. Best effort. */
export async function sendTypingAction(chatId: number): Promise<void> {
    try {
        await getClient().sendTyping(chatId, 'typing');
    } catch {
        // A channel this account cannot post in refuses typing; nothing to say.
    }
}

/**
 * The highest outgoing message the other side has read.
 *
 * Read off the dialog itself, then kept current by `updateReadHistoryOutbox`;
 * it is what turns one tick into two.
 */
export async function loadReadOutbox(chatId: number): Promise<number> {
    const [dialog] = await withFloodWait(() =>
        getClient().getPeerDialogs(chatId),
    );
    return dialog?.raw.readOutboxMaxId ?? 0;
}

export type ChatSearchPage = {
    /** Newest first: a search reads as "most recent match" downwards. */
    messages: ThreadMessage[];
    total: number;
    next?: number;
};

const SEARCH_PAGE = 30;

/** Telegram's own full-text search, scoped to one chat. */
export async function searchChatMessages(
    chatId: number,
    query: string,
    offset?: number,
): Promise<ChatSearchPage> {
    const found = await withFloodWait(() =>
        getClient().searchMessages({
            chatId,
            query,
            offset,
            limit: SEARCH_PAGE,
        }),
    );
    const messages: ThreadMessage[] = [];
    for (const message of found) {
        const item = normalizeThreadMessage(message, chatId);
        if (item) messages.push(item);
    }
    return {
        messages,
        total: found.total,
        next: found.length < SEARCH_PAGE ? undefined : found.next,
    };
}
