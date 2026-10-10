import { useEffect, useRef } from 'react';
import { toast } from 'sonner';

import { formatBytes } from '@/lib/format';
import type { ExportState } from '@/lib/export/run';

const TOAST_ID = 'mediagram-export';

/**
 * Says how an export is going, wherever the reader has gone.
 *
 * An export of a whole history outlives the screen it was started from, so the
 * run itself lives in `lib/export/run` and this only listens — the same split
 * `JoinWatcher` uses, and it sits beside it in `AppShell` for the same reason.
 *
 * It reports through a toast rather than a bar in the shell deliberately: the
 * app screens are `h-dvh` flex columns with their own scroller, and a row
 * added above them pushes the column past the viewport. See `LinkStatusBar`.
 */
export function ExportWatcher() {
    // Sonner is told to update an existing toast by id, so the last phase
    // rendered is worth remembering: a finished run must dismiss the progress
    // toast rather than leave it standing at 99%.
    const running = useRef(false);

    useEffect(() => {
        let live = true;
        let unsubscribe: (() => void) | null = null;

        void import('@/lib/export/run').then((mod) => {
            if (!live) return;
            unsubscribe = mod.subscribeExport((state) => {
                report(
                    state,
                    running,
                    () => mod.cancelExport(),
                    () => mod.dismissExport(),
                );
            });
        });

        return () => {
            live = false;
            unsubscribe?.();
        };
    }, []);

    return null;
}

function report(
    state: ExportState | null,
    running: { current: boolean },
    cancel: () => void,
    dismiss: () => void,
) {
    if (!state) {
        if (running.current) {
            toast.dismiss(TOAST_ID);
            running.current = false;
        }
        return;
    }

    if (state.phase === 'downloading' || state.phase === 'writing') {
        running.current = true;
        toast.loading(describeProgress(state), {
            id: TOAST_ID,
            duration: Infinity,
            description: state.label,
            action: { label: 'Cancel', onClick: cancel },
        });
        return;
    }

    running.current = false;
    toast.dismiss(TOAST_ID);

    if (state.phase === 'cancelled') {
        toast.message('Export stopped', {
            description: `${state.written.toLocaleString()} files were already saved to ${state.label}.`,
        });
        dismiss();
        return;
    }

    if (state.phase === 'failed') {
        toast.error('Export failed', {
            description: state.error ?? undefined,
            duration: 15_000,
        });
        dismiss();
        return;
    }

    const parts = [`Saved to ${state.label}`];
    if (state.written > 0) {
        parts.push(
            `${state.written.toLocaleString()} files, ${formatBytes(state.bytes)}`,
        );
    }
    if (state.failed > 0) {
        // Named rather than buried: a reader who does not know some are
        // missing will not go looking. Only point at the transcript when one
        // was actually written — a media-only run has no such file.
        parts.push(
            state.hasTranscript
                ? `${state.failed.toLocaleString()} could not be downloaded — see the transcript.`
                : `${state.failed.toLocaleString()} could not be downloaded.`,
        );
    }

    toast.success(`Exported ${state.chatTitle}`, {
        description: parts.join(' · '),
        duration: 15_000,
    });
    dismiss();
}

/**
 * What the toast says. User-facing only — the mechanics (how many seconds
 * Telegram asked for, which file failed and why) go to `debug('export', …)`
 * in the runner, where they can be read under `?debug=1` without putting a
 * rate-limit explanation in front of someone who just wants their files.
 */
function describeProgress(state: ExportState): string {
    if (state.waiting !== null) return 'Waiting for Telegram…';

    if (state.phase === 'writing') return 'Writing the transcript…';

    if (state.total === 0) return 'Exporting…';

    return `Exporting ${state.done.toLocaleString()} of ${state.total.toLocaleString()}`;
}
