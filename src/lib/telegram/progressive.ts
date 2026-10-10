import { type FileLocation, tl } from '@mtcute/web';

import { debug } from '@/lib/debug';
import { getClient } from '@/lib/telegram/client';
import {
    describeTelegramError,
    isAbortError,
    isFileRefError,
    withFloodWait,
} from '@/lib/telegram/errors';
import {
    getQualitySource,
    loadMediaItem,
    refreshMediaItem,
} from '@/lib/telegram/media';
import { createDownloadQueue } from '@/lib/telegram/download-queue';
import { trailingIndexOffset } from '@/lib/telegram/mp4-index';
import type { MediaItem } from '@/lib/telegram/types';

const ALIGN = 1024;
const MB = 1024 * 1024;
const MAX_LIMIT = MB;
const PART_SIZE = MB;
const MAX_IN_FLIGHT = 4;
/**
 * How many 1MB windows past the one being played to fetch before the player
 * asks. The browser requests one range at a time and waits for it, so without
 * this every megabyte cost a full SW → page → Telegram round trip in series.
 */
const READ_AHEAD = 3;
/** Windows kept in memory across all streams: enough for read-ahead plus a
 * short seek back, without holding a whole film. */
const WINDOW_CACHE_MAX = 32;
/** How much of a trailing MP4 index (`moov`) to fetch ahead of the player. */
const TAIL_WINDOWS_MAX = 2;

type StreamEntry = {
    item: MediaItem;
    qualityId: string;
    file: FileLocation;
    fileSize: number;
    mimeType: string;
};

type ProgressiveGlobals = typeof globalThis & {
    __mediagramProgressive?: Map<string, StreamEntry>;
    __mediagramProgressiveBridge?: boolean;
    __mediagramOnSwMessage?: (event: MessageEvent) => void;
};

const globals = globalThis as ProgressiveGlobals;
if (!globals.__mediagramProgressive) {
    globals.__mediagramProgressive = new Map();
}
const streams = globals.__mediagramProgressive;
const aborts = new Set<string>();
/**
 * Telegram download slots: what a player is blocked on goes first, and warming
 * never takes more than half, so a click always finds one free.
 */
const queue = createDownloadQueue(MAX_IN_FLIGHT, MAX_IN_FLIGHT / 2);

function streamId(item: MediaItem, qualityId: string) {
    return `${item.key}::${qualityId}`;
}

export function progressiveUrl(item: MediaItem, qualityId: string) {
    const entry = streams.get(streamId(item, qualityId));
    const mime = encodeURIComponent(
        entry?.mimeType || item.mimeType || 'video/mp4',
    );
    const size = entry?.fileSize || item.fileSize || 0;
    return `/progressive/${encodeURIComponent(streamId(item, qualityId))}?fileSize=${size}&mimeType=${mime}`;
}

let bridgeReady: Promise<void> | null = null;

/**
 * Registers the service worker bridge once per page. Every play used to
 * re-register and wait on `ready` again before the first byte was asked for.
 */
export function ensureProgressiveBridge() {
    if (!bridgeReady) {
        bridgeReady = setUpBridge().catch((error: unknown) => {
            bridgeReady = null;
            throw error;
        });
    }
    return bridgeReady;
}

async function setUpBridge() {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) {
        throw new Error('Progressive streaming needs a service worker.');
    }
    globals.__mediagramOnSwMessage = onServiceWorkerMessage;
    if (!globals.__mediagramProgressiveBridge) {
        globals.__mediagramProgressiveBridge = true;
        navigator.serviceWorker.addEventListener('message', (event) => {
            globals.__mediagramOnSwMessage?.(event);
        });
    }
    await navigator.serviceWorker.register('/progressive-sw.js?v=5');
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
        await new Promise<void>((resolve, reject) => {
            const timer = window.setTimeout(() => {
                navigator.serviceWorker.removeEventListener(
                    'controllerchange',
                    onController,
                );
                reject(new Error('Service worker did not take control.'));
            }, 8000);
            const onController = () => {
                window.clearTimeout(timer);
                navigator.serviceWorker.removeEventListener(
                    'controllerchange',
                    onController,
                );
                resolve();
            };
            navigator.serviceWorker.addEventListener(
                'controllerchange',
                onController,
            );
        });
    }
}

