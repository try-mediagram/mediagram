import { useSyncExternalStore } from 'react';

import type { MediaItem } from '@/lib/telegram/types';

/**
 * The in-app picture in picture: one video kept playing in a corner of the
 * window while the rest of the app is browsed.
 *
 * Deliberately not the browser's own `requestPictureInPicture`, which tears
 * the video out into a separate OS window that the desktop app does not
 * control and that does not follow it between spaces. Here the corner player
 * is part of the page: mounted once by the app shell, so it survives route
 * changes, and handed the place the viewer was at.
 */
export type PipState = {
    item: MediaItem;
    /** Where playback was when it was handed over, in seconds. */
    startAt: number;
    volume: number;
    muted: boolean;
    rate: number;
    /**
     * Whether it was playing. A paused video stays paused in the corner and
     * back in the viewer; only one that was already playing carries on.
     */
    playing: boolean;
};

let state: PipState | null = null;
const subscribers = new Set<() => void>();

function emit() {
    for (const notify of subscribers) notify();
}

export function openPip(next: PipState): void {
    state = next;
    emit();
}

export function closePip(): void {
    if (state === null) return;
    state = null;
    emit();
}

export function getPip(): PipState | null {
    return state;
}

export function usePip(): PipState | null {
    return useSyncExternalStore(
        (notify) => {
            subscribers.add(notify);
            return () => subscribers.delete(notify);
        },
        getPip,
        getPip,
    );
}
