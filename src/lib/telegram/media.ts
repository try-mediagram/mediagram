import {
    type Audio,
    FileLocation,
    type Message,
    type Photo,
    SearchFilters,
    Thumbnail,
    type tl,
    Video,
    type Voice,
} from '@mtcute/web';

import { blobCache } from '@/lib/blob-cache';
import { debug } from '@/lib/debug';
import { readThumb, writeThumb } from '@/lib/thumb-store';
import { getClient } from '@/lib/telegram/client';
import {
    isAbortError,
    isFileRefError,
    withFloodWait,
} from '@/lib/telegram/errors';
import { choosePreview, resolveVideoDuration } from '@/lib/telegram/preview';
import { fitPhotoQuality } from '@/lib/telegram/photo-fit';
import type {
    MediaItem,
    MediaKind,
    MediaOrder,
    MediaPage,
    MediaQuality,
    MediaSearchParams,
    MediaTypeFilter,
} from '@/lib/telegram/types';

type MediaSource = Photo | Video | Audio | Voice;

export type QualitySource = {
    file: FileLocation;
    playlist?: FileLocation;
    extra: Map<string, FileLocation>;
};

type MediaGlobals = typeof globalThis & {
    __mediagramSources?: Map<string, MediaSource>;
    __mediagramQualitySources?: Map<string, QualitySource>;
};

const mediaGlobals = globalThis as MediaGlobals;
if (!mediaGlobals.__mediagramSources) {
    mediaGlobals.__mediagramSources = new Map();
}
if (!mediaGlobals.__mediagramQualitySources) {
    mediaGlobals.__mediagramQualitySources = new Map();
}
const sources = mediaGlobals.__mediagramSources;
const qualitySources = mediaGlobals.__mediagramQualitySources;

export function mediaKey(chatId: number, messageId: number) {
    return `${chatId}:${messageId}`;
}

export function clearMediaCaches() {
    sources.clear();
    qualitySources.clear();
}

function qualityStoreKey(itemKey: string, qualityId: string) {
    return `${itemKey}::${qualityId}`;
}

function locationFromDocument(doc: tl.RawDocument): FileLocation {
    return new FileLocation(
        {
            _: 'inputDocumentFileLocation',
            id: doc.id,
            accessHash: doc.accessHash,
            fileReference: doc.fileReference,
            thumbSize: '',
        },
        doc.size,
        doc.dcId,
    );
}

function documentFileName(doc: tl.RawDocument): string {
    const attr = doc.attributes.find(
        (entry) => entry._ === 'documentAttributeFilename',
    );
    return attr && attr._ === 'documentAttributeFilename' ? attr.fileName : '';
}

function isPlaylistMime(mime: string) {
    return (
        mime === 'application/x-mpegurl' ||
        mime === 'application/vnd.apple.mpegurl' ||
        mime.endsWith('mpegurl')
    );
}

function videoFromDocument(
    doc: tl.RawDocument,
    media?: tl.RawMessageMediaDocument,
): Video | null {
    const attr = doc.attributes.find(
        (entry) =>
            entry._ === 'documentAttributeVideo' ||
            (entry._ === 'documentAttributeImageSize' &&
                doc.mimeType === 'image/gif'),
    );
    if (!attr) return null;
    if (
        attr._ !== 'documentAttributeVideo' &&
        attr._ !== 'documentAttributeImageSize'
    ) {
        return null;
    }
    return new Video(doc, attr, media);
}

/**
 * The single rendition we play: the largest one Telegram published.
 *
 * There is no picker any more, so this is the whole of the decision. Height
 * decides it; a tie falls to the bigger file, and then to the original
 * document, which is the one whose bytes were never re-encoded.
 *
 * Both collectors seed their ladder with the original, so this only comes back
 * undefined for a kind that forgot to — and `normalize()` drops that item
 * rather than handing the player a quality that is not there.
 */
function pickBestQuality(qualities: MediaQuality[]): MediaQuality | undefined {
    return [...qualities].sort(
        (a, b) =>
            b.height - a.height ||
            (b.fileSize ?? 0) - (a.fileSize ?? 0) ||
            Number(b.id === 'full') - Number(a.id === 'full'),
    )[0];
}