export async function openProgressiveStream(
    item: MediaItem,
    qualityId: string,
) {
    await ensureProgressiveBridge();
    const source = getQualitySource(item, qualityId);
    if (!source) throw new Error('That quality is no longer available.');
    const mimeType = item.mimeType || 'video/mp4';
    const fileSize = source.file.fileSize || item.fileSize || 0;
    const id = streamId(item, qualityId);
    streams.set(id, {
        item,
        qualityId,
        file: source.file,
        fileSize,
        mimeType,
    });
    opens.set(id, (opens.get(id) ?? 0) + 1);
    // Unwarmed, this still saves the round trip of the browser parsing the
    // head before it asks for a trailing index: the head is shared, not doubled.
    if (qualityId === item.quality.id)
        warmProgressiveStream(item, { urgent: true });
    return progressiveUrl(item, qualityId);
}

/**
 * How many open/close pairs are holding each stream. The poster decoder and
 * the player open the same item's stream; without counting, the decoder
 * finishing tore down the stream (and its windows) under a playing video.
 */
const opens = new Map<string, number>();

export function closeProgressiveStream(item: MediaItem, qualityId: string) {
    const id = streamId(item, qualityId);
    const left = (opens.get(id) ?? 1) - 1;
    if (left > 0) {
        opens.set(id, left);
        return;
    }
    opens.delete(id);
    streams.delete(id);
    // The windows stay: the cache is capped anyway, and the poster decoder
    // closing its stream is exactly when the player is about to want them.
}

/**
 * Start fetching what a player asks for first, before anyone presses play:
 * the head of the file and, for an MP4 whose index (`moov`) was written after
 * the media, that index too — the browser reads the head, finds no index and
 * jumps to the end, so that is two round trips before the first frame.
 * Called on hover and for the items either side of the one being watched;
 * a tile that merely sits on screen warms its head only (`tail: false`).
 */
/**
 * How many on-screen tiles may warm their head in a session. Telegram
 * throttles an account that pulls too much too fast, and a grid of videos
 * each pulling a megabyte did exactly that.
 */
const ON_SCREEN_WARM_MAX = 8;
const onScreenWarmed = new Set<string>();

export function warmProgressiveStream(
    item: MediaItem,
    { urgent = false, tail = true }: { urgent?: boolean; tail?: boolean } = {},
) {
    if (item.type === 'photo') return;
    const qualityId = item.quality.id;
    const source = getQualitySource(item, qualityId);
    if (!source) return;
    const id = streamId(item, qualityId);
    // Tiles that merely sit on screen get a budget; a hover, a neighbour or
    // the player itself always goes through.
    if (!urgent && !tail && !onScreenWarmed.has(id)) {
        if (onScreenWarmed.size >= ON_SCREEN_WARM_MAX) return;
        onScreenWarmed.add(id);
    }
    let entry = streams.get(id);
    if (!entry) {
        entry = {
            item,
            qualityId,
            file: source.file,
            fileSize: source.file.fileSize || item.fileSize || 0,
            mimeType: item.mimeType || 'video/mp4',
        };
        streams.set(id, entry);
    }
    const warmed = entry;
    // A file Telegram says is not built for streaming keeps its index at the
    // end, and the browser cannot start without it. Ask for the end now,
    // alongside the head, instead of after reading the head — measured, that
    // second round trip in series was ~950ms of a 1850ms first play.
    const size = warmed.file.fileSize || warmed.fileSize || 0;
    if (tail && item.streamable === false && size > MB) {
        const last = Math.floor((size - 1) / MB);
        fetchWindow(id, warmed, last, urgent).catch(() => undefined);
    }
    fetchWindow(id, warmed, 0, urgent)
        .then((head) => {
            const fileSize = warmed.file.fileSize || warmed.fileSize || 0;
            // The browser buffers past the first megabyte before it starts
            // (under a second of 720p): measured, a video with two windows
            // ready started in ~50ms and one with a single window in
            // 200-700ms. So a likely play gets the second window as well.
            if (tail && fileSize > MB) {
                fetchWindow(id, warmed, 1, urgent).catch(() => undefined);
            }
            const indexAt = trailingIndexOffset(head, fileSize);
            if (!tail || indexAt === null) return;
            const first = Math.floor(indexAt / MB);
            const last = Math.min(
                Math.floor((fileSize - 1) / MB),
                first + TAIL_WINDOWS_MAX - 1,
            );
            for (let index = first; index <= last; index++) {
                fetchWindow(id, warmed, index, urgent).catch(() => undefined);
            }
        })
        .catch(() => undefined);
}

/**
 * Whole 1MB windows of a stream, by `${streamId}@${index}`, oldest first.
 *
 * Telegram serves a file in 1MB-aligned windows anyway, so fetching the whole
 * window costs the same round trip as fetching a slice of it — and the
 * browser's next request, which is nearly always the rest of that window or
 * the start of the next, is then answered from here without the network.
 */
const windows = new Map<string, Promise<Uint8Array>>();

