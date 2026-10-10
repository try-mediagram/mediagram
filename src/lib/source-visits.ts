import { db } from '@/lib/db';
import type { DialogItem } from '@/lib/telegram/types';
import type { SourceMap } from '@/types/mediagram';

/**
 * Tracks which chats have been opened and how far each has been read, so the
 * "new media" badges survive a restart.
 */

const NEW_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

/** The query key every read of the read markers shares. */
export const SOURCES_KEY = ['sources'] as const;

/** chat id => highest message id already seen. */
export async function fetchSources(): Promise<SourceMap> {
    const rows = await (await db()).select<
        { chat_id: number; last_seen_message_id: number }[]
    >('SELECT chat_id, last_seen_message_id FROM sources');

    const sources: SourceMap = {};
    for (const row of rows) {
        sources[String(row.chat_id)] = row.last_seen_message_id;
    }
    return sources;
}

/**
 * Record a visit. The read marker only ever moves forward. Tracking is a
 * convenience; it never breaks browsing.
 */
export async function markSourceVisited(
    chatId: number,
    messageId: number,
): Promise<void> {
    try {
        const stamp = new Date().toISOString();
        await (await db()).execute(
            `INSERT INTO sources (chat_id, last_seen_message_id, created_at, updated_at)
             VALUES ($1, $2, $3, $3)
             ON CONFLICT (chat_id) DO UPDATE SET
                 last_seen_message_id = max(last_seen_message_id, excluded.last_seen_message_id),
                 updated_at = excluded.updated_at`,
            [chatId, Math.max(0, messageId), stamp],
        );

        const { queryClient } = await import('@/router');
        void queryClient.invalidateQueries({ queryKey: SOURCES_KEY });
    } catch {
        // Ignored on purpose.
    }
}

export function sourceHasNewMedia(
    dialog: DialogItem,
    sources: SourceMap,
): boolean {
    if (!dialog.lastMediaId || !dialog.lastMediaAt) return false;
    const seen = sources[String(dialog.id)];
    if (seen === undefined) {
        if (dialog.unreadCount > 0) return true;
        const age = Date.now() - new Date(dialog.lastMediaAt).getTime();
        return Number.isFinite(age) && age >= 0 && age < NEW_WINDOW_MS;
    }
    return dialog.lastMediaId > seen;
}
