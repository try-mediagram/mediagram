import { touchLru } from '@/lib/lru-index';
import type { StoryPeer } from '@/lib/telegram/stories';

/**
 * What the stories UI knew last time, so it paints before Telegram answers.
 *
 * Same idea as `dialog-snapshot.ts`: the lists are shown as stale data and
 * replaced the moment the real fetch lands, and they are scoped by account so
 * a different sign-in never sees the previous one's. The pinned-check memory
 * and the full-file index live here too, under the same prefix, so signing
 * out clears all of it in one sweep.
 */
const PREFIX = 'mediagram:stories:';

/** How long a chat's "has pinned stories or not" answer is trusted. */
export const PINNED_CHECK_TTL_MS = 30 * 60_000;

/** Full story files kept on disk; the oldest is dropped past this. */
const FULL_KEEP = 40;

function read<T>(key: string): T | undefined {
    try {
        const raw = localStorage.getItem(PREFIX + key);
        return raw ? (JSON.parse(raw) as T) : undefined;
    } catch {
        return undefined;
    }
}

function write(key: string, value: unknown): void {
    try {
        localStorage.setItem(PREFIX + key, JSON.stringify(value));
    } catch {
        // Full or private mode: next launch just waits on Telegram.
    }
}

export function readStorySnapshot<T>(
    accountId: number | undefined,
    name: string,
): T | undefined {
    if (accountId === undefined) return undefined;
    return read<T>(`${accountId}:${name}`);
}

export function writeStorySnapshot(
    accountId: number | undefined,
    name: string,
    data: unknown,
): void {
    if (accountId === undefined) return;
    write(`${accountId}:${name}`, data);
}

/** A chat's last pinned-stories answer: its ring, or null for none. */
export type PinnedCheck = { at: number; peer: StoryPeer | null };

export function readPinnedChecks(): Record<string, PinnedCheck> {
    return read<Record<string, PinnedCheck>>('pinned-checks') ?? {};
}

export function writePinnedChecks(checks: Record<string, PinnedCheck>): void {
    write('pinned-checks', checks);
}

/**
 * Note that a full story file was just used, and return the keys that fell
 * off the end — the caller deletes those from disk.
 */
export function touchFullStory(key: string): string[] {
    const { index, evicted } = touchLru(
        read<string[]>('full-index') ?? [],
        key,
        FULL_KEEP,
    );
    write('full-index', index);
    return evicted;
}

export function clearStorySnapshots(): void {
    try {
        for (const key of Object.keys(localStorage)) {
            if (key.startsWith(PREFIX)) localStorage.removeItem(key);
        }
    } catch {
        // Nothing to clear.
    }
}
