import { db, now, placeholders } from '@/lib/db';
import type { MediaOrder } from '@/lib/telegram/types';
import type {
    ChatTagCount,
    MediaItemTag,
    Tag,
    TagChat,
    TagFolder,
    TaggedAcrossPage,
    TaggedPage,
    TaggedRef,
    TagMatch,
} from '@/types/tags';

/**
 * Tags, and which media each is on.
 *
 * Stored in the local SQLite file (see `lib/db.ts`). What is written is a chat
 * id, a message id and a word — never a photo, a caption or a peer. Telegram
 * media does not leave the window and this does not change that.
 *
 * Nothing here answers with the whole chat. The vocabulary is one row per tag,
 * and the chips are looked up for the media the grid is actually holding — a
 * chat with ten thousand tagged items must not make opening it a
 * ten-thousand-row read.
 */

/** The longest a tag may be. */
export const TAG_MAX_LENGTH = 32;

/** How many chats are listed under one tag before the rest are summarised. */
const CHATS_PER_TAG = 20;

/**
 * How many message ids one page of a tag filter carries.
 *
 * Must stay at or under 100: the client turns a page straight into one
 * `messages.getMessages` call, and Telegram will not take more ids than that
 * in a single request.
 */
const PAGE = 18;

/** The most media the chip lookup — and so a bulk tag — will answer for. */
const LOOKUP_LIMIT = 500;

/** How many tags one filter may stack. */
const MAX_TAGS = 20;

/**
 * The tags every library starts with. They are seeded by a migration
 * (src-tauri/src/lib.rs) and cannot be deleted: they can be taken off media
 * like any other tag, but the word itself always stays.
 */
export const BUILTIN_TAGS: readonly string[] = ['favorite', 'bookmark'];

export function isBuiltinTag(name: string): boolean {
    return BUILTIN_TAGS.includes(name);
}

const INVALID_TAG =
    'A tag is a single word: letters, numbers, dashes or underscores.';

/** The longest a folder name may be. */
export const FOLDER_MAX_LENGTH = 40;

/**
 * Create a tag, or hand back the one that already has this name. A new tag is
 * filed under `folderId` when one is given; an existing one is left where it is.
 */
export async function createTag(
    name: string,
    folderId: number | null = null,
): Promise<Tag> {
    const normalised = normaliseTag(name);
    if (normalised === null) throw new Error(INVALID_TAG);

    const conn = await db();
    const stamp = now();
    await conn.execute(
        'INSERT OR IGNORE INTO tags (name, folder_id, created_at, updated_at) VALUES ($1, $2, $3, $3)',
        [normalised, isBuiltinTag(normalised) ? null : folderId, stamp],
    );

    const [row] = await conn.select<TagRow[]>(
        'SELECT id, name, folder_id, pinned FROM tags WHERE name = $1',
        [normalised],
    );
    if (!row) throw new Error('Could not create that tag.');

    return {
        id: row.id,
        name: row.name,
        count: 0,
        chats: [],
        moreChats: 0,
        builtin: isBuiltinTag(row.name),
        folderId: row.folder_id,
        pinned: Boolean(row.pinned),
    };
}

/** A `tags` row as the reads here select it. */
type TagRow = {
    id: number;
    name: string;
    folder_id: number | null;
    pinned: number;
};

/**
 * Delete a tag and take it off everything it was on. The built-in tags are
 * refused: the UI offers no way to delete them, and this holds even if asked.
 */
export async function deleteTag(tagId: number): Promise<Tag[]> {
    const conn = await db();
    const [tag] = await conn.select<{ name: string }[]>(
        'SELECT name FROM tags WHERE id = $1',
        [tagId],
    );
    if (tag && isBuiltinTag(tag.name)) {
        throw new Error(`“${tag.name}” is built in and cannot be deleted.`);
    }
    // Explicitly, rather than through ON DELETE CASCADE: the plugin pools
    // connections, so `PRAGMA foreign_keys` cannot be relied on to be set.
    await conn.execute('DELETE FROM media_tags WHERE tag_id = $1', [tagId]);
    await conn.execute('DELETE FROM tags WHERE id = $1', [tagId]);
    return fetchTags();
}