function collectPhotoQualities(itemKey: string, photo: Photo): MediaQuality[] {
    const extras = new Map<string, FileLocation>();
    const qualities: MediaQuality[] = [];
    for (const thumb of photo.thumbnails) {
        if (
            thumb.isVideo ||
            !Number.isFinite(thumb.height) ||
            thumb.height < 32
        ) {
            continue;
        }
        const id = `p-${thumb.type}`;
        qualities.push({
            id,
            label: `${thumb.height}p`,
            width: thumb.width,
            height: thumb.height,
            fileSize: thumb.fileSize,
            hasHls: false,
        });
        qualitySources.set(qualityStoreKey(itemKey, id), {
            file: thumb,
            extra: extras,
        });
    }
    qualities.push({
        id: 'full',
        label: 'Original',
        width: photo.width,
        height: photo.height,
        fileSize: photo.fileSize,
        hasHls: false,
    });
    qualitySources.set(qualityStoreKey(itemKey, 'full'), {
        file: photo,
        extra: extras,
    });
    qualities.sort((a, b) => a.height - b.height);
    photoLadders.set(itemKey, qualities);
    return qualities;
}

/** Every size Telegram stored of a photo, smallest first, by item key. */
const photoLadders = new Map<string, MediaQuality[]>();

/**
 * The smallest stored size of a photo that still fills a `boxWidth` by
 * `boxHeight` area (device pixels) at its own aspect ratio — so the viewer
 * pulls a 1280px rendition into a laptop window rather than a 2560px
 * original several times the bytes. The original when nothing smaller does,
 * and for anything that is not a photo.
 */
export function photoQualityFor(
    item: MediaItem,
    boxWidth: number,
    boxHeight: number,
): MediaQuality {
    const ladder = photoLadders.get(item.key);
    if (item.type !== 'photo' || !ladder?.length) return item.quality;
    return (
        fitPhotoQuality(ladder, item.width, item.height, boxWidth, boxHeight) ??
        item.quality
    );
}

/**
 * How long the video runs.
 *
 * `documentAttributeVideo.duration` is filled in by whoever uploaded the file,
 * and plenty of channel posts — anything sent by a script that did not measure
 * it — carry a zero. Telegram's own transcoded renditions do know, so an alt
 * document is asked before the tile gives up and says "Video".
 */
function videoDuration(video: Video): number {
    return resolveVideoDuration(video.duration, video.media?.altDocuments);
}

function collectVideoQualities(itemKey: string, video: Video): MediaQuality[] {
    const extras = new Map<string, FileLocation>();
    const playlists = new Map<string, FileLocation>();
    const variants: Video[] = [video];

    const alts = video.media?.altDocuments ?? [];
    for (const alt of alts) {
        if (alt._ !== 'document') continue;
        const location = locationFromDocument(alt);
        const name = documentFileName(alt);
        if (name) extras.set(name, location);
        extras.set(alt.id.toString(), location);
        if (isPlaylistMime(alt.mimeType)) {
            const linked = name.replace(/^mtproto:?/i, '');
            playlists.set(linked, location);
            continue;
        }
        const parsed = videoFromDocument(alt, video.media);
        if (parsed) variants.push(parsed);
    }

    const qualities: MediaQuality[] = [];
    const seen = new Set<number>();
    for (const [index, variant] of variants.entries()) {
        const height = variant.height || video.height;
        if (seen.has(height) && index > 0) continue;
        seen.add(height);
        const id = index === 0 ? 'full' : `v-${variant.raw.id.toString()}`;
        const playlist =
            playlists.get(variant.raw.id.toString()) ??
            playlists.get(documentFileName(variant.raw));
        qualities.push({
            id,
            label: height ? `${height}p` : index === 0 ? 'Original' : 'Alt',
            width: variant.width,
            height,
            fileSize: variant.fileSize,
            hasHls: Boolean(playlist),
        });
        qualitySources.set(qualityStoreKey(itemKey, id), {
            file: variant,
            playlist,
            extra: extras,
        });
    }
    return qualities.sort((a, b) => b.height - a.height);
}