function fetchWindow(
    key: string,
    entry: StreamEntry,
    index: number,
    urgent = true,
) {
    const cacheKey = `${key}@${index}`;
    const cached = windows.get(cacheKey);
    if (cached) {
        windows.delete(cacheKey);
        windows.set(cacheKey, cached);
        if (urgent) queue.promote(cacheKey);
        return cached;
    }
    const fileSize = entry.file.fileSize || entry.fileSize || 0;
    const asked = performance.now();
    const work = queue.run(
        () =>
            downloadPart(
                entry.file,
                index * MB,
                MB,
                fileSize,
                entry.item,
                entry.qualityId,
            ),
        urgent,
        cacheKey,
    );
    windows.set(cacheKey, work);
    void work.then(
        () => {
            debug('stream', 'window', {
                key,
                index,
                urgent,
                ms: Math.round(performance.now() - asked),
            });
        },
        () => undefined,
    );
    // A failed window must be asked for again, not served as a failure.
    work.catch(() => {
        if (windows.get(cacheKey) === work) windows.delete(cacheKey);
    });
    while (windows.size > WINDOW_CACHE_MAX) {
        const oldest = windows.keys().next().value;
        if (oldest === undefined) break;
        windows.delete(oldest);
    }
    return work;
}

function readAhead(key: string, entry: StreamEntry, from: number) {
    const fileSize = entry.file.fileSize || entry.fileSize || 0;
    if (fileSize <= 0) return;
    const last = Math.floor((fileSize - 1) / MB);
    for (
        let index = from + 1;
        index <= Math.min(last, from + READ_AHEAD);
        index++
    ) {
        fetchWindow(key, entry, index).catch(() => undefined);
    }
}

