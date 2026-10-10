/**
 * Running an export, and surviving the screen it was started from.
 *
 * The state lives in this module rather than in a component for the reason
 * `join-watch.ts` does: an Inertia visit unmounts the chat screen, and an
 * export of a whole history outlives it by a long way. `subscribeExport` hands
 * the current state to whatever mounts next, including a run that finished
 * while nothing was listening.
 *
 * Two phases, deliberately separable. `scanExport` reads metadata only, which
 * is what lets the dialog print an honest estimate before anyone commits to a
 * download. `startExport` takes that manifest and writes it.
 *
 * This module imports mtcute's neighbours directly rather than through
 * `await import()`, which is safe because nothing imports *it* except through
 * a dynamic import inside a handler — see `export-dialog.tsx`. Keeping the
 * indirection one level up is what stops the initial bundle growing.
 *
 * Nothing here is sent anywhere. Telegram is read in this tab and the bytes go
 * to the reader's own disk — see `.ai/rules/telegram.md`.
 */

import { debug } from '@/lib/debug';
import {
    type ExportEntry,
    type ExportMediaKind,
    type ExportSelection,
    exportFolderName,
    mediaFilePath,
    selectForExport,
    summarize,
} from '@/lib/export/plan';
import type { ExportSink } from '@/lib/export/sink';
import {
    buildIndexHtml,
    buildMessagesJson,
    type ExportedFile,
} from '@/lib/export/transcript';
import { fetchTaggedIds } from '@/lib/media-tags';
import {
    describeTelegramError,
    isFileRefError,
    withFloodWait,
} from '@/lib/telegram/errors';
import {
    loadMediaItems,
    refreshMediaItem,
    searchChatMedia,
    streamMediaBytes,
} from '@/lib/telegram/media';
import {
    HISTORY_PAGE_MAX,
    loadChatHistory,
    loadThreadMessages,
} from '@/lib/telegram/thread';
import type {
    ChatHistoryOffset,
    MediaItem,
    MediaOrder,
    MediaTypeFilter,
    ThreadMessage,
} from '@/lib/telegram/types';
import type { TagMatch } from '@/types/tags';

/** How many files are pulled at once. Matches the progressive reader's limit. */
const CONCURRENCY = 3;

export type ExportScope = 'chat' | 'filters';

/** The grid's active filters, in the shape `searchChatMedia` already takes. */
export type ExportFilters = {
    type: MediaTypeFilter;
    order: MediaOrder;
    minDur?: number;
    maxDur?: number;
    tags: string[];
    /** How a stack of those combines — the same choice the grid is showing. */
    tagMatch: TagMatch;
    query?: string;
};

export type ExportOptions = {
    chatId: number;
    chatTitle: string;
    chatUsername?: string;
    scope: ExportScope;
    /** Which media kinds to write. Ignored when `includeMedia` is false. */
    kinds: ExportMediaKind[];
    since?: string;
    until?: string;
    /** False for a free account: the transcript is written and nothing else. */
    includeMedia: boolean;
    /**
     * Whether to write `index.html` and `messages.json` beside the media.
     *
     * False is a media-only run: someone pulling the photos out of a chat
     * wants a folder of photos, not a conversation they can already read in
     * Telegram. At least one of this and `includeMedia` has to be true.
     */
    includeTranscript: boolean;
    filters?: ExportFilters;
};

export type ExportManifest = {
    options: ExportOptions;
    /** Every message the scan saw, oldest first. */
    messages: ThreadMessage[];
    /** The media that will be written, already filtered. */
    included: MediaItem[];
    /** What will not be, and why. */
    files: Map<number, ExportedFile>;
    items: number;
    bytes: number;
    /** True when at least one item published no size, so `bytes` is a floor. */
    partial: boolean;
};

export type ExportPhase =
    | 'downloading'
    | 'writing'
    | 'done'
    | 'failed'
    | 'cancelled';

export type ExportState = {
    phase: ExportPhase;
    chatId: number;
    chatTitle: string;
    /** The folder, or the filename prefix for a transcript-only run. */
    label: string;
    /** Files to write. */
    total: number;
    /** Files finished, however they finished. */
    done: number;
    written: number;
    failed: number;
    /** Bytes committed to disk. */
    bytes: number;
    /** Seconds Telegram asked us to wait, when it has. */
    waiting: number | null;
    /** Whether a transcript is being written, so the toast can point at it. */
    hasTranscript: boolean;
    error: string | null;
};

type Listener = (state: ExportState | null) => void;

const listeners = new Set<Listener>();
let state: ExportState | null = null;
let controller: AbortController | null = null;

function emit() {
    for (const listener of listeners) listener(state);
}

