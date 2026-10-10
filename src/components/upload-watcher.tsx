import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { toast } from 'sonner';

import { formatBytes } from '@/lib/format';
import type { UploadState } from '@/lib/upload/send';

const TOAST_ID = 'mediagram-upload';

/**
 * Says how a bulk send is going, wherever the reader has gone.
 *
 * Thirty videos outlive the screen they were picked on, so the sending lives
 * in `lib/upload/send` and this only listens — the same split `JoinWatcher`
 * and `ExportWatcher` use, and it sits beside them in `AppShell` for the same
 * reason.
 *
 * It also refreshes the chat once the files land. Nothing tells the grid that
 * the account has just added to the chat it is showing: the session runs with
 * `disableUpdates`, so without this the media you just sent is missing until
 * something else happens to refetch. The tag queries go with it — a run that
 * tagged what it sent has changed the chat's vocabulary and its chips too.
 */
export function UploadWatcher() {
    const queryClient = useQueryClient();
    const running = useRef(false);

    useEffect(() => {
        let live = true;
        let unsubscribe: (() => void) | null = null;

        void import('@/lib/upload/send').then((mod) => {
            if (!live) return;
            unsubscribe = mod.subscribeUpload((state) => {
                report(state, running, {
                    cancel: () => mod.cancelUpload(),
                    dismiss: () => mod.dismissUpload(),
                    refresh: (chatId) => {
                        void queryClient.invalidateQueries({
                            queryKey: ['media', chatId],
                        });
                        void queryClient.invalidateQueries({
                            queryKey: ['chat-history', chatId],
                        });
                        // Prefix match, so both the vocabulary and the chip
                        // lookups for this chat are refetched.
                        void queryClient.invalidateQueries({
                            queryKey: ['media-tags', chatId],
                        });
                    },
                });
            });
        });

        return () => {
            live = false;
            unsubscribe?.();
        };
    }, [queryClient]);

    return null;
}

function report(
    state: UploadState | null,
    running: { current: boolean },
    actions: {
        cancel: () => void;
        dismiss: () => void;
        refresh: (chatId: number) => void;
    },
) {
    if (!state) {
        if (running.current) {
            toast.dismiss(TOAST_ID);
            running.current = false;
        }
        return;
    }

    if (state.phase === 'sending') {
        running.current = true;
        toast.loading(describe(state), {
            id: TOAST_ID,
            duration: Infinity,
            description: state.label ?? undefined,
            action: { label: 'Cancel', onClick: actions.cancel },
        });
        return;
    }

    // Everything is already in the chat by now, so there is nothing left to
    // cancel — the toast keeps its place but drops the button.
    if (state.phase === 'tagging') {
        running.current = true;
        toast.loading('Tagging what was sent…', {
            id: TOAST_ID,
            duration: Infinity,
        });
        return;
    }

    running.current = false;
    toast.dismiss(TOAST_ID);

    // Anything that landed is in the chat, however the run ended — so the
    // grid is refreshed for a cancelled send too, not just a clean one.
    if (state.done > 0) actions.refresh(state.chatId);

    if (state.phase === 'cancelled') {
        const sent = `${state.done.toLocaleString()} of ${state.total.toLocaleString()} messages had already been sent`;
        toast.message('Sending stopped', {
            description: state.tagged > 0 ? `${sent}, and tagged.` : `${sent}.`,
        });
        actions.dismiss();
        return;
    }

    if (state.phase === 'failed') {
        toast.error('Could not send', {
            description: state.error ?? undefined,
            duration: 15_000,
        });
        actions.dismiss();
        return;
    }

    if (state.failed > 0 && state.done === 0) {
        toast.error(`Nothing was sent to ${state.chatTitle}`, {
            description:
                'Telegram refused every message. You may not be allowed to post here.',
            duration: 15_000,
        });
        actions.dismiss();
        return;
    }

    const parts = [`${state.done.toLocaleString()} sent`];
    if (state.totalBytes > 0) parts.push(formatBytes(state.totalBytes));
    if (state.failed > 0) {
        parts.push(`${state.failed.toLocaleString()} refused`);
    }
    if (state.tagged > 0) {
        parts.push(`${state.tagged.toLocaleString()} tagged`);
    }

    toast.success(`Sent to ${state.chatTitle}`, {
        description: parts.join(' · '),
        duration: 10_000,
    });

    // Its own toast, not a line in the success one: the files really did land,
    // and the reader can still tag them from the grid.
    if (state.tagError) {
        toast.error('Sent, but not tagged', {
            description: state.tagError,
            duration: 15_000,
        });
    }

    actions.dismiss();
}

/**
 * What the toast says. User-facing only — the mechanics go to
 * `debug('upload', …)` in the runner, readable under `?debug=1`.
 */
function describe(state: UploadState): string {
    if (state.waiting !== null) return 'Waiting for Telegram…';

    const sent = `${state.done.toLocaleString()} of ${state.total.toLocaleString()}`;
    if (state.totalBytes > 0) {
        return `Sending ${sent} — ${formatBytes(state.bytes)} of ${formatBytes(state.totalBytes)}`;
    }
    return `Sending ${sent}`;
}
