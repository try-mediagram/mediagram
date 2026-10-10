import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { toast } from 'sonner';

import { debug } from '@/lib/debug';
import { playSound } from '@/lib/notify-sound';
import type { DialogItem } from '@/lib/telegram/types';
import { useTelegram } from '@/providers/telegram-provider';

/**
 * Says a message arrived, wherever the reader is in the app.
 *
 * Mounted once beside the other watchers, so it outlives navigation the way
 * the connection does. A message in the chat being read — open, with the
 * window focused — gets only the soft cue: the stream already shows it.
 * Anywhere else it gets the brighter cue and a toast that opens the chat. A
 * muted chat or Telegram's silent flag keeps the toast but drops the sound.
 * Archived chats and this account's own messages say nothing, and the
 * library's unread counts are refreshed either way.
 */
export function MessageNotifier() {
    const { status } = useTelegram();
    const queryClient = useQueryClient();
    const navigate = useNavigate();

    useEffect(() => {
        if (status !== 'ready') return;

        let unsubscribe: (() => void) | null = null;
        let live = true;
        // Unread counts move in bursts; one refresh per burst is plenty.
        let refreshTimer: ReturnType<typeof setTimeout> | null = null;

        void import('@/lib/telegram/live-updates').then((mod) => {
            if (!live) return;
            mod.startLiveUpdates();
            unsubscribe = mod.subscribeMessageEvents((event) => {
                if (event.type !== 'new') return;

                if (refreshTimer) clearTimeout(refreshTimer);
                refreshTimer = setTimeout(() => {
                    void queryClient.invalidateQueries({
                        queryKey: ['dialogs'],
                    });
                }, 1_500);

                if (event.outgoing) return;

                const dialog = findDialog(queryClient, event.chatId);
                // Archived is Telegram's "out of the way": no toast, no sound.
                if (dialog?.isArchived) {
                    debug('notify', 'archived, skipped', event.chatId);
                    return;
                }
                const quiet =
                    event.silent ||
                    (dialog?.isMuted === true && !event.mentioned);
                // The focus guard: the chat is open and the window has focus,
                // so the message is already in front of the reader. A chat
                // left open behind another app still notifies.
                const reading =
                    mod.getActiveChat() === event.chatId &&
                    document.visibilityState === 'visible' &&
                    document.hasFocus();

                debug('notify', 'incoming', {
                    chatId: event.chatId,
                    known: Boolean(dialog),
                    quiet,
                    reading,
                });

                if (reading) {
                    if (!quiet) playSound('incoming');
                    return;
                }

                if (!quiet) playSound('background');
                toast(dialog?.title ?? 'New message', {
                    id: `message:${event.chatId}`,
                    description: preview(event.text),
                    action: {
                        label: 'Open',
                        onClick: () =>
                            void navigate({
                                to: '/c/$chatId',
                                params: { chatId: String(event.chatId) },
                            }),
                    },
                });
            });
        });

        return () => {
            live = false;
            if (refreshTimer) clearTimeout(refreshTimer);
            unsubscribe?.();
            void import('@/lib/telegram/live-updates').then((mod) =>
                mod.stopLiveUpdates(),
            );
        };
    }, [navigate, queryClient, status]);

    return null;
}

function findDialog(
    queryClient: ReturnType<typeof useQueryClient>,
    chatId: number,
): DialogItem | undefined {
    const one = queryClient.getQueryData<DialogItem>(['dialog', chatId]);
    if (one) return one;
    return queryClient
        .getQueryData<DialogItem[]>(['dialogs'])
        ?.find((dialog) => dialog.id === chatId);
}

function preview(text: string): string {
    const flat = text.replace(/\s+/g, ' ').trim();
    if (!flat) return 'Sent media';
    return flat.length > 120 ? `${flat.slice(0, 117)}…` : flat;
}