function patch(next: Partial<ExportState>) {
    if (!state) return;
    state = { ...state, ...next };
    emit();
}

/** Add one to a running count without losing a concurrent worker's increment. */
function bump(field: 'done' | 'written' | 'failed', by = 1) {
    if (!state) return;
    state = { ...state, [field]: state[field] + by };
}

/**
 * Watch the run. The current state arrives immediately, including a finished
 * one — a run that ended during an Inertia visit is still news.
 */
export function subscribeExport(listener: Listener): () => void {
    listeners.add(listener);
    listener(state);
    return () => {
        listeners.delete(listener);
    };
}

export function currentExport(): ExportState | null {
    return state;
}

export function isExportRunning(): boolean {
    return state?.phase === 'downloading' || state?.phase === 'writing';
}

/** Stop the run. What is already on disk stays there. */
export function cancelExport(): void {
    controller?.abort();
}

/** Clear a finished run, so its toast can go away. */
export function dismissExport(): void {
    if (isExportRunning()) return;
    state = null;
    emit();
}

/**
 * Drop everything, because the account that was exporting is gone. Called from
 * `logout()`, beside `stopAllJoinWatches()`.
 */
export function stopAllExports(): void {
    controller?.abort();
    controller = null;
    state = null;
    listeners.clear();
}

export function exportFolderFor(options: ExportOptions): string {
    return exportFolderName(options.chatTitle, new Date());
}

function selectionOf(options: ExportOptions): ExportSelection {
    return {
        kinds: options.kinds,
        since: options.since,
        until: options.until,
    };
}

/**
 * Read the chat's metadata and work out what an export would contain.
 *
 * No media bytes are fetched here. `onTick` is called as pages land so the
 * dialog can count up rather than sit blank through a long history.
 */
export async function scanExport(
    options: ExportOptions,
    onTick: (scanned: number, found: number) => void,
    signal: AbortSignal,
): Promise<ExportManifest> {
    const messages =
        options.scope === 'chat'
            ? await scanHistory(options, onTick, signal)
            : await scanFiltered(options, onTick, signal);

    return planFrom(options, messages);
}

/**
 * Work out what an export contains, without asking Telegram anything.
 *
 * Split out from the scan because the two answer to different inputs. Which
 * kinds to write and where to stop are decided over messages already in hand,
 * so a checkbox in the dialog re-plans instantly; only the scope and the lower
 * date bound change what has to be read, and only those re-scan.
 */
export function planFrom(
    options: ExportOptions,
    scanned: ThreadMessage[],
): ExportManifest {
    // The date range bounds the conversation as well as the media. Walking
    // backwards overshoots by up to a page, and filtering only the media would
    // leave a transcript running past the range it says it covers.
    const messages = scanned.filter((message) =>
        withinRange(message.date, options.since, options.until),
    );

    const entries: ExportEntry[] = [];
    const byMessage = new Map<number, MediaItem>();
    for (const message of messages) {
        if (!message.media) continue;
        entries.push(message.media);
        byMessage.set(message.id, message.media);
    }

    const { included, skipped } = selectForExport(
        entries,
        selectionOf(options),
    );

    const files = new Map<number, ExportedFile>();
    for (const item of skipped) {
        files.set(item.entry.messageId, { status: item.reason });
    }

    const totals = summarize(included);

    return {
        options,
        messages,
        // The entries are the MediaItems themselves; the lookup only restores
        // the type that `selectForExport`'s structural parameter widened.
        included: included
            .map((entry) => byMessage.get(entry.messageId))
            .filter((item): item is MediaItem => item !== undefined),
        files,
        items: totals.items,
        bytes: totals.bytes,
        partial: totals.partial,
    };
}

/** Walk the whole chat backwards, newest page first, collecting every message. */
async function scanHistory(
    options: ExportOptions,
    onTick: (scanned: number, found: number) => void,
    signal: AbortSignal,
): Promise<ThreadMessage[]> {
    const collected: ThreadMessage[] = [];
    let media = 0;
    let before: ChatHistoryOffset | undefined;

    for (;;) {
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

        const page = await loadChatHistory(
            options.chatId,
            before,
            HISTORY_PAGE_MAX,
        );

        // Pages arrive oldest-first within themselves but the walk runs
        // backwards, so each page goes in front of what came before it.
        collected.unshift(...page.messages);
        media += page.messages.filter((message) => message.media).length;
        onTick(collected.length, media);

        // The lower bound is a floor on the whole walk, not a per-item filter:
        // once a page is entirely older than it, there is nothing left to read.
        if (options.since && isEntirelyBefore(page.messages, options.since)) {
            break;
        }

        if (!page.nextOffset) break;
        before = page.nextOffset;
    }

    return collected;
}

