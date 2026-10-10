import { useEffect, useState } from 'react';

import type { TypingAction } from '@/lib/telegram/message-updates';

/**
 * Telegram repeats a typing action every few seconds while it lasts and
 * promises nothing about a cancel, so a status that has not been renewed in
 * this long is over.
 */
const TYPING_TTL_MS = 6_000;

/**
 * What the other side of this chat is doing right now, in words: "typing…",
 * "recording a voice message…". Null when nobody is.
 *
 * Only live pushes say this, so it needs the live updates the notifier
 * already started; it never asks Telegram for anything itself.
 */
export function useTyping(chatId: number, enabled: boolean): string | null {
    const [action, setAction] = useState<TypingAction | null>(null);

    useEffect(() => {
        setAction(null);
        if (!enabled) return;

        let unsubscribe: (() => void) | null = null;
        let live = true;
        let expiry: ReturnType<typeof setTimeout> | null = null;

        void import('@/lib/telegram/live-updates').then((mod) => {
            if (!live) return;
            mod.startLiveUpdates();
            unsubscribe = mod.subscribeMessageEvents((event) => {
                if (event.chatId !== chatId) return;
                // A message from them ends the typing that wrote it.
                if (event.type === 'new' && !event.outgoing) {
                    if (expiry) clearTimeout(expiry);
                    setAction(null);
                    return;
                }
                if (event.type !== 'typing') return;
                if (expiry) clearTimeout(expiry);
                setAction(event.action);
                if (event.action) {
                    expiry = setTimeout(() => setAction(null), TYPING_TTL_MS);
                }
            });
        });

        return () => {
            live = false;
            if (expiry) clearTimeout(expiry);
            unsubscribe?.();
        };
    }, [chatId, enabled]);

    return action ? describeTyping(action) : null;
}

function describeTyping(action: TypingAction): string {
    switch (action) {
        case 'recording-voice':
            return 'recording a voice message…';
        case 'recording-video':
            return 'recording a video…';
        case 'uploading-photo':
            return 'sending a photo…';
        case 'uploading-video':
            return 'sending a video…';
        case 'uploading-file':
            return 'sending a file…';
        case 'choosing-sticker':
            return 'choosing a sticker…';
        default:
            return 'typing…';
    }
}