/**
 * Audio and voice ship as a single document — no alt renditions, no thumbnail
 * ladder — so the best of them is the only one there is.
 */
function collectAudioQuality(
    itemKey: string,
    audio: Audio | Voice,
): MediaQuality {
    qualitySources.set(qualityStoreKey(itemKey, 'full'), {
        file: audio,
        extra: new Map(),
    });
    return {
        id: 'full',
        label: 'Original',
        width: 0,
        height: 0,
        fileSize: audio.fileSize,
        hasHls: false,
    };
}

export async function refreshMediaItem(item: MediaItem) {
    const [message] = await getClient().getMessages(
        item.chatId,
        item.messageId,
    );
    if (message) normalize(message, item.chatId);
}

/**
 * The media on a message already in hand, or null when there is none we can
 * show.
 *
 * The same `normalize()` the grid runs, exposed for callers that fetched the
 * message for another reason — the rail's chat stream reads a page of history
 * and would otherwise have to ask Telegram for every message a second time.
 * Registering the source is the point as much as the item is: it is what makes
 * `downloadThumb()` work afterwards.
 */
export function mediaItemFromMessage(
    message: Message,
    chatId: number,
): MediaItem | null {
    return normalize(message, chatId);
}

export async function loadMediaItem(
    chatId: number,
    messageId: number,
): Promise<MediaItem | null> {
    const [message] = await getClient().getMessages(chatId, messageId);
    if (!message) return null;
    return normalize(message, chatId);
}

/**
 * Rebuild a batch of media items from their message ids alone.
 *
 * This is what makes tag filtering possible. Our tags live in Laravel and
 * Telegram cannot search them, so the server answers with message ids and the
 * media itself is fetched here — one round trip for the whole page, and the two
 * halves never meet on a server.
 *
 * Messages that no longer exist, or that carry nothing `normalize()` can play,
 * are dropped rather than rendered as holes in the grid.
 *
 * Telegram takes at most 100 ids per request, which is why the server pages
 * these well under that.
 */
export async function loadMediaItems(
    chatId: number,
    messageIds: number[],
): Promise<MediaItem[]> {
    if (messageIds.length === 0) return [];

    const messages = await withFloodWait(() =>
        getClient().getMessages(chatId, messageIds),
    );

    // getMessages answers positionally, so this is already the order asked for
    // — but the grid's ordering is the server's, and reading it back out of the
    // ids rather than trusting the response keeps it that way if that changes.
    const byId = new Map<number, MediaItem>();
    for (const message of messages) {
        if (!message) continue;
        const item = normalize(message, chatId);
        if (item) byId.set(item.messageId, item);
    }

    // Messages that have since been deleted come back null, and anything with
    // no playable rendition is dropped by normalize(). Both leave the page
    // shorter than the ids asked for, which is correct: the tag outlives the
    // media, and a hole in the grid would be worse than a short page.
    return messageIds
        .map((id) => byId.get(id))
        .filter((item): item is MediaItem => item !== undefined);
}

export function getQualitySource(
    item: MediaItem,
    qualityId: string,
): QualitySource | undefined {
    return (
        qualitySources.get(qualityStoreKey(item.key, qualityId)) ??
        qualitySources.get(qualityStoreKey(item.key, item.quality.id))
    );
}

/** The kinds each category shows; `all` shows whatever normalize() accepts. */
const CATEGORY_KINDS: Record<MediaTypeFilter, MediaKind[] | null> = {
    all: null,
    photo: ['photo'],
    // Round video notes already normalize to 'video'; animations are 'gif'.
    video: ['video', 'gif'],
    audio: ['audio', 'voice'],
};

/**
 * The Telegram-side filter for a category.
 *
 * "You can't combine filters" is Telegram's own limitation, and every category
 * except photos spans more than one of them — video wants animations and round
 * notes too, audio wants voice. The alternatives were both worse: running one
 * search per filter and interleaving them breaks the single message-id cursor
 * the whole grid pages on, and picking one filter per category would silently
 * drop the others. So a spanning category searches unfiltered and the kinds are
 * matched here, on messages we already have to normalize anyway.
 */