/**
 * The whole vocabulary, with how much media each tag is on and which chats
 * that media is in. One grouped query for the whole vocabulary rather than
 * one per tag.
 */
export async function fetchTags(): Promise<Tag[]> {
    const conn = await db();

    const [tags, usage] = await Promise.all([
        conn.select<TagRow[]>(
            'SELECT id, name, folder_id, pinned FROM tags ORDER BY name',
        ),
        conn.select<{ tag_id: number; chat_id: number; total: number }[]>(
            `SELECT tag_id, chat_id, count(*) AS total
             FROM media_tags
             GROUP BY tag_id, chat_id
             ORDER BY total DESC`,
        ),
    ]);

    const byTag = new Map<number, TagChat[]>();
    for (const row of usage) {
        const chats = byTag.get(row.tag_id) ?? [];
        chats.push({ chatId: row.chat_id, count: row.total });
        byTag.set(row.tag_id, chats);
    }

    const all = tags.map((tag) => {
        const chats = byTag.get(tag.id) ?? [];
        return {
            id: tag.id,
            name: tag.name,
            count: chats.reduce((sum, chat) => sum + chat.count, 0),
            chats: chats.slice(0, CHATS_PER_TAG),
            moreChats: Math.max(0, chats.length - CHATS_PER_TAG),
            builtin: isBuiltinTag(tag.name),
            folderId: tag.folder_id,
            pinned: Boolean(tag.pinned),
        };
    });

    // The built-ins lead, in their own order; the rest stay alphabetical.
    const rank = (tag: Tag) =>
        tag.builtin ? BUILTIN_TAGS.indexOf(tag.name) : BUILTIN_TAGS.length;
    return all.sort((a, b) => rank(a) - rank(b));
}

/** Every folder, alphabetical. */
export async function fetchFolders(): Promise<TagFolder[]> {
    return (await db()).select<TagFolder[]>(
        'SELECT id, name FROM tag_folders ORDER BY name COLLATE NOCASE',
    );
}

/** Create a folder, or hand back the one that already has this name. */
export async function createFolder(name: string): Promise<TagFolder> {
    const clean = normaliseFolderName(name);
    if (clean === null) throw new Error('A folder needs a name.');

    const conn = await db();
    const stamp = now();
    await conn.execute(
        'INSERT OR IGNORE INTO tag_folders (name, created_at, updated_at) VALUES ($1, $2, $2)',
        [clean, stamp],
    );
    const [row] = await conn.select<TagFolder[]>(
        'SELECT id, name FROM tag_folders WHERE name = $1',
        [clean],
    );
    if (!row) throw new Error('Could not create that folder.');
    return row;
}

export async function renameFolder(
    folderId: number,
    name: string,
): Promise<void> {
    const clean = normaliseFolderName(name);
    if (clean === null) throw new Error('A folder needs a name.');

    const conn = await db();
    const [taken] = await conn.select<{ id: number }[]>(
        'SELECT id FROM tag_folders WHERE name = $1 AND id != $2',
        [clean, folderId],
    );
    if (taken) throw new Error(`There is already a folder called “${clean}”.`);

    await conn.execute(
        'UPDATE tag_folders SET name = $1, updated_at = $2 WHERE id = $3',
        [clean, now(), folderId],
    );
}

/**
 * Delete a folder. Its tags are not deleted: they go back to unfiled, so this
 * never takes a tag off any media.
 */
export async function deleteFolder(folderId: number): Promise<void> {
    const conn = await db();
    // Explicitly, for the same reason deleteTag does not lean on cascades.
    await conn.execute(
        'UPDATE tags SET folder_id = NULL WHERE folder_id = $1',
        [folderId],
    );
    await conn.execute('DELETE FROM tag_folders WHERE id = $1', [folderId]);
}

