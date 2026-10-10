import { debug } from '@/lib/debug';
import type { ChatTarget } from '@/lib/telegram/chat-target';
import type { DirectoryListing } from '@/types/directory';

/**
 * Join a public channel by username or marked chat id. Telegram media never
 * touches Laravel — this is the browser's own MTProto session, with t.me as
 * the fallback when we have a url.
 */
export async function joinPublicChannel(
    listing: Pick<DirectoryListing, 'username' | 'chatId' | 'url' | 'handle'>,
): Promise<'ok' | 'request_sent' | 'opened'> {
    const target: ChatTarget | null = listing.username
        ? { kind: 'username', username: listing.username }
        : listing.chatId !== null
          ? { kind: 'id', chatId: listing.chatId }
          : null;
    const peer = listing.username ? `@${listing.username}` : listing.chatId;

    try {
        const { getClient, hasClient } = await import('@/lib/telegram/client');

        if (hasClient() && peer !== null) {
            const result = await getClient().joinChat(peer);

            if (result.status === 'ok') {
                return 'ok';
            }

            if (result.status === 'request_sent') {
                // The board is not where the answer arrives — an admin may take
                // days — so the wait is handed to join-watch, which outlives
                // this page. See lib/telegram/join-watch.
                if (target) {
                    const { watchForJoin } = await import(
                        '@/lib/telegram/join-watch'
                    );
                    watchForJoin(target, listing.handle);
                }

                return 'request_sent';
            }
        }
    } catch (error) {
        debug('directory', 'join failed', error);
    }

    if (listing.url) {
        window.open(listing.url, '_blank', 'noopener,noreferrer');
        return 'opened';
    }

    throw new Error('No Telegram session and no public link to open.');
}