function typeFilter(type: MediaTypeFilter) {
    return type === 'photo' ? SearchFilters.Photo : SearchFilters.Empty;
}

/**
 * How much of this category the chat holds.
 *
 * Telegram counts per filter, so a category that spans several is the sum of
 * their totals — asked for once, with `limit: 1`, and only for the first page.
 * The unfiltered search the pages come from cannot answer this: its total
 * counts every message in the chat, media or not.
 */
async function countCategory(
    chatId: number,
    type: MediaTypeFilter,
    query?: string,
): Promise<number> {
    const filters = COUNT_FILTERS[type];
    const tg = getClient();

    // One request for every filter at once. Search is the request Telegram
    // rate-limits hardest, and a count per filter spent four of them on each
    // chat opened, before a single tile — enough to earn a FLOOD_WAIT that
    // then held every search after it. Counters take no needle, so a typed
    // search still counts by searching.
    if (!query) {
        try {
            const counters = await withFloodWait(async () =>
                tg.call({
                    _: 'messages.getSearchCounters',
                    peer: await tg.resolvePeer(chatId),
                    filters,
                }),
            );
            return counters.reduce((sum, counter) => sum + counter.count, 0);
        } catch (error) {
            debug('media', 'search counters failed, counting by search', error);
        }
    }

    const totals = await Promise.all(
        filters.map((filter) =>
            withFloodWait(() =>
                tg
                    .searchMessages({ chatId, filter, query, limit: 1 })
                    .then((page) => page.total),
            ),
        ),
    );

    return totals.reduce((sum, total) => sum + total, 0);
}

/** Non-overlapping filters whose totals add up to a category's size. */
const COUNT_FILTERS: Record<
    MediaTypeFilter,
    (typeof SearchFilters)[keyof typeof SearchFilters][]
> = {
    all: [
        SearchFilters.PhotoAndVideo,
        SearchFilters.Gif,
        SearchFilters.Audio,
        SearchFilters.Voice,
    ],
    photo: [SearchFilters.Photo],
    video: [SearchFilters.Video, SearchFilters.Gif],
    audio: [SearchFilters.Audio, SearchFilters.Voice],
};

function matchesDuration(item: MediaItem, min?: number, max?: number): boolean {
    if (item.type === 'photo') return true;
    if (min === undefined && max === undefined) return true;
    const duration = item.duration ?? 0;
    if (min !== undefined && duration < min) return false;
    if (max !== undefined && duration > max) return false;
    return true;
}

function normalize(message: Message, chatId: number): MediaItem | null {
    const media = message.media;
    if (!media) return null;

    if (
        media.type !== 'photo' &&
        media.type !== 'video' &&
        media.type !== 'audio' &&
        media.type !== 'voice'
    ) {
        debug('media', 'unshowable media', {
            key: mediaKey(chatId, message.id),
            type: media.type,
            raw: message.raw._ === 'message' ? message.raw.media?._ : undefined,
        });
        return null;
    }

    if (media.type === 'photo') {
        sources.set(mediaKey(chatId, message.id), media);
        const key = mediaKey(chatId, message.id);
        const quality = pickBestQuality(collectPhotoQualities(key, media));
        if (!quality) return null;
        return {
            key,
            chatId,
            messageId: message.id,
            date: message.date.toISOString(),
            type: 'photo',
            width: media.width,
            height: media.height,
            fileSize: media.fileSize,
            mimeType: 'image/jpeg',
            caption: message.text || undefined,
            hasSpoiler: media.hasSpoiler,
            isContentProtected: message.isContentProtected,
            quality,
        };
    }

    if (media.type === 'video') {
        const type: MediaKind = media.isAnimation ? 'gif' : 'video';
        sources.set(mediaKey(chatId, message.id), media);
        const key = mediaKey(chatId, message.id);
        const quality = pickBestQuality(collectVideoQualities(key, media));
        if (!quality) return null;
        debug('media', 'video', {
            key,
            duration: media.duration,
            fromAlts: videoDuration(media),
            width: media.width,
            height: media.height,
            mime: media.mimeType,
            isAnimation: media.isAnimation,
            isRound: media.isRound,
            attr: media.attr._,
            thumbs: describeThumbs(media),
            alts: media.media?.altDocuments?.length ?? 0,
            cover: media.videoCover ? 'yes' : 'no',
        });
        return {
            key,
            chatId,
            messageId: message.id,
            date: message.date.toISOString(),
            type,
            width: media.width,
            height: media.height,
            duration: videoDuration(media) || undefined,
            streamable:
                media.attr._ === 'documentAttributeVideo'
                    ? Boolean(media.attr.supportsStreaming)
                    : undefined,
            fileSize: media.fileSize,
            mimeType: media.mimeType,
            fileName: media.fileName ?? undefined,
            caption: message.text || undefined,
            hasSpoiler: media.hasSpoiler,
            isContentProtected: message.isContentProtected,
            quality,
        };
    }

    if (media.type === 'audio' || media.type === 'voice') {
        const key = mediaKey(chatId, message.id);
        sources.set(key, media);
        return {
            key,
            chatId,
            messageId: message.id,
            date: message.date.toISOString(),
            type: media.type,
            width: 0,
            height: 0,
            duration: media.duration || undefined,
            fileSize: media.fileSize,
            mimeType: media.mimeType,
            fileName: media.fileName ?? undefined,
            audioTitle:
                media.type === 'audio' ? (media.title ?? undefined) : undefined,
            audioPerformer:
                media.type === 'audio'
                    ? (media.performer ?? undefined)
                    : undefined,
            caption: message.text || undefined,
            hasSpoiler: false,
            isContentProtected: message.isContentProtected,
            quality: collectAudioQuality(key, media),
        };
    }

    return null;
}

