import { debug } from '@/lib/debug';
import type { MediaItem } from '@/lib/telegram/types';
import type { TaggedRef } from '@/types/tags';

/** Telegram answers at most this many message ids per request. */
const PER_REQUEST = 100;

/**
 * Turn tagged refs from several chats back into media, in the order given.
 *
 * One request per chat (per hundred ids), all at once. A chat that can no
 * longer be read — left, banned, deleted — drops its items rather than failing
 * the rest: the tag outlives the media, and a short page beats an empty one.
 */
export async function loadTaggedRefs(refs: TaggedRef[]): Promise<MediaItem[]> {
    if (refs.length === 0) return [];
    const { loadMediaItems } = await import('@/lib/telegram/media');

    const byChat = new Map<number, number[]>();
    for (const ref of refs) {
        const ids = byChat.get(ref.chatId) ?? [];
        ids.push(ref.messageId);
        byChat.set(ref.chatId, ids);
    }

    const requests: Promise<MediaItem[]>[] = [];
    for (const [chatId, ids] of byChat) {
        for (let start = 0; start < ids.length; start += PER_REQUEST) {
            const chunk = ids.slice(start, start + PER_REQUEST);
            requests.push(
                loadMediaItems(chatId, chunk).catch((error: unknown) => {
                    debug('tags', 'could not load tagged media', chatId, error);
                    return [];
                }),
            );
        }
    }

    const found = new Map<string, MediaItem>();
    for (const items of await Promise.all(requests)) {
        for (const item of items) {
            found.set(`${item.chatId}:${item.messageId}`, item);
        }
    }

    return refs
        .map((ref) => found.get(`${ref.chatId}:${ref.messageId}`))
        .filter((item): item is MediaItem => item !== undefined);
}
