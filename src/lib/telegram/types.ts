import type { SendBlock } from '@/lib/telegram/can-send';
import type { ReactionCount } from '@/lib/telegram/reactions';

export type MediaKind = 'photo' | 'video' | 'gif' | 'audio' | 'voice';

/**
 * What the grid asks for, in the categories a reader actually thinks in.
 *
 * Deliberately coarser than MediaKind: Telegram files animations and video
 * notes apart from video, and voice apart from music, but someone looking for
 * "video" wants all three of those. The kinds each category covers live in
 * media.ts.
 */
export type MediaTypeFilter = 'all' | 'photo' | 'video' | 'audio';

export type MediaOrder = 'new' | 'old';

export type ChatKind =
    | 'saved'
    | 'direct'
    | 'bot'
    | 'group'
    | 'channel'
    | 'chat';

export type DialogItem = {
    id: number;
    title: string;
    username: string | null;
    kind: ChatKind;
    isPinned: boolean;
    isSelf: boolean;
    hasPhoto: boolean;
    /** Telegram flagged this peer as restricted on at least one platform. */
    isRestricted: boolean;
    /** Raw restriction reasons from Telegram, e.g. `porno`, `terms`. */
    restrictionReasons: string[];
    avatarPreview?: string;
    unreadCount: number;
    /** True when this dialog lives in Telegram's Archive folder. */
    isArchived: boolean;
    /** True when Telegram considers this dialog muted. */
    isMuted: boolean;
    /** True when Telegram considers this dialog unread (mark or count). */
    isUnread: boolean;
    /** True for users who are in the account's contacts. */
    isContact: boolean;
    /**
     * True when the account is in this chat.
     *
     * A public channel opens and reads without joining, so this is not
     * permission — it is what decides whether the chat screen offers a Join.
     * Always true for a conversation with a person: there is nothing to join.
     */
    isMember: boolean;
    /**
     * Whether this account may post media here.
     *
     * Decided once in `can-send.ts` off the peer, so the Send button and
     * anything else that offers to write agree. A broadcast refuses everyone
     * but its admins, a supergroup can ban media while still allowing talk,
     * and a public chat you can read is not one you can post to.
     */
    canSendMedia: boolean;
    /** Why not, when `canSendMedia` is false. */
    sendBlockedReason: SendBlock | null;
    /**
     * Whether this account may write a message here at all — a group can
     * mute its members while still being readable. Decided in `can-send.ts`.
     */
    canWrite: boolean;
    /** Why not, when `canWrite` is false. */
    writeBlockedReason: SendBlock | null;
    /**
     * The chat's own `noforwards`. Informational only: Mediagram downloads
     * and exports from these chats like any other.
     */
    hasProtectedContent: boolean;
    lastMessageAt?: string;
    lastMessageId?: number;
    lastMediaId?: number;
    lastMediaAt?: string;
    lastMediaKind?: MediaKind;
};

export type MediaQuality = {
    id: string;
    label: string;
    width: number;
    height: number;
    fileSize?: number;
    hasHls: boolean;
};

export type MediaItem = {
    key: string;
    chatId: number;
    messageId: number;
    date: string;
    type: MediaKind;
    width: number;
    height: number;
    duration?: number;
    /**
     * Telegram's `supports_streaming` flag for a video: false means the MP4
     * index is most likely at the end of the file. Undefined when unknown.
     */
    streamable?: boolean;
    fileSize?: number;
    mimeType?: string;
    fileName?: string;
    caption?: string;
    /** Track title from the audio's own tags. */
    audioTitle?: string;
    /** Track performer from the audio's own tags. */
    audioPerformer?: string;
    /** Sender hid this media behind a spoiler. */
    hasSpoiler: boolean;
    /** Telegram forbids saving this media. */
    isContentProtected: boolean;
    /**
     * The best rendition Telegram offers, and the only one we ever play or
     * download. Telegram's alternates are downscaled transcodes of the
     * original, and nobody opens a video to watch a smaller copy of it.
     */
    quality: MediaQuality;
};

export type MediaSearchParams = {
    chatId: number;
    type: MediaTypeFilter;
    order?: MediaOrder;
    minDuration?: number;
    maxDuration?: number;
    offset?: number;
    /** Telegram-side text search over the chat's messages (caption, filename). */
    query?: string;
};

export type MediaPage = {
    items: MediaItem[];
    nextOffset?: number;
    total: number;
};

export type ThreadMessageKind =
    | 'text'
    | 'photo'
    | 'video'
    | 'gif'
    | 'audio'
    | 'voice'
    | 'file'
    | 'other';

/**
 * One reaction on a message. The shape lives in `reactions.ts`, which is where
 * everything that reads it lives too — and which imports nothing, so it can be
 * tested without a session.
 */
export type ThreadReaction = ReactionCount;

export type ThreadMessage = {
    id: number;
    chatId: number;
    date: string;
    dateUnix: number;
    senderId?: number;
    senderName: string;
    senderUsername?: string;
    senderAvatarPreview?: string;
    text: string;
    replyToId?: number;
    kind: ThreadMessageKind;
    duration?: number;
    audioTitle?: string;
    audioPerformer?: string;
    fileName?: string;
    mimeType?: string;
    isOutgoing: boolean;
    /** Telegram marks the message as edited after it was sent. */
    isEdited?: boolean;
    reactions: ThreadReaction[];
    /**
     * The message's own media, already normalised and registered, when it is
     * something we can show. Carrying it here is what lets the rail paint a
     * thumbnail beside the text without asking Telegram for the message twice.
     */
    media?: MediaItem;
};

export type ThreadPage = {
    current?: ThreadMessage;
    messages: ThreadMessage[];
    nextVideo?: ThreadMessage;
    hasNewer: boolean;
};

/** Where the next (older) page of a chat starts, in Telegram's own terms. */
export type ChatHistoryOffset = {
    id: number;
    date: number;
};

export type ChatHistoryPage = {
    /** Oldest first, so the most recent message is the last one. */
    messages: ThreadMessage[];
    /** Absent at the top of the chat: there is nothing older to ask for. */
    nextOffset?: ChatHistoryOffset;
};

export type AccountUser = {
    id: number;
    name: string;
    username: string | null;
};

export type TelegramCredentials = {
    apiId: number;
    apiHash: string;
};

/**
 * A user-created Telegram folder (dialog filter), already reduced to the
 * fields the library can filter on without another MTProto round-trip.
 *
 * Telegram's default "All" filter is a sentinel and is never listed here.
 */
export type DialogFolder = {
    id: number;
    title: string;
    includePeerIds: number[];
    excludePeerIds: number[];
    pinnedPeerIds: number[];
    contacts: boolean;
    nonContacts: boolean;
    groups: boolean;
    broadcasts: boolean;
    bots: boolean;
    excludeMuted: boolean;
    excludeRead: boolean;
    excludeArchived: boolean;
    isChatlist: boolean;
};