function localDay(iso: string): string | null {
    const at = new Date(iso);
    if (Number.isNaN(at.getTime())) return null;
    const month = String(at.getMonth() + 1).padStart(2, '0');
    const day = String(at.getDate()).padStart(2, '0');
    return `${at.getFullYear()}-${month}-${day}`;
}

/**
 * Whether a message falls inside the chosen days, both ends inclusive.
 *
 * A date that cannot be read is kept. Dropping a message because its timestamp
 * was unparseable would silently lose it from an archive.
 */
function withinRange(date: string, since?: string, until?: string): boolean {
    const day = localDay(date);
    if (day === null) return true;
    if (since && day < since) return false;
    if (until && day > until) return false;
    return true;
}

function isEntirelyBefore(messages: ThreadMessage[], since: string): boolean {
    if (messages.length === 0) return false;
    // The page is ascending, so its last message is its newest.
    const newest = localDay(messages[messages.length - 1].date);
    return newest !== null && newest < since;
}

/** Take what the grid is showing, then read the messages back for the transcript. */
async function scanFiltered(
    options: ExportOptions,
    onTick: (scanned: number, found: number) => void,
    signal: AbortSignal,
): Promise<ThreadMessage[]> {
    const filters = options.filters;
    if (!filters) return [];

    const items =
        filters.tags.length > 0
            ? await scanTagged(options, filters, onTick, signal)
            : await scanSearch(options, filters, onTick, signal);

    // The media is known; who sent it is not — `searchChatMedia` answers in
    // MediaItems, which carry a caption and no sender. Reading the messages
    // back is what keeps a filtered export a transcript rather than a list.
    const messages = await loadThreadMessages(
        options.chatId,
        items.map((item) => item.messageId),
    );

    // Two calls, so re-attach the items we already normalised rather than
    // trusting the second read to have produced the same renditions.
    const byId = new Map(items.map((item) => [item.messageId, item]));
    for (const message of messages) {
        message.media = byId.get(message.id) ?? message.media;
    }

    return messages;
}

async function scanTagged(
    options: ExportOptions,
    filters: ExportFilters,
    onTick: (scanned: number, found: number) => void,
    signal: AbortSignal,
): Promise<MediaItem[]> {
    const items: MediaItem[] = [];
    let offset: number | undefined;

    for (;;) {
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

        // A tag filter is answered by Laravel, which holds nothing but the
        // (chat, message) pair — the media itself still comes from Telegram.
        const page = await fetchTaggedIds(
            options.chatId,
            filters.tags,
            filters.order,
            offset,
            filters.tagMatch,
        );
        items.push(...(await loadMediaItems(options.chatId, page.messageIds)));
        onTick(items.length, items.length);

        if (page.nextOffset === null) break;
        offset = page.nextOffset;
    }

    return items;
}

async function scanSearch(
    options: ExportOptions,
    filters: ExportFilters,
    onTick: (scanned: number, found: number) => void,
    signal: AbortSignal,
): Promise<MediaItem[]> {
    const items: MediaItem[] = [];
    let offset: number | undefined;

    for (;;) {
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

        const page = await searchChatMedia({
            chatId: options.chatId,
            type: filters.type,
            order: filters.order,
            minDuration: filters.minDur,
            maxDuration: filters.maxDur,
            query: filters.query,
            offset,
        });
        items.push(...page.items);
        onTick(items.length, items.length);

        if (page.nextOffset === undefined) break;
        offset = page.nextOffset;
    }

    return items;
}

/**
 * Write the manifest.
 *
 * Returns as soon as the run is under way — everything after this is reported
 * through `subscribeExport`, because there is no screen guaranteed to still be
 * mounted when it ends.
 */
export function startExport(manifest: ExportManifest, sink: ExportSink): void {
    if (isExportRunning()) return;

    const options = manifest.options;
    const writingMedia = options.includeMedia && sink.acceptsMedia;
    controller = new AbortController();

    debug('export', 'started', {
        chat: options.chatId,
        scope: options.scope,
        sink: sink.label,
        media: writingMedia,
        transcript: options.includeTranscript,
        items: manifest.items,
        bytes: manifest.bytes,
        messages: manifest.messages.length,
    });

    state = {
        phase: writingMedia ? 'downloading' : 'writing',
        chatId: options.chatId,
        chatTitle: options.chatTitle,
        label: sink.label,
        total: writingMedia ? manifest.items : 0,
        done: 0,
        written: 0,
        failed: 0,
        bytes: 0,
        waiting: null,
        hasTranscript: options.includeTranscript,
        error: null,
    };
    emit();

    void perform(manifest, sink, controller.signal);
}