/**
 * The best small rendition published on a file, or null if there is none.
 *
 * Guarded because `.thumbnails` builds a Thumbnail per size and throws on the
 * ones mtcute refuses (`photoSizeEmpty`, `photoCachedSize`) — a ladder with one
 * bad rung would otherwise take down the whole tile rather than one thumbnail.
 */
function publishedThumb(source: MediaSource): Thumbnail | null {
    try {
        return (
            source.getThumbnail(Thumbnail.THUMB_320x320_BOX) ??
            source.getThumbnail(Thumbnail.THUMB_320x320_CROP) ??
            source.getThumbnail(Thumbnail.THUMB_100x100_BOX) ??
            source.thumbnails.find(
                (thumb) =>
                    !thumb.isVideo && thumb.type !== Thumbnail.THUMB_OUTLINE,
            ) ??
            null
        );
    } catch (error) {
        debug('thumb', 'unreadable thumbnail ladder', source.type, error);
        return null;
    }
}

/**
 * What Telegram actually published as previews for a source, for tracing.
 *
 * `.thumbnails` builds a Thumbnail per size and throws on the ones mtcute
 * refuses (`photoSizeEmpty`, `photoCachedSize`), so it is guarded: a source we
 * cannot describe is exactly the interesting case.
 */
function describeThumbs(source: MediaSource): string {
    try {
        return (
            source.thumbnails
                .map((thumb) => `${thumb.raw._}/${thumb.type}`)
                .join(' ') || 'none'
        );
    } catch (error) {
        return `unreadable: ${error instanceof Error ? error.message : String(error)}`;
    }
}

/**
 * The file to download for a grid tile, or null when there is nothing worth
 * downloading. `choosePreview()` holds the decision; this fetches whatever it
 * names.
 */
function pickThumb(source: MediaSource): Thumbnail | MediaSource | null {
    const thumbnail = publishedThumb(source);
    const cover = source.type === 'video' ? source.videoCover : null;

    const choice = choosePreview(source.type, {
        hasThumbnail: thumbnail !== null,
        hasCover: cover !== null,
    });

    debug('thumb', choice, {
        kind: source.type,
        thumbs: describeThumbs(source),
        type: thumbnail?.type,
    });

    switch (choice) {
        case 'thumbnail':
            return thumbnail;
        case 'cover':
            // The cover is a photo in its own right, so it has its own ladder —
            // and 200px of it is all a tile needs.
            return cover ? (publishedThumb(cover) ?? cover) : null;
        case 'source':
            return source;
        case 'none':
            return null;
    }
}