/** File a tag under a folder, or unfile it with null. Built-ins stay put. */
export async function moveTag(
    tagId: number,
    folderId: number | null,
): Promise<void> {
    const conn = await db();
    const [tag] = await conn.select<{ name: string }[]>(
        'SELECT name FROM tags WHERE id = $1',
        [tagId],
    );
    if (!tag || isBuiltinTag(tag.name)) return;
    await conn.execute(
        'UPDATE tags SET folder_id = $1, updated_at = $2 WHERE id = $3',
        [folderId, now(), tagId],
    );
}

/** Pin a tag to the library rail, or take it off. */
export async function setTagPinned(
    tagId: number,
    pinned: boolean,
): Promise<void> {
    await (await db()).execute(
        'UPDATE tags SET pinned = $1, updated_at = $2 WHERE id = $3',
        [pinned ? 1 : 0, now(), tagId],
    );
}

/** One tag by name, or null when there is no such tag. */
export async function fetchTag(name: string): Promise<Tag | null> {
    const normalised = normaliseTag(name);
    if (normalised === null) return null;
    return (await fetchTags()).find((tag) => tag.name === normalised) ?? null;
}

/** How many of a tag's items a folder card shows peeking out. */
export const PREVIEW_COUNT = 3;

/**
 * The items a tag was most recently put on, across every chat — what its
 * folder card shows. Ordered by the `media_tags` row, which is the order they
 * were tagged in, rather than by message id, which means nothing across chats.
 */
export async function fetchTagPreviews(
    tagId: number,
    limit = PREVIEW_COUNT,
): Promise<TaggedRef[]> {
    return (await fetchTaggedAcross(tagId, undefined, limit)).refs;
}

/** How many items one page of a tag's own page holds. */
const ACROSS_PAGE = 60;

/**
 * One page of a tag's media across every chat, most recently tagged first.
 * The cursor is the last row id of the previous page, so tagging something
 * mid-scroll cannot make the page skip or repeat an item.
 */
export async function fetchTaggedAcross(
    tagId: number,
    cursor?: number,
    limit = ACROSS_PAGE,
): Promise<TaggedAcrossPage> {
    const rows = await (await db()).select<
        { id: number; chat_id: number; message_id: number }[]
    >(
        `SELECT id, chat_id, message_id FROM media_tags
         WHERE tag_id = $1 ${cursor ? 'AND id < $2' : ''}
         ORDER BY id DESC
         LIMIT ${Math.max(1, Math.min(limit, ACROSS_PAGE))}`,
        cursor ? [tagId, cursor] : [tagId],
    );
    return {
        refs: rows.map((row) => ({
            chatId: row.chat_id,
            messageId: row.message_id,
        })),
        nextCursor:
            rows.length === limit ? (rows[rows.length - 1]?.id ?? null) : null,
    };
}

/** Trim a folder name, or null when nothing is left. Any text is allowed. */
export function normaliseFolderName(name: string): string | null {
    const trimmed = name.trim().replace(/\s+/g, ' ');
    if (trimmed === '') return null;
    return [...trimmed].slice(0, FOLDER_MAX_LENGTH).join('');
}

/**
 * The tags in use in this chat, with counts, busiest first — one row per tag,
 * so this stays small however much has been tagged. It fills the tag filter.
 */
export async function fetchChatVocabulary(
    chatId: number,
): Promise<{ tags: ChatTagCount[] }> {
    const rows = await (await db()).select<{ name: string; total: number }[]>(
        `SELECT tags.name AS name, count(*) AS total
         FROM media_tags
         JOIN tags ON tags.id = media_tags.tag_id
         WHERE media_tags.chat_id = $1
         GROUP BY tags.name
         ORDER BY total DESC, tags.name`,
        [chatId],
    );

    return {
        tags: rows.map((row) => ({ name: row.name, count: row.total })),
    };
}

/**
 * The tags on the media the grid is currently holding, keyed by message id.
 *
 * Asked for by id rather than by chat: a chat with ten thousand tagged items
 * must not make opening it a ten-thousand-row read.
 */
