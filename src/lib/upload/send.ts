/**
 * Sending a bulk upload, and surviving the screen it was started from.
 *
 * Same shape as `lib/export/run.ts`, and for the same reason: an Inertia visit
 * unmounts the chat screen, and thirty videos take longer than the reader will
 * sit still for. The state lives in this module; `<UploadWatcher/>` in AppShell
 * only listens.
 *
 * Files go straight from the reader's disk to Telegram over MTProto. Laravel
 * never sees a byte, which is the same guarantee reading has — see
 * `.ai/rules/telegram.md`. There is no server-side upload endpoint and there
 * must not be one.
 *
 * Imports mtcute's neighbours directly because nothing imports *this* except
 * through a dynamic import inside a handler — see `upload-dialog.tsx`.
 */

import { debug } from '@/lib/debug';
import type { InputMediaLike } from '@mtcute/web';

import { bulkTag } from '@/lib/media-tags';
import { getClient } from '@/lib/telegram/client';
import { describeTelegramError, withFloodWait } from '@/lib/telegram/errors';
import {
    chunkMessageIds,
    type PlannedBatch,
    type PlannedItem,
    type UploadPlan,
} from '@/lib/upload/plan';

export type UploadPhase =
    | 'sending'
    | 'tagging'
    | 'done'
    | 'failed'
    | 'cancelled';

export type UploadState = {
    phase: UploadPhase;
    chatId: number;
    chatTitle: string;
    /** Messages to send. An album counts once. */
    total: number;
    /** Messages that landed. */
    done: number;
    /** Messages that did not. */
    failed: number;
    /** Bytes handed to Telegram so far. */
    bytes: number;
    totalBytes: number;
    /** What is going up right now. */
    label: string | null;
    /** Seconds Telegram asked us to wait, when it has. */
    waiting: number | null;
    error: string | null;
    /** How many of the sent messages carry the picked tags. */
    tagged: number;
    /**
     * Why tagging did not happen, when it did not.
     *
     * Kept apart from `error`: the files really are in the chat, and a run
     * that sent thirty videos and failed to label them is not a failed run.
     */
    tagError: string | null;
};

export type UploadRequest = {
    chatId: number;
    chatTitle: string;
    plan: UploadPlan;
    /** The picked files, by the id the plan refers to them by. */
    files: ReadonlyMap<string, File>;
    /**
     * Tags to put on everything that lands, by tag id.
     *
     * Applied once at the end of the run through the bulk endpoint, never one
     * message at a time: forty files that way is forty round trips against a
     * throttled route. Empty is the normal case.
     */
    tagIds: readonly number[];
};

type Listener = (state: UploadState | null) => void;

const listeners = new Set<Listener>();
let state: UploadState | null = null;
let controller: AbortController | null = null;

function emit() {
    for (const listener of listeners) listener(state);
}

function patch(next: Partial<UploadState>) {
    if (!state) return;
    state = { ...state, ...next };
    emit();
}

export function subscribeUpload(listener: Listener): () => void {
    listeners.add(listener);
    listener(state);
    return () => {
        listeners.delete(listener);
    };
}

export function isUploadRunning(): boolean {
    // Tagging counts: the run is not over, and a second upload starting on top
    // of it would clear the ids the first one still has to label.
    return state?.phase === 'sending' || state?.phase === 'tagging';
}

export function currentUpload(): UploadState | null {
    return state;
}

/** Stop after the message being sent. What has already landed stays sent. */
export function cancelUpload(): void {
    controller?.abort();
}

/** Clear a finished run so its toast can go away. */
export function dismissUpload(): void {
    if (isUploadRunning()) return;
    state = null;
    emit();
}

/**
 * Drop everything, because the account that was sending is gone. Called from
 * `logout()`, beside `stopAllJoinWatches()`.
 */
export function stopAllUploads(): void {
    controller?.abort();
    controller = null;
    state = null;
    listeners.clear();
}

/**
 * Send the plan.
 *
 * Returns as soon as the run is under way. Everything after is reported
 * through `subscribeUpload`, because there is no screen guaranteed to still be
 * mounted when the last file lands.
 */
export function startUpload(request: UploadRequest): void {
    if (isUploadRunning()) return;

    debug('upload', 'started', {
        chat: request.chatId,
        messages: request.plan.messages,
        files: request.plan.files,
        bytes: request.plan.bytes,
        tags: request.tagIds.length,
        batches: request.plan.batches.map((batch) => ({
            items: batch.items.length,
            kinds: batch.items.map((item) => item.kind),
            captioned: batch.items.filter((item) => item.caption).length,
        })),
    });

    controller = new AbortController();
    state = {
        phase: 'sending',
        chatId: request.chatId,
        chatTitle: request.chatTitle,
        total: request.plan.messages,
        done: 0,
        failed: 0,
        bytes: 0,
        totalBytes: request.plan.bytes,
        label: null,
        waiting: null,
        error: null,
        tagged: 0,
        tagError: null,
    };
    emit();

    void perform(request, controller.signal);
}