async function refreshSource(item: MediaItem): Promise<MediaSource> {
    const [message] = await getClient().getMessages(
        item.chatId,
        item.messageId,
    );
    if (!message) throw new Error('Telegram no longer has this message.');
    const next = normalize(message, item.chatId);
    const source = next ? sources.get(next.key) : undefined;
    if (!source) throw new Error('That message is no longer media.');
    return source;
}

async function downloadSource(
    _item: MediaItem,
    source: MediaSource,
    kind: 'thumb' | 'full',
    onProgress?: (downloaded: number, total: number) => void,
    signal?: AbortSignal,
): Promise<Uint8Array> {
    const location = kind === 'thumb' ? pickThumb(source) : source;
    if (!location) throw new Error('No file to download.');

    if (kind === 'thumb') {
        return withFloodWait(() =>
            getClient().downloadAsBuffer(location, { abortSignal: signal }),
        );
    }

    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of getClient().downloadAsIterable(location, {
        progressCallback: onProgress,
        abortSignal: signal,
    })) {
        chunks.push(chunk);
        size += chunk.byteLength;
    }
    const out = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return out;
}

async function downloadWithRefresh(
    item: MediaItem,
    kind: 'thumb' | 'full',
    onProgress?: (downloaded: number, total: number) => void,
    signal?: AbortSignal,
): Promise<Uint8Array> {
    let source = sources.get(item.key);
    if (!source) source = await refreshSource(item);
    try {
        return await downloadSource(item, source, kind, onProgress, signal);
    } catch (error) {
        if (!isFileRefError(error)) throw error;
        source = await refreshSource(item);
        return downloadSource(item, source, kind, onProgress, signal);
    }
}

function orientMessages(messages: Message[], order: MediaOrder) {
    if (messages.length < 2) return messages;
    const ascending = messages[0].id < messages[messages.length - 1].id;
    if (order === 'old') return ascending ? messages : [...messages].reverse();
    return ascending ? [...messages].reverse() : messages;
}

/**
 * Messages per search: Telegram's maximum. "All", video and audio search the
 * whole chat unfiltered and keep the media, so in a talkative chat every
 * round trip counts — a bigger page is fewer of them.
 */
const SEARCH_LIMIT = 100;

/**
 * Items one page of the grid holds, first page or later.
 *
 * A page stops at exactly this many, with its cursor on the last item kept,
 * so scrolling asks for the next few rather than whatever a 100-message search
 * happened to turn up — and reading oldest first no longer runs ahead.
 */
const PAGE_SIZE = 18;

export async function searchChatMedia(
    params: MediaSearchParams,
): Promise<MediaPage> {
    const tg = getClient();
    const collected: MediaItem[] = [];
    const order: MediaOrder = params.order === 'old' ? 'old' : 'new';
    const first = order === 'old' ? 1 : 0;
    let offset = params.offset ?? first;
    let nextOffset: number | undefined;
    let pages = 0;
    const seen = new Set<string>();
    const kinds = CATEGORY_KINDS[params.type];

    // Counted once, alongside the first page rather than after it, and only
    // there: the grid reads the total off page one and never looks again.
    const counting =
        offset === first
            ? countCategory(params.chatId, params.type, params.query)
            : Promise.resolve(0);

    while (collected.length < PAGE_SIZE && pages < 8) {
        const cursor = offset;
        // The very first page starts at message 1, which is itself in range.
        const floor = cursor === first ? cursor - 1 : cursor;
        const page = await withFloodWait(() =>
            tg.searchMessages({
                chatId: params.chatId,
                filter: typeFilter(params.type),
                // Telegram searches the message itself — caption, filename,
                // audio tags — so the needle never has to be matched here and
                // the chat's whole history is in scope, not the loaded pages.
                query: params.query || undefined,
                offset: cursor,
                addOffset: order === 'old' ? -SEARCH_LIMIT : 0,
                limit: SEARCH_LIMIT,
            }),
        );
        if (page.length === 0) {
            nextOffset = undefined;
            break;
        }

        // Only what lies strictly past the cursor. Read oldest first,
        // Telegram's window can hand back the cursor message itself (or
        // older ones), and taking those as progress walked the chat a
        // message at a time, page after page.
        const messages = orientMessages([...page], order).filter((message) =>
            order === 'old'
                ? message.id > floor
                : cursor === 0 || message.id < cursor,
        );
        debug('media', 'page', {
            chatId: params.chatId,
            type: params.type,
            offset: cursor,
            got: messages.length,
            total: page.total,
        });

        let stopped: number | undefined;
        for (const message of messages) {
            const item = normalize(message, params.chatId);
            if (!item || seen.has(item.key)) continue;
            seen.add(item.key);
            if (kinds && !kinds.includes(item.type)) continue;
            if (
                !matchesDuration(item, params.minDuration, params.maxDuration)
            ) {
                continue;
            }
            collected.push(item);
            if (collected.length === PAGE_SIZE) {
                // Full: the next page picks up right after this message.
                stopped = message.id;
                break;
            }
        }

        if (stopped !== undefined) {
            nextOffset = stopped;
            break;
        }

        const last = messages[messages.length - 1];
        if (!last || page.length < SEARCH_LIMIT) {
            // Nothing past the cursor, or the end of the chat.
            nextOffset = undefined;
            break;
        }
        nextOffset = last.id;
        offset = last.id;
        pages += 1;
    }

    return { items: collected, nextOffset, total: await counting };
}

