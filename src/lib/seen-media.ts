import { db, now, placeholders } from '@/lib/db';

/**
 * Which media this account has already opened, so the grid can say so and
 * the mark survives a restart.
 *
 * Stored in the local SQLite file next to the tags, and named the same way: a
 * chat id and a message id, never the media. Like the tag chips, it is only
 * ever asked about the items the grid is holding.
 */

/** The query key every seen lookup in a chat starts with. */
export function seenKey(chatId: number) {
    return ['seen-media', chatId] as const;
}

/** The most ids one lookup answers for, as with the tag chips. */
const LOOKUP_LIMIT = 500;

/** Of these message ids, the ones already opened. */
export async function fetchSeenOn(
    chatId: number,
    messageIds: number[],
): Promise<number[]> {
    const ids = [...new Set(messageIds)]
        .filter((id) => Number.isInteger(id) && id > 0)
        .slice(0, LOOKUP_LIMIT);
    if (ids.length === 0) return [];

    const rows = await (await db()).select<{ message_id: number }[]>(
        `SELECT message_id FROM seen_media
         WHERE chat_id = $1 AND message_id IN (${placeholders(ids.length, 2)})`,
        [chatId, ...ids],
    );
    return rows.map((row) => row.message_id);
}

/**
 * Record that an item was opened. The grid's answer is patched at once so the
 * mark is there on the way back out of the viewer; the write itself is a
 * convenience and never breaks viewing.
 */
export async function markMediaSeen(
    chatId: number,
    messageId: number,
): Promise<void> {
    if (!Number.isInteger(messageId) || messageId <= 0) return;

    const { queryClient } = await import('@/router');
    queryClient.setQueriesData<number[]>(
        { queryKey: seenKey(chatId) },
        (seen) =>
            seen && !seen.includes(messageId) ? [...seen, messageId] : seen,
    );

    try {
        await (await db()).execute(
            `INSERT INTO seen_media (chat_id, message_id, seen_at)
             VALUES ($1, $2, $3)
             ON CONFLICT (chat_id, message_id) DO UPDATE SET
                 seen_at = excluded.seen_at`,
            [chatId, messageId, now()],
        );
    } catch {
        // Ignored on purpose.
    }
}