async function perform(request: UploadRequest, signal: AbortSignal) {
    // Progress arrives per file as "uploaded so far", not as a delta, so the
    // total is recomputed from the latest figure for each rather than added
    // up — otherwise every callback would count the same bytes again.
    const uploaded = new Map<string, number>();

    const report = () => {
        let total = 0;
        for (const bytes of uploaded.values()) total += bytes;
        patch({ bytes: total });
    };

    // The message ids Telegram gave what actually landed. Tagging names media
    // by (chat id, message id), so these are the only handle there is — and
    // they exist only here, because nothing refetches the chat in between.
    const landed: number[] = [];

    try {
        for (const batch of request.plan.batches) {
            if (signal.aborted) break;

            patch({ label: labelFor(batch, request.files) });

            try {
                const sent = await withFloodWait(
                    () => sendBatch(request, batch, uploaded, report),
                    (seconds) => {
                        // The toast only says "waiting"; the mechanics belong
                        // under ?debug=1.
                        debug('upload', 'flood wait', `${seconds}s`);
                        patch({ waiting: seconds });
                    },
                );
                landed.push(...sent);
                debug('upload', 'sent', labelFor(batch, request.files), sent);
                patch({ waiting: null, done: (state?.done ?? 0) + 1 });
            } catch (error) {
                if (signal.aborted) break;
                // One rejected message does not stop the rest. A chat that
                // refuses media refuses all of it, and the count says so.
                patch({ failed: (state?.failed ?? 0) + 1 });
                debug('upload', 'batch failed', error);
            }
        }

        // Tagged after the send, never before it: a message id does not exist
        // until Telegram has given one, and labelling media that turned out
        // not to land would leave a tag pointing at nothing. Whatever did land
        // gets tagged, cancelled run included — those files really are in the
        // chat.
        await applyTags(request, landed);

        if (signal.aborted) {
            debug('upload', 'cancelled', state);
            patch({ phase: 'cancelled', label: null });
            return;
        }

        patch({ phase: 'done', label: null });
        debug('upload', 'finished', state);
    } catch (error) {
        if (signal.aborted) {
            patch({ phase: 'cancelled', label: null });
            return;
        }
        patch({ phase: 'failed', error: describeTelegramError(error) });
        debug('upload', 'failed', error);
    } finally {
        controller = null;
    }
}

/**
 * Put the picked tags on everything that landed, in as few requests as
 * possible.
 *
 * One bulk request per tag per chunk of ids — never one per message. A folder
 * of forty photos tagged the per-item way is forty round trips against a
 * throttled route, which is the whole reason `bulk` exists.
 *
 * A tag that fails is reported and does not fail the run: the files are in the
 * chat either way, and the reader can still tag them from the grid. The chat
 * id and the message ids are all that leaves the browser here — no file, no
 * caption, no peer.
 */
async function applyTags(request: UploadRequest, landed: number[]) {
    if (request.tagIds.length === 0 || landed.length === 0) return;

    patch({ phase: 'tagging', label: null, waiting: null });

    try {
        for (const tagId of request.tagIds) {
            for (const chunk of chunkMessageIds(landed)) {
                await bulkTag(request.chatId, chunk, tagId, 'attach');
            }
        }

        patch({ tagged: landed.length });
        debug('upload', 'tagged', {
            messages: landed.length,
            tags: request.tagIds.length,
        });
    } catch (error) {
        patch({
            tagError:
                error instanceof Error
                    ? error.message
                    : 'The files were sent, but could not be tagged.',
        });
        debug('upload', 'tagging failed', error);
    }
}

/**
 * Send one message or one album, and answer with the message ids Telegram
 * assigned.
 *
 * The ids are the point of the return value: an album of ten is one batch but
 * ten messages, and tagging has to name every one of them.
 */
async function sendBatch(
    request: UploadRequest,
    batch: PlannedBatch,
    uploaded: Map<string, number>,
    report: () => void,
): Promise<number[]> {
    const tg = getClient();

    if (batch.items.length === 1) {
        const item = batch.items[0];
        const file = request.files.get(item.fileId);
        if (!file) throw new Error('That file is no longer available.');

        const message = await tg.sendMedia(
            request.chatId,
            toInputMedia(item, file),
            {
                progressCallback: (sent) => {
                    uploaded.set(item.fileId, sent);
                    report();
                },
            },
        );
        return [message.id];
    }

    const medias = batch.items.map((item) => {
        const file = request.files.get(item.fileId);
        if (!file) throw new Error('That file is no longer available.');
        return toInputMedia(item, file);
    });

    const messages = await tg.sendMediaGroup(request.chatId, medias, {
        progressCallback: (index, sent) => {
            const item = batch.items[index];
            if (!item) return;
            uploaded.set(item.fileId, sent);
            report();
        },
    });

    return messages.map((message) => message.id);
}

/**
 * The file as Telegram should file it.
 *
 * Never `auto`. mtcute's own note is that a newly uploaded file sent that way
 * goes up as a document, so a photo would arrive as an attachment rather than
 * a picture — the kind is decided in `plan.ts` and honoured here.
 */
function toInputMedia(item: PlannedItem, file: File): InputMediaLike {
    const common = {
        file,
        fileName: file.name,
        caption: item.caption,
    };

    switch (item.kind) {
        case 'photo':
            return { type: 'photo', ...common };
        case 'video':
            return { type: 'video', ...common };
        case 'audio':
            return { type: 'audio', ...common };
        default:
            return { type: 'document', ...common };
    }
}

function labelFor(
    batch: PlannedBatch,
    files: ReadonlyMap<string, File>,
): string {
    const first = files.get(batch.items[0]?.fileId ?? '')?.name ?? 'file';
    if (batch.items.length === 1) return first;
    return `${first} and ${batch.items.length - 1} more`;
}