/**
 * How many tile downloads run at once.
 *
 * Without a cap, a fast scroll through a big chat put hundreds of downloads on
 * the wire at the same moment, and the row actually on screen waited behind
 * every row that had flown past.
 */
const THUMB_CONCURRENCY = 6;

type ThumbJob = { run: () => void; signal?: AbortSignal };

let thumbsRunning = 0;
/** Newest last: the queue is served from the end, so what was asked for most
 * recently — the tiles in view right now — goes first. */
const thumbQueue: ThumbJob[] = [];

function pumpThumbs() {
    while (thumbsRunning < THUMB_CONCURRENCY && thumbQueue.length > 0) {
        const job = thumbQueue.pop();
        if (!job || job.signal?.aborted) continue;
        thumbsRunning += 1;
        job.run();
    }
}

function scheduleThumb<T>(
    work: () => Promise<T>,
    signal?: AbortSignal,
): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const job: ThumbJob = {
            signal,
            run: () => {
                work()
                    .then(resolve, reject)
                    .finally(() => {
                        thumbsRunning -= 1;
                        pumpThumbs();
                    });
            },
        };
        signal?.addEventListener(
            'abort',
            () => {
                const at = thumbQueue.indexOf(job);
                if (at !== -1) thumbQueue.splice(at, 1);
                reject(new DOMException('Aborted', 'AbortError'));
            },
            { once: true },
        );
        thumbQueue.push(job);
        pumpThumbs();
    });
}

/** Tile downloads already under way, so a remount shares one instead of two. */
const thumbsInFlight = new Map<string, Promise<string | null>>();

/**
 * The tile image for an item, from memory, then disk, then Telegram.
 *
 * `signal` is the tile leaving the screen. A download that has not started yet
 * is dropped from the queue; one already on the wire is left to finish, since
 * the bytes are moments away and will be wanted again on the way back.
 */
export async function downloadThumb(
    item: MediaItem,
    signal?: AbortSignal,
): Promise<string | null> {
    const cacheKey = `thumb:${item.key}`;
    const cached = blobCache.get(cacheKey);
    if (cached) return cached;

    const stored = await readThumb(item.key);
    if (stored) return blobCache.put(cacheKey, stored, 'image/jpeg');

    const already = thumbsInFlight.get(cacheKey);
    if (already) return already;
    if (signal?.aborted) return null;

    const run = scheduleThumb(async () => {
        const bytes = await downloadWithRefresh(item, 'thumb');
        void writeThumb(item.key, bytes, 'image/jpeg');
        return blobCache.put(cacheKey, bytes, 'image/jpeg');
    }, signal)
        .catch((error: unknown) => {
            if (!isAbortError(error)) {
                debug('thumb', 'download failed', item.key, item.type, error);
            }
            return null;
        })
        .finally(() => thumbsInFlight.delete(cacheKey));
    thumbsInFlight.set(cacheKey, run);
    return run;
}

