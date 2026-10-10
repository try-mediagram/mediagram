import { debug } from '@/lib/debug';
import { getClient, hasClient } from '@/lib/telegram/client';
import {
    type MessageEvent,
    messageEventsFrom,
} from '@/lib/telegram/message-updates';

/**
 * One fan-out for every message event the connection hears.
 *
 * Every raw push arrives on `onServerUpdate`, and that is enough for a chat:
 * it says which chat moved and the chat fetches the message itself. One
 * handler is attached per client; any number of screens listen to it here.
 */

type Listener = (event: MessageEvent) => void;

const listeners = new Set<Listener>();
let attachedTo: unknown = null;
let detach: (() => void) | null = null;

function dispatch(updates: unknown) {
    const events = messageEventsFrom(updates);
    for (const event of events) {
        if (event.type !== 'typing') debug('live', event.type, event);
        for (const listener of listeners) {
            try {
                listener(event);
            } catch (error) {
                debug('live', 'listener failed', error);
            }
        }
    }
}

/**
 * Hook the live client up, once.
 *
 * Telegram only pushes to a session that is following along. mtcute's updates
 * loop is what says so (it reads `updates.getState`) and keeps the session
 * alive afterwards, so it is started here; starting it twice is a no-op.
 */
export function startLiveUpdates(): void {
    if (!hasClient()) return;
    const client = getClient();
    if (attachedTo === client) return;

    stopLiveUpdates();
    const handler = (updates: unknown) => dispatch(updates);
    client.onServerUpdate.add(handler);
    attachedTo = client;
    detach = () => client.onServerUpdate.remove(handler);

    void client.startUpdatesLoop().catch((error: unknown) => {
        debug('live', 'updates loop failed to start', error);
    });
}

export function stopLiveUpdates(): void {
    detach?.();
    detach = null;
    attachedTo = null;
}

export function subscribeMessageEvents(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

export type { MessageEvent };

/**
 * The chat the reader has open, so a message landing there gets the quiet
 * in-chat cue instead of the louder "elsewhere" one and its toast.
 */
let activeChat: number | null = null;

export function setActiveChat(chatId: number | null): void {
    activeChat = chatId;
}

export function getActiveChat(): number | null {
    return activeChat;
}