export async function fetchTagsOn(
    chatId: number,
    messageIds: number[],
): Promise<Record<string, MediaItemTag[]>> {
    const ids = uniqueIds(messageIds).slice(0, LOOKUP_LIMIT);
    if (ids.length === 0) return {};

    const rows = await (await db()).select<
        { message_id: number; id: number; name: string }[]
    >(
        `SELECT media_tags.message_id AS message_id, tags.id AS id, tags.name AS name
         FROM media_tags
         JOIN tags ON tags.id = media_tags.tag_id
         WHERE media_tags.chat_id = $1
           AND media_tags.message_id IN (${placeholders(ids.length, 2)})
         ORDER BY tags.name`,
        [chatId, ...ids],
    );

    const onMedia: Record<string, MediaItemTag[]> = {};
    for (const row of rows) {
        (onMedia[String(row.message_id)] ??= []).push({
            id: row.id,
            name: row.name,
        });
    }
    return onMedia;
}

/** Attach a tag to a piece of media. Attaching twice is a no-op. */
export async function attachTag(
    chatId: number,
    messageId: number,
    tagId: number,
): Promise<void> {
    await attachMany(tagId, chatId, [messageId]);
}

/**
 * Take a tag off a piece of media. Detaching what was never attached is a
 * no-op, so the caller never has to check first.
 */
export async function detachTag(
    chatId: number,
    messageId: number,
    tagId: number,
): Promise<void> {
    await detachMany(tagId, chatId, [messageId]);
}

/**
 * Put one tag on, or take it off, a whole selection at once — one write
 * rather than one per item.
 *
 * Answers with the refreshed vocabulary and the tags now on the media that was
 * touched, so the caller can settle its chips without a second read.
 */
export async function bulkTag(
    chatId: number,
    messageIds: number[],
    tagId: number,
    action: 'attach' | 'detach',
): Promise<{
    changed: number;
    tags: ChatTagCount[];
    onMedia: Record<string, MediaItemTag[]>;
}> {
    const ids = uniqueIds(messageIds).slice(0, LOOKUP_LIMIT);

    const changed =
        action === 'attach'
            ? await attachMany(tagId, chatId, ids)
            : await detachMany(tagId, chatId, ids);

    const [{ tags }, onMedia] = await Promise.all([
        fetchChatVocabulary(chatId),
        fetchTagsOn(chatId, ids),
    ]);

    return { changed, tags, onMedia };
}

/**
 * One page of message ids carrying these tags, newest first unless `order`
 * says otherwise. The media itself is then fetched from Telegram by the caller.
 *
 * `match` says what stacking two of them does: `any` widens the page to what
 * either is on, `all` narrows it to what carries both.
 *
 * `offset` is the last message id of the previous page rather than a row
 * count, so a tag gained or lost mid-scroll cannot make the client skip or
 * repeat an item.
 */
