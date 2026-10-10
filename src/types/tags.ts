/**
 * Tags put on individual media items.
 *
 * A media item is named by the chat it is in and its message id, which is all
 * the database is ever told about it. Tags live in the local SQLite file and are
 * never shared.
 */

export type Tag = {
    id: number;
    name: string;
    /** How much media across every chat carries this tag. */
    count: number;
    /**
     * Which chats that media is in, busiest first.
     *
     * Ids only — a chat's title lives on the peer, and the peer never reaches
     * the server. The browser resolves the names against Telegram.
     */
    chats: TagChat[];
    /** Chats beyond the listed ones, when a tag spans more than fits. */
    moreChats: number;
    /** One of the tags every library starts with, which cannot be deleted. */
    builtin: boolean;
    /** The folder it is filed under, or null when it is unfiled. */
    folderId: number | null;
    /** Shown in the library rail, one press from its page. */
    pinned: boolean;
};

/** One tagged item, named the way the database names it. */
export type TaggedRef = {
    chatId: number;
    messageId: number;
};

/** One page of a tag's media across every chat, most recently tagged first. */
export type TaggedAcrossPage = {
    refs: TaggedRef[];
    /** The `media_tags` row id to continue below, or null at the end. */
    nextCursor: number | null;
};

/** A named group of tags. Folders only organise the vocabulary. */
export type TagFolder = {
    id: number;
    name: string;
};

/** One chat a tag is used in, and how much of it is tagged. */
export type TagChat = {
    chatId: number;
    count: number;
};

/** A tag as it appears on one media item, without the global count. */
export type MediaItemTag = Pick<Tag, 'id' | 'name'>;

/** How often a tag is used inside the chat being looked at. */
export type ChatTagCount = {
    name: string;
    count: number;
};

/**
 * How a stack of tag filters combines.
 *
 * `any` is the union — media carrying any one of them — and is the default
 * everywhere, because it is what every link written before this existed means.
 * `all` is the intersection: media carrying every one of them.
 */
export type TagMatch = 'any' | 'all';

/**
 * One page of message ids carrying a tag.
 *
 * Telegram cannot search our tags, so the database answers with ids and the
 * client asks Telegram for the media itself. `nextOffset` is the last message
 * id of this page, not a row count, so a tag gained or lost mid-scroll cannot
 * make the client skip or repeat an item.
 */
export type TaggedPage = {
    messageIds: number[];
    nextOffset: number | null;
    /**
     * Counted on the first page only, and null after it. The grid reads the
     * total off page one and never looks again, so counting every page would
     * cost a full index scan for a number nothing reads.
     */
    total: number | null;
};
