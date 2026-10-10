import { debug } from '@/lib/debug';
import type { ChatTarget } from '@/lib/telegram/chat-target';
import { getClient, hasClient } from '@/lib/telegram/client';
import { isChatGoneError } from '@/lib/telegram/errors';
import { mentionsJoin } from '@/lib/telegram/join-updates';
import { resolveChatTarget } from '@/lib/telegram/resolve';

/**
 * Waiting for an admin to say yes.
 *
 * A chat that approves members by hand answers `joinChat` with "request sent"
 * and then says nothing: the account is let in minutes or days later, on
 * somebody else's schedule, and until now the only way to find out was to paste
 * the link again. So the request is remembered and Telegram is asked back.
 *
 * Asked, rather than only listened to, because a push can be missed — a
 * sleeping laptop, a dropped socket. Raw updates on `onServerUpdate` are used
 * for what they are good for here: a nudge to check now instead of at the
 * next tick. The poll is
 * what makes the answer certain; the nudge is what makes it quick.
 *
 * The watches live in this module rather than in a component because an Inertia
 * visit unmounts the screen the request was made from, and the answer must
 * outlive it. `subscribeJoinAccepted` hands over anything that landed while
 * nothing was listening.
 */

export type JoinAccepted = {
    chatId: number;
    title: string;
};

/**
 * When to ask again, in seconds, from the moment the request went in. Close
 * together at first — an admin who is looking answers in seconds — then far
 * apart, because after half an hour of nothing this is no longer a thing the
 * reader is waiting on. Roughly 30 minutes in all.
 */
const SCHEDULE = [5, 10, 20, 30, 60, 120, 180, 300, 300, 600];

/** How long a nudge waits before checking, so a burst of updates is one check. */
const NUDGE_DELAY = 1_000;

type Watch = {
    target: ChatTarget;
    title: string;
    attempt: number;
    timer: ReturnType<typeof setTimeout> | null;
    checking: boolean;
};

const watches = new Map<string, Watch>();
const listeners = new Set<(accepted: JoinAccepted) => void>();
/** Answers that landed with nothing on screen to say them. */
const undelivered: JoinAccepted[] = [];

let nudgeTimer: ReturnType<typeof setTimeout> | null = null;
let updateHandler: ((update: unknown) => void) | null = null;

function keyOf(target: ChatTarget): string {
    if (target.kind === 'invite') return `invite:${target.hash}`;
    if (target.kind === 'username') return `username:${target.username}`;
    return `id:${target.chatId}`;
}

/**
 * Start waiting on a chat this account has asked to join.
 *
 * Safe to call twice for the same chat — the second call is the same wait.
 */
export function watchForJoin(target: ChatTarget, title: string): void {
    if (!hasClient()) return;

    const key = keyOf(target);
    if (watches.has(key)) return;

    const watch: Watch = {
        target,
        title,
        attempt: 0,
        timer: null,
        checking: false,
    };
    watches.set(key, watch);
    debug('join', 'watching for approval', key);

    schedule(key, watch);
    listenForUpdates();
}

export function subscribeJoinAccepted(
    listener: (accepted: JoinAccepted) => void,
): () => void {
    listeners.add(listener);

    // Anything that was approved while no screen was mounted is still news.
    while (undelivered.length > 0) {
        const accepted = undelivered.shift();
        if (accepted) listener(accepted);
    }

    return () => {
        listeners.delete(listener);
    };
}

/**
 * Drop every wait, because the account that was waiting is gone. Called from
 * `logout()` — the next account has not asked anybody for anything.
 */
export function stopAllJoinWatches() {
    for (const watch of watches.values()) {
        if (watch.timer) clearTimeout(watch.timer);
    }

    watches.clear();
    undelivered.length = 0;
    stopListeningForUpdates();
}

function schedule(key: string, watch: Watch) {
    const delay = SCHEDULE[watch.attempt];

    if (delay === undefined) {
        debug('join', 'gave up waiting for approval', key);
        stop(key);
        return;
    }

    watch.attempt += 1;
    watch.timer = setTimeout(() => {
        watch.timer = null;
        void check(key, watch);
    }, delay * 1_000);
}

async function check(key: string, watch: Watch) {
    if (watch.checking || !watches.has(key)) return;

    if (!hasClient()) {
        schedule(key, watch);
        return;
    }

    watch.checking = true;

    try {
        const resolved = await resolveChatTarget(watch.target);

        if (resolved.joined && resolved.chatId !== null) {
            debug('join', 'approved', key);
            stop(key);
            deliver({
                chatId: resolved.chatId,
                title: resolved.title || watch.title,
            });
            return;
        }
    } catch (error) {
        // A link that has been revoked, or a chat that is gone, is an answer:
        // there is nothing left to wait for. Anything else is worth retrying —
        // a dropped connection must not end the wait.
        if (isChatGoneError(error)) {
            debug('join', 'stopped waiting', key, error);
            stop(key);
            return;
        }
        debug('join', 'check failed, will retry', key, error);
    } finally {
        watch.checking = false;
    }

    if (watches.has(key)) schedule(key, watch);
}

function deliver(accepted: JoinAccepted) {
    if (listeners.size === 0) {
        undelivered.push(accepted);
        return;
    }
    for (const listener of listeners) listener(accepted);
}

function stop(key: string) {
    const watch = watches.get(key);
    if (watch?.timer) clearTimeout(watch.timer);
    watches.delete(key);

    if (watches.size === 0) stopListeningForUpdates();
}

function listenForUpdates() {
    if (updateHandler || !hasClient()) return;

    updateHandler = (update: unknown) => {
        if (!mentionsJoin(update)) return;
        if (nudgeTimer) return;

        nudgeTimer = setTimeout(() => {
            nudgeTimer = null;
            for (const [key, watch] of watches) void check(key, watch);
        }, NUDGE_DELAY);
    };

    getClient().onServerUpdate.add(updateHandler);
}

function stopListeningForUpdates() {
    if (nudgeTimer) {
        clearTimeout(nudgeTimer);
        nudgeTimer = null;
    }

    if (!updateHandler) return;

    if (hasClient()) getClient().onServerUpdate.remove(updateHandler);
    updateHandler = null;
}