async function perform(
    manifest: ExportManifest,
    sink: ExportSink,
    signal: AbortSignal,
) {
    const options = manifest.options;
    const files = new Map(manifest.files);

    try {
        if (options.includeMedia && sink.acceptsMedia) {
            await downloadAll(manifest, sink, files, signal);
        } else if (options.includeTranscript) {
            // Say so per item rather than leaving the transcript silently
            // pointing at files that were never going to be written.
            for (const item of manifest.included) {
                files.set(item.messageId, { status: 'omitted' });
            }
        }

        if (signal.aborted) {
            debug('export', 'cancelled', state);
            patch({ phase: 'cancelled' });
            return;
        }

        if (options.includeTranscript) {
            patch({ phase: 'writing' });
            await writeTranscript(manifest, sink, files);
        }

        await sink.close();

        patch({ phase: 'done' });
        debug('export', 'finished', sink.label, state);
    } catch (error) {
        if (signal.aborted) {
            patch({ phase: 'cancelled' });
            return;
        }
        patch({ phase: 'failed', error: describeTelegramError(error) });
        debug('export', 'failed', error);
    } finally {
        controller = null;
    }
}

async function downloadAll(
    manifest: ExportManifest,
    sink: ExportSink,
    files: Map<number, ExportedFile>,
    signal: AbortSignal,
) {
    const queue = manifest.included;
    let next = 0;

    const workers = Array.from(
        { length: Math.min(CONCURRENCY, queue.length) },
        async () => {
            for (;;) {
                if (signal.aborted) return;
                const item = queue[next];
                next += 1;
                if (!item) return;
                await writeItem(item, sink, files, signal);
            }
        },
    );

    await Promise.all(workers);
}

async function writeItem(
    item: MediaItem,
    sink: ExportSink,
    files: Map<number, ExportedFile>,
    signal: AbortSignal,
) {
    const path = mediaFilePath(item);

    try {
        // A re-run into the same folder picks up where the last one stopped
        // rather than paying for it a second time.
        if (await sink.has(path)) {
            debug('export', 'already on disk, skipped', path);
            files.set(item.messageId, { status: 'written', path });
            bump('done');
            bump('written');
            emit();
            return;
        }

        const bytes = await withFloodWait(
            () => streamOne(item, path, sink, signal),
            (seconds) => {
                // The toast only says "waiting"; how long, and for what, is
                // the kind of thing you want under ?debug=1 and nowhere else.
                debug('export', 'flood wait', `${seconds}s`, item.key);
                patch({ waiting: seconds });
            },
        );

        debug('export', 'wrote', path, bytes);
        files.set(item.messageId, { status: 'written', path });
        bump('done');
        bump('written');
        patch({ waiting: null, bytes: (state?.bytes ?? 0) + bytes });
    } catch (error) {
        if (signal.aborted) return;
        // One bad file costs one file. The run carries on, and the transcript
        // says which ones did not make it.
        files.set(item.messageId, {
            status: 'failed',
            reason: describeTelegramError(error),
        });
        bump('done');
        bump('failed');
        emit();
        debug('export', 'item failed', item.key, error);
    }
}

/**
 * One file, streamed to disk, retried once if its file reference expired.
 *
 * The retry restarts from byte zero rather than resuming. That is not
 * wasteful, it is the only correct thing: the sink's writable is a swap file
 * that commits on close, so an abandoned attempt leaves nothing behind, and
 * resuming a refreshed reference from a stale offset would splice two
 * different files together.
 */
async function streamOne(
    item: MediaItem,
    path: string,
    sink: ExportSink,
    signal: AbortSignal,
): Promise<number> {
    let written = 0;

    const counted = async function* (source: AsyncIterable<Uint8Array>) {
        written = 0;
        for await (const chunk of source) {
            written += chunk.byteLength;
            yield chunk;
        }
    };

    try {
        await sink.writeStream(
            path,
            counted(streamMediaBytes(item, undefined, signal)),
        );
        return written;
    } catch (error) {
        if (!isFileRefError(error) || signal.aborted) throw error;
        await refreshMediaItem(item);
        await sink.writeStream(
            path,
            counted(streamMediaBytes(item, undefined, signal)),
        );
        return written;
    }
}

async function writeTranscript(
    manifest: ExportManifest,
    sink: ExportSink,
    files: Map<number, ExportedFile>,
) {
    const options = manifest.options;
    const input = {
        chat: {
            id: options.chatId,
            title: options.chatTitle,
            username: options.chatUsername,
        },
        messages: manifest.messages,
        files,
        exportedAt: new Date(),
    };

    await sink.writeText('index.html', buildIndexHtml(input));
    await sink.writeText('messages.json', buildMessagesJson(input));
}