/**
 * The tiny preview Telegram ships inside the message itself, or null.
 *
 * Telegram embeds a ~40px "stripped" JPEG in most photos and videos so a client
 * has something to paint before any download. It costs no network at all, so
 * a tile can show a blurred impression of its picture the instant it mounts.
 */
export function inlinePreview(item: MediaItem): string | null {
    const cacheKey = `strip:${item.key}`;
    const cached = blobCache.get(cacheKey);
    if (cached) return cached;
    const source = sources.get(item.key);
    if (!source) return null;
    try {
        const strip = source.getThumbnail(Thumbnail.THUMB_STRIP);
        const bytes = strip?.location;
        if (!(bytes instanceof Uint8Array)) return null;
        return blobCache.put(cacheKey, bytes, 'image/jpeg');
    } catch {
        return null;
    }
}

/**
 * Artwork for a sound file, falling back to the chat's own avatar.
 *
 * Voice notes never carry a thumbnail and plenty of music does not either, so
 * without this the grid is a wall of identical glyphs. The avatar at least
 * says who it came from. Loaded through a dynamic import to keep the dialog
 * module out of anything that only wants media.
 */
export async function downloadSoundArt(
    item: MediaItem,
    signal?: AbortSignal,
): Promise<string | null> {
    const cover = await downloadThumb(item, signal);
    if (cover) return cover;
    if (signal?.aborted) return null;

    try {
        const { downloadAvatar } = await import('@/lib/telegram/dialogs');
        return await downloadAvatar(item.chatId);
    } catch {
        return null;
    }
}

export async function downloadFull(
    item: MediaItem,
    onProgress?: (downloaded: number, total: number) => void,
    signal?: AbortSignal,
): Promise<string> {
    const cacheKey = `full:${item.key}`;
    const cached = blobCache.get(cacheKey, 'full');
    if (cached) return cached;
    const bytes = await downloadWithRefresh(item, 'full', onProgress, signal);
    return blobCache.put(
        cacheKey,
        bytes,
        item.mimeType ?? 'application/octet-stream',
        'full',
    );
}

/**
 * The bytes of one item, chunk by chunk, for an export to write as it goes.
 *
 * Deliberately outside `blobCache`. That cache holds six full-size entries and
 * revokes an object URL the moment a seventh arrives, which is right for a
 * viewer showing one thing at a time and ruinous for a run that writes a
 * thousand files: every one of them would be buffered whole in memory and then
 * thrown away. Nothing is retained here — each chunk is handed to the caller
 * and dropped.
 *
 * This does not retry. A file reference that expires mid-download cannot be
 * patched over from inside a generator, because the bytes already yielded are
 * gone. The caller refreshes the item and streams it again from the start; a
 * sink built on `createWritable()` commits only on close, so the abandoned
 * attempt leaves nothing behind to splice.
 */
export async function* streamMediaBytes(
    item: MediaItem,
    onProgress?: (downloaded: number, total: number) => void,
    signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
    let source = sources.get(item.key);
    if (!source) source = await refreshSource(item);

    for await (const chunk of getClient().downloadAsIterable(source, {
        progressCallback: onProgress,
        abortSignal: signal,
    })) {
        yield chunk;
    }
}

export async function downloadQuality(
    item: MediaItem,
    qualityId: string,
    onProgress?: (downloaded: number, total: number) => void,
    signal?: AbortSignal,
): Promise<string> {
    const source = getQualitySource(item, qualityId);
    if (!source) return downloadFull(item, onProgress, signal);
    const cacheKey = `full:${item.key}:${qualityId}`;
    const cached = blobCache.get(cacheKey, 'full');
    if (cached) return cached;
    const bytes = await withFloodWait(() =>
        getClient().downloadAsBuffer(source.file, {
            progressCallback: onProgress,
            abortSignal: signal,
        }),
    );
    return blobCache.put(
        cacheKey,
        bytes,
        item.mimeType ?? 'application/octet-stream',
        'full',
    );
}
