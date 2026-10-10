import type { TelegramClient, User } from '@mtcute/web';

import { blobCache } from '@/lib/blob-cache';
import { clearDialogSnapshots } from '@/lib/dialog-snapshot';
import { clearStorySnapshots } from '@/lib/story-snapshot';
import { clearThumbs } from '@/lib/thumb-store';
import {
    beginSignOut,
    createClient,
    destroySessionStorage,
    getClient,
    hasClient,
    resetClient,
} from '@/lib/telegram/client';
import { describeTelegramError, isAbortError } from '@/lib/telegram/errors';
import { stopAllJoinWatches } from '@/lib/telegram/join-watch';
import { clearMediaCaches } from '@/lib/telegram/media';
import { clearReactionCaches } from '@/lib/telegram/thread';
import type { AccountUser, TelegramCredentials } from '@/lib/telegram/types';

export type SessionHooks = {
    onQr: (url: string, expires: Date) => void;
    /** The code was read and Telegram is finishing the sign-in. */
    onQrScanned: () => void;
    onPassword: (hint: string | null) => Promise<string>;
    onInvalidPassword: () => void;
    onInvalidCode: () => void;
    onPhone: () => Promise<string>;
    onCode: () => Promise<string>;
    onCodeSent: () => void;
};

export function toAccountUser(user: User): AccountUser {
    return {
        id: user.id,
        name: user.displayName,
        username: user.username,
    };
}

/**
 * Watch for the moment Telegram says the code was read.
 *
 * mtcute's `signInQr` takes an `onQrScanned` callback, but `start()` — which we
 * use for its "already authorized" fast path — does not forward it. The update
 * it fires on is on the client either way (`onServerUpdate` is wired straight
 * from the MTProto connection and survives `disableUpdates`, which only turns
 * off the updates *manager*), so we listen for it ourselves.
 *
 * Without this the screen holds a code that has already been scanned until
 * Telegram finishes, which is up to the token's whole lifetime — the dead air
 * that made a working scan look like a broken one.
 */
function watchForScan(tg: TelegramClient, onScanned: () => void): () => void {
    const handle = (update: { _: string; update?: { _: string } }) => {
        if (
            update._ === 'updateShort' &&
            update.update?._ === 'updateLoginToken'
        ) {
            onScanned();
        }
    };

    tg.onServerUpdate.add(handle);
    return () => tg.onServerUpdate.remove(handle);
}

/**
 * Where the signed-in account's display fields are kept between launches.
 *
 * mtcute's own record of the current user (`storage.self`) holds the id and
 * usernames but not the display name, and the user menu wants all three
 * before the first network call has had a chance to answer.
 */
const ACCOUNT_KEY = 'mediagram:account';

function rememberAccount(account: AccountUser): void {
    try {
        localStorage.setItem(ACCOUNT_KEY, JSON.stringify(account));
    } catch {
        // Private mode: the next launch just shows the id-only fallback.
    }
}

