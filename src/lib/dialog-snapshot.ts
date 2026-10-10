import type { DialogItem } from '@/lib/telegram/types';

/**
 * Last launch's chat list, so the rail paints immediately on the next one.
 *
 * Listing dialogs is several Telegram round trips, and the rail used to be a
 * column of skeletons for all of them on every launch. The snapshot is shown
 * as stale data and replaced the moment the real listing answers. Scoped by
 * account so a sign-in as someone else never sees the previous list.
 */
const PREFIX = 'mediagram:dialogs:';

export function readDialogSnapshot(
    accountId: number | undefined,
): DialogItem[] | undefined {
    if (accountId === undefined) return undefined;
    try {
        const raw = localStorage.getItem(PREFIX + accountId);
        return raw ? (JSON.parse(raw) as DialogItem[]) : undefined;
    } catch {
        return undefined;
    }
}

export function writeDialogSnapshot(
    accountId: number | undefined,
    dialogs: DialogItem[],
): void {
    if (accountId === undefined) return;
    try {
        localStorage.setItem(PREFIX + accountId, JSON.stringify(dialogs));
    } catch {
        // Over quota or storage denied: the next launch just waits, as before.
    }
}

export function clearDialogSnapshots(): void {
    try {
        for (const key of Object.keys(localStorage)) {
            if (key.startsWith(PREFIX)) localStorage.removeItem(key);
        }
    } catch {
        // Nothing stored.
    }
}
