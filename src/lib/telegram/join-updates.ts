/**
 * Reading a raw Telegram update for "your standing in some chat changed".
 *
 * Split out and importing nothing so it can be read under `node --test`
 * without a session, the way chat-target.ts is — the shapes below are what the
 * wire actually sends, and getting them wrong is silent.
 *
 * None of these updates is trusted to *name* the chat. Under `disableUpdates`
 * there is no updates manager to keep the peer index honest, so an update here
 * only brings the next check forward; `join-watch` is what decides.
 */

const JOIN_UPDATES = new Set([
    'updateChannel',
    'updateChannelParticipant',
    'updateChatParticipant',
    'updateChatParticipantAdd',
    'updateChatParticipants',
    'updateNewChannelMessage',
    'updateNewMessage',
    'updatePendingJoinRequests',
]);

/**
 * Telegram wraps updates in a handful of containers — `updateShort` holds one,
 * `updates` and `updatesCombined` hold a list — so the interesting one is
 * usually a level or two down from what the connection hands over.
 */
export function mentionsJoin(update: unknown): boolean {
    if (typeof update !== 'object' || update === null) return false;

    const container = update as {
        _?: string;
        update?: unknown;
        updates?: unknown[];
    };

    if (container._ !== undefined && JOIN_UPDATES.has(container._)) return true;
    if (container.update !== undefined && mentionsJoin(container.update)) {
        return true;
    }

    return (container.updates ?? []).some((item) => mentionsJoin(item));
}