function parseStreamKey(url: string) {
    const path = new URL(url, window.location.origin).pathname;
    const encoded = path.replace(/^\/progressive\//, '');
    try {
        return decodeURIComponent(encoded);
    } catch {
        return encoded;
    }
}

function parseStreamId(key: string) {
    const match = /^(-?\d+):(\d+)::(.+)$/.exec(key);
    if (!match) return null;
    return {
        chatId: Number(match[1]),
        messageId: Number(match[2]),
        qualityId: match[3],
    };
}

/** Lookups in flight, so a burst of range requests asks Telegram once. */
const resolving = new Map<string, Promise<StreamEntry>>();

function resolveStream(key: string): Promise<StreamEntry> {
    const existing = streams.get(key);
    if (existing) return Promise.resolve(existing);
    let pending = resolving.get(key);
    if (!pending) {
        debug('stream', 'entry missing, loading message', key);
        pending = loadStream(key).finally(() => resolving.delete(key));
        resolving.set(key, pending);
    }
    return pending;
}

async function loadStream(key: string): Promise<StreamEntry> {
    const parsed = parseStreamId(key);
    if (!parsed) throw new Error('Unknown progressive stream.');
    const item = await loadMediaItem(parsed.chatId, parsed.messageId);
    if (!item) throw new Error('Media source expired.');
    const source =
        getQualitySource(item, parsed.qualityId) ??
        getQualitySource(item, item.quality.id);
    if (!source) throw new Error('Media source expired.');
    const entry: StreamEntry = {
        item,
        qualityId: parsed.qualityId,
        file: source.file,
        fileSize: source.file.fileSize || item.fileSize || 0,
        mimeType: item.mimeType || 'video/mp4',
    };
    streams.set(key, entry);
    return entry;
}

/**
 * Telegram requires each upload.getFile call to stay inside a single 1MB
 * window from the start of the file:
 * floor(offset / 1MB) === floor((offset + limit - 1) / 1MB)
 * With precise=true, offset and limit must also be 1KB-aligned. Reading whole
 * windows (`fetchWindow`) satisfies both by construction.
 */
async function getFileBytes(file: FileLocation, offset: number, limit: number) {
    const tg = getClient();
    const normalized = await tg._normalizeFileDownloadLocation(file);
    if (ArrayBuffer.isView(normalized.location)) {
        return normalized.location.subarray(offset, offset + limit);
    }
    if (normalized.location._.toLowerCase().includes('web')) {
        throw new Error('Web file locations cannot be streamed by range.');
    }
    const location = normalized.location as tl.TypeInputFileLocation;
    let dcId = file.dcId ?? normalized.dcId;
    for (;;) {
        try {
            const result = await tg.call(
                {
                    _: 'upload.getFile',
                    precise: true,
                    location,
                    offset,
                    limit,
                },
                // No silent sleeping inside mtcute: withFloodWait below waits
                // instead, and says so, so throttling shows up in the log.
                { dcId, kind: 'download', floodSleepThreshold: 0 },
            );
            if (result._ === 'upload.fileCdnRedirect') {
                throw new Error('Telegram CDN redirects are not supported.');
            }
            if (result._ !== 'upload.file') {
                throw new Error('Unexpected Telegram file response.');
            }
            return result.bytes;
        } catch (error) {
            if (tl.RpcError.is(error, 'FILE_MIGRATE_%d')) {
                dcId = error.newDc;
                continue;
            }
            throw error;
        }
    }
}

async function downloadPart(
    file: FileLocation,
    offset: number,
    limit: number,
    fileSize: number,
    item: MediaItem,
    qualityId: string,
) {
    const attempt = async (location: FileLocation, partLimit: number) =>
        withFloodWait(
            () => getFileBytes(location, offset, partLimit),
            (seconds) =>
                debug('stream', 'flood wait', {
                    seconds,
                    offset,
                    item: item.key,
                }),
        );

    const fallbackLimit = () => {
        const windowEnd = Math.floor(offset / MB) * MB + MB;
        const remainingWindow = windowEnd - offset;
        const remainingFile =
            fileSize > 0 ? Math.max(0, fileSize - offset) : remainingWindow;
        const rounded =
            Math.ceil(
                Math.min(remainingFile || ALIGN, remainingWindow, MAX_LIMIT) /
                    ALIGN,
            ) * ALIGN;
        return Math.max(ALIGN, Math.min(rounded, remainingWindow, MAX_LIMIT));
    };

    try {
        try {
            return await attempt(file, limit);
        } catch (error) {
            if (
                !(
                    tl.RpcError.is(error, 'LIMIT_INVALID') ||
                    tl.RpcError.is(error, 'OFFSET_INVALID')
                )
            ) {
                throw error;
            }
            return await attempt(file, fallbackLimit());
        }
    } catch (error) {
        if (isAbortError(error)) throw error;
        const expired =
            isFileRefError(error) ||
            (error instanceof Error &&
                error.message.toLowerCase().includes('file ref'));
        if (expired) {
            const entry = streams.get(streamId(item, qualityId));
            // Another window may already have fetched a fresh reference
            // while this one was failing on the old one: use it as is.
            if (!entry || entry.file === file) await refreshOnce(item);
            const next =
                entry && entry.file !== file
                    ? { file: entry.file }
                    : getQualitySource(item, qualityId);
            if (next) {
                if (entry) entry.file = next.file;
                try {
                    return await attempt(next.file, limit);
                } catch (retryError) {
                    if (
                        tl.RpcError.is(retryError, 'LIMIT_INVALID') ||
                        tl.RpcError.is(retryError, 'OFFSET_INVALID')
                    ) {
                        return attempt(next.file, fallbackLimit());
                    }
                    throw retryError;
                }
            }
        }
        throw new Error(describeTelegramError(error));
    }
}

/**
 * File-reference refreshes in flight, by item. The player reads four windows
 * at once, and each used to hit the expired reference and ask Telegram for
 * the message again on its own — four lookups and four retries before the
 * first frame.
 */
const refreshing = new Map<string, Promise<void>>();

function refreshOnce(item: MediaItem) {
    let pending = refreshing.get(item.key);
    if (!pending) {
        debug('stream', 'file reference expired, refreshing', item.key);
        pending = refreshMediaItem(item).finally(() =>
            refreshing.delete(item.key),
        );
        refreshing.set(item.key, pending);
    }
    return pending;
}

/** Data centres a download connection has been opened to this session. */
const connected = new Set<string>();

/**
 * Open the download connection a chat's files will need, with a 4KB read,
 * before anyone presses play. The first download from a data centre pays for
 * setting that connection up — measured at ~900ms against ~150-250ms for a
 * whole megabyte once it is open — and without this the first video a reader
 * opened paid it in full.
 */
export function preconnectFor(item: MediaItem) {
    if (item.type === 'photo') return;
    const source = getQualitySource(item, item.quality.id);
    if (!source) return;
    const dc = String(source.file.dcId ?? 'home');
    if (connected.has(dc)) return;
    connected.add(dc);
    const started = performance.now();
    getFileBytes(source.file, 0, ALIGN * 4)
        .then(() =>
            debug('stream', 'preconnected', {
                dc,
                ms: Math.round(performance.now() - started),
            }),
        )
        .catch(() => connected.delete(dc));
}

/** The small first piece a cold read is answered with; see `readRange`. */
const LEAD_SIZE = 256 * 1024;

/**
 * Up to LEAD_SIZE bytes from `start`, inside one window. Telegram wants the
 * offset 1KB-aligned, so the request starts at or just before `start` and the
 * difference is cut off; the limit stays 1KB-aligned because window ends are.
 */
async function fetchLead(entry: StreamEntry, start: number, windowEnd: number) {
    const from = Math.floor(start / ALIGN) * ALIGN;
    const limit = Math.min(LEAD_SIZE, windowEnd + 1 - from);
    const fileSize = entry.file.fileSize || entry.fileSize || 0;
    const bytes = await queue.run(
        () =>
            downloadPart(
                entry.file,
                from,
                limit,
                fileSize,
                entry.item,
                entry.qualityId,
            ),
        true,
        `lead:${from}`,
    );
    const head = bytes.subarray(start - from);
    if (head.byteLength === 0) throw new Error('empty lead');
    return head;
}

function copyBytes(bytes: Uint8Array) {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return copy.buffer;
}

async function readRange(
    url: string,
    start: number,
    end: number,
    messageId: string,
) {
    if (aborts.has(messageId)) throw new Error('aborted');
    const key = parseStreamKey(url);
    const entry = await resolveStream(key);
    const file = entry.file;
    const fileSize = file.fileSize || entry.fileSize || 0;

    if (fileSize > 0 && start >= fileSize) {
        return {
            type: 'PartInfo' as const,
            arrayBuffer: new ArrayBuffer(0),
            mimeType: entry.mimeType,
            fullSize: fileSize,
        };
    }

    let rangeEnd = end;
    if (fileSize > 0) rangeEnd = Math.min(rangeEnd, fileSize - 1);
    if (rangeEnd < start) rangeEnd = start;
    const index = Math.floor(start / MB);
    const windowEnd = index * MB + MB - 1;
    rangeEnd = Math.min(rangeEnd, windowEnd, start + PART_SIZE - 1);

    // A window nobody has fetched yet: race a small piece at the read point
    // against the whole window, so a cold click waits for 256KB rather than
    // a megabyte. The window still lands in the cache for what comes next.
    // Only a window nobody has asked for yet. One already on its way is
    // promoted instead: racing a lead against it on every browser request
    // doubled the traffic and got the account throttled by Telegram.
    const cold = fileSize > 0 && !windows.has(`${key}@${index}`);
    const whole = fetchWindow(key, entry, index);
    if (cold) {
        const first = await Promise.race([
            whole.then(() => null),
            fetchLead(entry, start, windowEnd).catch(() => null),
        ]);
        if (aborts.has(messageId)) throw new Error('aborted');
        if (first) {
            readAhead(key, entry, index);
            const slice = first.subarray(0, rangeEnd - start + 1);
            debug('stream', 'answered from lead', {
                key,
                start,
                bytes: slice.byteLength,
            });
            return {
                type: 'PartInfo' as const,
                arrayBuffer: copyBytes(slice),
                mimeType: entry.mimeType,
                fullSize: fileSize,
            };
        }
    }

    const data = await whole;
    if (aborts.has(messageId)) throw new Error('aborted');
    readAhead(key, entry, index);

    const sliceFrom = start - index * MB;
    const sliceTo = Math.min(data.byteLength, rangeEnd - index * MB + 1);
    const slice = data.subarray(Math.min(sliceFrom, data.byteLength), sliceTo);
    return {
        type: 'PartInfo' as const,
        arrayBuffer: copyBytes(slice),
        mimeType: entry.mimeType,
        fullSize: fileSize || index * MB + data.byteLength,
    };
}

function replyToPart(
    event: MessageEvent,
    messageId: string,
    payload: { result?: unknown; error?: string },
) {
    const port = event.ports?.[0];
    if (port) {
        port.postMessage(payload);
        return;
    }
    navigator.serviceWorker.controller?.postMessage({
        type: 'partResponse',
        messageId,
        ...payload,
    });
}

function onServiceWorkerMessage(event: MessageEvent) {
    const data = event.data;
    if (!data) return;
    if (data.type === 'abortPart') {
        aborts.add(data.messageId);
        return;
    }
    if (data.type !== 'requestPart') return;
    aborts.delete(data.messageId);
    void readRange(
        data.params.url,
        data.params.start,
        data.params.end,
        data.messageId,
    )
        .then((result) => {
            if (aborts.has(data.messageId)) return;
            replyToPart(event, data.messageId, { result });
        })
        .catch((error: unknown) => {
            if (aborts.has(data.messageId)) return;
            replyToPart(event, data.messageId, {
                error: error instanceof Error ? error.message : 'part failed',
            });
        })
        .finally(() => {
            aborts.delete(data.messageId);
        });
}