export async function fetchTaggedIds(
    chatId: number,
    tags: string[],
    order: MediaOrder,
    offset?: number,
    match: TagMatch = 'any',
): Promise<TaggedPage> {
    const names = [
        ...new Set(
            tags
                .slice(0, MAX_TAGS)
                .map(normaliseTag)
                .filter((name): name is string => name !== null),
        ),
    ];

    if (names.length === 0) {
        return { messageIds: [], nextOffset: null, total: 0 };
    }

    const conn = await db();
    const tagIds = (
        await conn.select<{ id: number }[]>(
            `SELECT id FROM tags WHERE name IN (${placeholders(names.length)})`,
            names,
        )
    ).map((row) => row.id);

    const matchAll = match === 'all';

    // A name nothing resolves to is merely dropped from a union, but it makes
    // an intersection unsatisfiable.
    if (tagIds.length === 0 || (matchAll && tagIds.length !== names.length)) {
        return { messageIds: [], nextOffset: null, total: 0 };
    }

    // Resolved to tag ids first, so this reads straight down the
    // (tag_id, chat_id, message_id) unique index. Distinct, because one
    // message can match through several tags in a union.
    const params: number[] = [chatId];
    const bind = (value: number): string => {
        params.push(value);
        return `$${params.length}`;
    };

    const first = matchAll ? [tagIds[0]] : tagIds;
    let where = `chat_id = $1 AND tag_id IN (${first.map(bind).join(', ')})`;

    // The intersection is one semi-join per further tag, each reading down the
    // same index.
    if (matchAll) {
        for (const tagId of tagIds.slice(1)) {
            where += ` AND message_id IN (SELECT message_id FROM media_tags WHERE chat_id = $1 AND tag_id = ${bind(tagId)})`;
        }
    }

    // Counted on the first page only: the grid reads the total off page one
    // and never looks again.
    let total: number | null = null;
    if (!offset) {
        const [row] = await conn.select<{ total: number }[]>(
            `SELECT count(DISTINCT message_id) AS total FROM media_tags WHERE ${where}`,
            params,
        );
        total = row?.total ?? 0;
    }

    const oldestFirst = order === 'old';

    if (offset && offset > 0) {
        where += ` AND message_id ${oldestFirst ? '>' : '<'} ${bind(offset)}`;
    }

    const messageIds = (
        await conn.select<{ message_id: number }[]>(
            `SELECT DISTINCT message_id FROM media_tags
             WHERE ${where}
             ORDER BY message_id ${oldestFirst ? 'ASC' : 'DESC'}
             LIMIT ${PAGE}`,
            params,
        )
    ).map((row) => row.message_id);

    return {
        messageIds,
        nextOffset:
            messageIds.length === PAGE
                ? messageIds[messageIds.length - 1]
                : null,
        total,
    };
}

/**
 * Reduce a written tag to its canonical form, or null if nothing valid is
 * left. `#Dog`, `dog` and ` DOG ` are all the same tag, and anything with a
 * space, a URL or punctuation in it is not a tag at all.
 */
export function normaliseTag(name: string): string | null {
    const trimmed = name.trim().replace(/^#/, '').trim().toLowerCase();
    if (trimmed === '' || [...trimmed].length > TAG_MAX_LENGTH) return null;
    return /^[\p{L}\p{N}_-]+$/u.test(trimmed) ? trimmed : null;
}

/**
 * One insert rather than one per item. `INSERT OR IGNORE` leans on the
 * (tag_id, chat_id, message_id) unique key, so re-tagging what is already
 * tagged is a no-op without reading the table first.
 *
 * @returns How many rows were actually new.
 */
async function attachMany(
    tagId: number,
    chatId: number,
    messageIds: number[],
): Promise<number> {
    const ids = uniqueIds(messageIds);
    if (ids.length === 0) return 0;

    // Every placeholder first appears in numeric order: SQLite numbers `$n`
    // parameters by first appearance, so the timestamp is SQL's own rather
    // than a `$3` that would only be read after `$4`.
    const stamp = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;
    const values = ids
        .map((_, i) => `($1, $2, $${i + 3}, ${stamp}, ${stamp})`)
        .join(', ');

    const result = await (await db()).execute(
        `INSERT OR IGNORE INTO media_tags (tag_id, chat_id, message_id, created_at, updated_at)
         VALUES ${values}`,
        [tagId, chatId, ...ids],
    );
    return result.rowsAffected;
}

/** @returns How many rows were removed. */
async function detachMany(
    tagId: number,
    chatId: number,
    messageIds: number[],
): Promise<number> {
    const ids = uniqueIds(messageIds);
    if (ids.length === 0) return 0;

    const result = await (await db()).execute(
        `DELETE FROM media_tags
         WHERE tag_id = $1 AND chat_id = $2
           AND message_id IN (${placeholders(ids.length, 3)})`,
        [tagId, chatId, ...ids],
    );
    return result.rowsAffected;
}

function uniqueIds(ids: number[]): number[] {
    return [...new Set(ids)].filter((id) => Number.isInteger(id) && id > 0);
}