function recalledAccount(id: number): AccountUser | null {
    try {
        const raw = localStorage.getItem(ACCOUNT_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as AccountUser;
        return parsed.id === id ? parsed : null;
    } catch {
        return null;
    }
}

function forgetAccount(): void {
    try {
        localStorage.removeItem(ACCOUNT_KEY);
    } catch {
        // Nothing stored to forget.
    }
}

/**
 * The account this browser was signed in as, read off disk, or null when it
 * has never signed in (or signed out since).
 *
 * This is the launch fast path. `start()` answers the same question with a
 * `users.getSelf` round trip — open a socket, handshake, wait — and every
 * launch used to sit on the boot screen for it. The session on disk already
 * says who we are; the network only confirms it, and `verifySession()` does
 * that in the background. Every RPC connects on its own the first time it is
 * made, so nothing has to wait for the confirmation to start working.
 */
export async function restoreSession(
    creds: TelegramCredentials,
): Promise<AccountUser | null> {
    const tg = await createClient(creds);
    await tg.prepare();
    const self = await tg.storage.self.fetch();
    if (!self || self.isBot) return null;

    return (
        recalledAccount(self.userId) ?? {
            id: self.userId,
            name: self.usernames[0] ?? '',
            username: self.usernames[0] ?? null,
        }
    );
}

/**
 * Confirm a restored session with Telegram, and refresh the account's display
 * fields while at it. Throws what `getMe()` throws, so the caller can tell a
 * revoked session apart from a dropped connection.
 */
export async function verifySession(): Promise<AccountUser> {
    const tg = getClient();
    const me = await tg.getMe();
    await tg.notifyLoggedIn(me.raw);
    const account = toAccountUser(me);
    rememberAccount(account);
    return account;
}

export async function loginWithQr(
    creds: TelegramCredentials,
    hooks: SessionHooks,
    signal: AbortSignal,
) {
    const tg = await createClient(creds);
    const stopWatching = watchForScan(tg, hooks.onQrScanned);
    try {
        const account = await signInWithQr(tg, hooks, signal);
        rememberAccount(account);
        return account;
    } finally {
        stopWatching();
    }
}

async function signInWithQr(
    tg: TelegramClient,
    hooks: SessionHooks,
    signal: AbortSignal,
) {
    const me = await tg.start({
        qrCodeHandler: hooks.onQr,
        password: async () => {
            const hint = await tg.getPasswordHint().catch(() => null);
            return hooks.onPassword(hint);
        },
        invalidCodeCallback: (type) => {
            if (type === 'password') hooks.onInvalidPassword();
            if (type === 'code') hooks.onInvalidCode();
        },
        abortSignal: signal,
    });
    return toAccountUser(me);
}

export async function loginWithPhone(
    creds: TelegramCredentials,
    hooks: SessionHooks,
    signal: AbortSignal,
) {
    const tg = await createClient(creds);
    const me = await tg.start({
        phone: () => hooks.onPhone(),
        code: () => hooks.onCode(),
        password: async () => {
            const hint = await tg.getPasswordHint().catch(() => null);
            return hooks.onPassword(hint);
        },
        codeSentCallback: () => {
            hooks.onCodeSent();
        },
        invalidCodeCallback: (type) => {
            if (type === 'password') hooks.onInvalidPassword();
            if (type === 'code') hooks.onInvalidCode();
        },
        abortSignal: signal,
    });
    const account = toAccountUser(me);
    rememberAccount(account);
    return account;
}

/**
 * How long to give Telegram to acknowledge the sign-out before going ahead
 * without it. There is no answer it can give that changes what happens next.
 */
const REMOTE_LOGOUT_TIMEOUT_MS = 4_000;

/**
 * End the Telegram half of the session.
 *
 * Telling Telegram to drop the session is the polite half and it is best
 * effort. The half that decides who the *next* login is happens locally, and
 * it used to be the half that could be skipped: `logOut()` clears nothing on
 * disk when its call throws, and even when it succeeds it leaves the primary
 * auth key behind — so a browser that had "logged out" came back up as the
 * same account, with no code to scan and nothing to re-link. The local
 * teardown now runs whatever the network did, and it deletes the session
 * rather than tidying it.
 *
 * `tellTelegram` is false when Telegram is the side that ended the session
 * (Settings → Devices). The auth key is already dead, so `logOut()` can only
 * spend the timeout failing, and everything that matters is local anyway.
 */
export async function logout({
    tellTelegram = true,
}: {
    tellTelegram?: boolean;
} = {}) {
    // Recorded before anything is torn down, so a sign-out that is interrupted
    // still finishes on the next boot. See client.ts.
    beginSignOut();
    forgetAccount();
    clearDialogSnapshots();
    clearStorySnapshots();

    if (tellTelegram && hasClient()) {
        try {
            await withTimeout(getClient().logOut(), REMOTE_LOGOUT_TIMEOUT_MS);
        } catch (error) {
            if (!isAbortError(error)) {
                console.warn(describeTelegramError(error));
            }
        }
    }

    await resetClient();
    await destroySessionStorage();

    stopAllJoinWatches();
    // Imported here rather than at the top so an account that never exports
    // or uploads never loads either runner. The next account has nothing of
    // this one's left to finish.
    await import('@/lib/export/run').then((mod) => mod.stopAllExports());
    await import('@/lib/upload/send').then((mod) => mod.stopAllUploads());
    clearMediaCaches();
    clearReactionCaches();
    blobCache.clear();
    await clearThumbs();
}

/**
 * Resolve when `work` does, or when `ms` has passed — whichever comes first.
 *
 * A late rejection is still handled by the race, so it cannot surface as an
 * unhandled rejection after we have stopped waiting.
 */
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | void> {
    return Promise.race([
        work,
        new Promise<void>((resolve) => setTimeout(resolve, ms)),
    ]);
}
