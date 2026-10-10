import { TelegramClient } from '@mtcute/web';
import { LogManager } from '@mtcute/web/utils.js';

import type { TelegramCredentials } from '@/lib/telegram/types';

/**
 * The IndexedDB database mtcute keeps the MTProto session in.
 *
 * Named here because signing out has to delete it. mtcute's `logOut()` clears
 * `self` and the non-primary auth keys and stops there — the primary auth key
 * stays on disk — and when the `auth.logOut` call itself fails it clears
 * nothing at all. Either way the next `start()` takes its "already authorized"
 * fast path and signs straight back in as the account that just left, without
 * ever showing a code. Dropping the database is the only teardown that cannot
 * do that.
 */
export const SESSION_STORAGE_NAME = 'mediagram';

/**
 * Set while a sign-out has asked for the session to go and not yet watched it
 * go.
 *
 * `indexedDB.deleteDatabase` blocks for as long as any tab holds the database
 * open, so a second Mediagram tab is enough for the delete to be deferred past
 * the sign-out that asked for it. The marker outlives the tab that failed and
 * `createClient()` finishes the job on the next boot, before it opens a
 * connection of its own.
 */
const PENDING_SIGN_OUT_KEY = 'mediagram:signed-out';

/** Long enough for a delete nobody is blocking; short enough not to be a hang. */
const DELETE_TIMEOUT_MS = 4_000;

let client: TelegramClient | null = null;
let clientKey = '';

export function getClient(): TelegramClient {
    if (!client) {
        throw new Error('Telegram client is not ready');
    }
    return client;
}

export function hasClient(): boolean {
    return client !== null;
}

export async function createClient(
    creds: TelegramCredentials,
): Promise<TelegramClient> {
    const key = `${creds.apiId}:${creds.apiHash}`;
    if (client && clientKey === key) return client;
    await resetClient();

    // A sign-out that could not delete the session — another tab was holding
    // the database — must not be allowed to hand this boot the account it was
    // signing out of. Nothing is connected yet here, so the delete lands.
    if (signOutPending()) {
        await destroySessionStorage();
    }

    clientKey = key;

    client = new TelegramClient({
        apiId: creds.apiId,
        apiHash: creds.apiHash,
        storage: 'mediagram',
        // Updates on, or the chat cannot be live: with them disabled mtcute
        // wraps every call in `invokeWithoutUpdates`, so Telegram never pushes
        // to this session, and drops what arrives anyway. No catch-up on
        // start: the chat reads its own history, so replaying the backlog
        // would only be noise. live-updates.ts starts the loop.
        updates: { catchUp: false },
        logLevel: LogManager.ERROR,
        initConnectionOptions: {
            deviceModel: 'Mediagram',
            systemVersion:
                typeof navigator === 'undefined'
                    ? 'Web'
                    : navigator.platform || 'Web',
            appVersion: '1.0.0',
            langCode: 'en',
            systemLangCode:
                typeof navigator === 'undefined'
                    ? 'en'
                    : navigator.language || 'en',
        },
    });

    return client;
}

export async function resetClient() {
    if (!client) return;
    try {
        await client.destroy();
    } catch {
        // already gone
    }
    client = null;
    clientKey = '';
}

/**
 * Record that this browser is signing out, before anything is torn down.
 *
 * Called first so a sign-out interrupted halfway — a closed tab, a reload, a
 * delete another tab is blocking — still ends the session on the next boot
 * instead of resuming it.
 */
export function beginSignOut(): void {
    try {
        localStorage.setItem(PENDING_SIGN_OUT_KEY, '1');
    } catch {
        // Private mode, or storage denied. The delete below is still tried.
    }
}

function signOutPending(): boolean {
    try {
        return localStorage.getItem(PENDING_SIGN_OUT_KEY) !== null;
    } catch {
        return false;
    }
}

function clearSignOutPending(): void {
    try {
        localStorage.removeItem(PENDING_SIGN_OUT_KEY);
    } catch {
        // Nothing to clear if it could not be written in the first place.
    }
}

/**
 * Delete the stored MTProto session.
 *
 * Resolves either way and never waits indefinitely: a sign-out that hangs is
 * indistinguishable to the user from one that did nothing. The marker is only
 * cleared on a delete we watched succeed, so a blocked one is retried at boot.
 */
export function destroySessionStorage(): Promise<void> {
    if (typeof indexedDB === 'undefined') return Promise.resolve();

    return new Promise((resolve) => {
        let done = false;
        const finish = (deleted: boolean) => {
            if (done) return;
            done = true;
            if (deleted) clearSignOutPending();
            resolve();
        };

        const timer = setTimeout(() => finish(false), DELETE_TIMEOUT_MS);
        const settle = (deleted: boolean) => () => {
            clearTimeout(timer);
            finish(deleted);
        };

        const request = indexedDB.deleteDatabase(SESSION_STORAGE_NAME);
        request.onsuccess = settle(true);
        request.onerror = settle(false);
        // Another tab still has it open. The browser will delete it once that
        // tab lets go; until we have seen that, the marker stands.
        request.onblocked = settle(false);
    });
}
