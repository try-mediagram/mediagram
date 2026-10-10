import { blobCache } from '@/lib/blob-cache';
import { debug } from '@/lib/debug';
import type { MediaItem } from '@/lib/telegram/types';

/**
 * A first frame and a running time for a video Telegram published neither for.
 *
 * Plenty of channels are filled by scripts that call `sendVideo` without a
 * thumbnail and without measuring the file, and Telegram stores exactly what it
 * was given: `thumbs` empty, `documentAttributeVideo.duration` zero, no alt
 * renditions to borrow either. There is no second copy of that information on
 * the server — so a grid of such a chat is a wall of blank squares each labelled
 * "Video", and no amount of asking Telegram differently changes it.
 *
 * The file itself still knows. This points a detached `<video preload="metadata">`
 * at the same `/progressive/*` bridge the player uses, lets the browser's own
 * demuxer range-request the few hundred KB it needs for the header and one
 * frame, and reads the answers off the element. Nothing is downloaded whole and
 * nothing reaches Laravel, which is the same bargain playback already makes.
 *
 * It is deliberately the *last* resort. `pickThumb()` is asked first and this
 * only runs when it comes back with nothing, so a chat whose uploader did the
 * normal thing never opens a stream to paint a tile.
 */
export type Poster = {
    /** Object URL of the decoded frame, or null if it could not be decoded. */
    url: string | null;
    /** Seconds, or null when the file did not say either. */
    duration: number | null;
};

const EMPTY: Poster = { url: null, duration: null };

/** How long to wait on one file before giving the tile back its glyph. */
const TIMEOUT_MS = 20_000;

/** The longest edge of the frame we keep. A tile is never bigger than this. */
const MAX_EDGE = 320;

/**
 * How many files may be decoded at once.
 *
 * Every one of these holds a progressive stream open and a decoder with it, and
 * a screenful of a thumbnail-less chat is forty tiles asking at the same moment.
 * Two at a time keeps the visible rows moving without queueing forty MTProto
 * downloads behind them.
 */
const MAX_CONCURRENT = 2;

let running = 0;
const waiting: Array<() => void> = [];

async function takeSlot(): Promise<void> {
    if (running < MAX_CONCURRENT) {
        running += 1;
        return;
    }
    await new Promise<void>((resolve) => waiting.push(resolve));
    running += 1;
}

function releaseSlot(): void {
    running -= 1;
    waiting.shift()?.();
}

/**
 * What we learned about a file, kept so a tile scrolled out of view and back
 * does not decode it twice. The frame itself lives in `blobCache`, which owns
 * every object URL in the app; this only remembers the numbers.
 */
const measured = new Map<string, number | null>();

/**
 * Decodes already under way, keyed by item.
 *
 * The cache is only populated at the end, so two tiles asking for the same file
 * at once — the grid and the viewer, or a remount — both missed it and opened
 * two streams for one video. They share this promise instead.
 */
const inFlight = new Map<string, Promise<Poster>>();

function posterKey(item: MediaItem) {
    return `poster:${item.key}`;
}

/**
 * Wait for one of a video element's events, or give up.
 *
 * `error` is listened for alongside the event actually wanted, because a file
 * the browser cannot demux never fires anything else and the timeout would be
 * the only thing left to notice it.
 */
function settle(video: HTMLVideoElement, event: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(() => {
            cleanup();
            reject(new Error(`Timed out waiting for ${event}.`));
        }, TIMEOUT_MS);

        const done = () => {
            cleanup();
            resolve();
        };
        const failed = () => {
            cleanup();
            reject(new Error(`The browser could not decode this video.`));
        };

        function cleanup() {
            window.clearTimeout(timer);
            video.removeEventListener(event, done);
            video.removeEventListener('error', failed);
        }

        video.addEventListener(event, done, { once: true });
        video.addEventListener('error', failed, { once: true });
    });
}

/**
 * Where to take the frame from.
 *
 * The very first frame of a video is often a fade from black, which makes a
 * grid of them look broken in a different way. A little way in is more likely
 * to show what the video is of, and staying under a second keeps the demuxer
 * inside the part of the file it has already fetched for the header.
 */
function frameAt(duration: number): number {
    if (!Number.isFinite(duration) || duration <= 0) return 0;
    return Math.min(duration / 2, 1);
}

function drawFrame(video: HTMLVideoElement): Promise<Blob | null> {
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) return Promise.resolve(null);

    const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));

    const context = canvas.getContext('2d');
    if (!context) return Promise.resolve(null);
    context.drawImage(video, 0, 0, canvas.width, canvas.height);

    return new Promise((resolve) => {
        canvas.toBlob((blob) => resolve(blob), 'image/jpeg', 0.72);
    });
}

/**
 * Decode a frame and a duration out of the file, or answer with what little
 * could be read.
 *
 * A failure here is never fatal: the tile keeps its glyph and its "Video"
 * label, exactly as it did before. That is why every step is allowed to come
 * back empty rather than throw outward.
 */
export async function generatePoster(item: MediaItem): Promise<Poster> {
    if (item.type !== 'video' && item.type !== 'gif') return EMPTY;

    const cachedUrl = blobCache.get(posterKey(item));
    if (cachedUrl || measured.has(item.key)) {
        return {
            url: cachedUrl ?? null,
            duration: measured.get(item.key) ?? null,
        };
    }

    const already = inFlight.get(item.key);
    if (already) return already;

    const run = decodePoster(item).finally(() => inFlight.delete(item.key));
    inFlight.set(item.key, run);
    return run;
}

async function decodePoster(item: MediaItem): Promise<Poster> {
    await takeSlot();

    const video = document.createElement('video');
    let streamOpen = false;
    let progressive: typeof import('@/lib/telegram/progressive') | null = null;

    try {
        progressive = await import('@/lib/telegram/progressive');
        const src = await progressive.openProgressiveStream(
            item,
            item.quality.id,
        );
        streamOpen = true;

        video.preload = 'metadata';
        video.muted = true;
        video.playsInline = true;
        // Never in the document: this is a decoder, not a picture. Appending it
        // would lay out a 320px video over the grid for as long as it took.
        video.src = src;

        await settle(video, 'loadedmetadata');

        const duration =
            Number.isFinite(video.duration) && video.duration > 0
                ? video.duration
                : null;
        measured.set(item.key, duration);

        // `seeked` is what says the frame is actually there to draw. Seeking to
        // 0 on a file already at 0 fires nothing, so that case waits on the
        // frame data instead.
        const at = frameAt(video.duration);
        if (at > 0) {
            video.currentTime = at;
            await settle(video, 'seeked');
        } else if (video.readyState < 2) {
            await settle(video, 'loadeddata');
        }

        const blob = await drawFrame(video);
        if (!blob) {
            debug('poster', 'no frame decoded', item.key);
            return { url: null, duration };
        }

        const bytes = new Uint8Array(await blob.arrayBuffer());
        const url = blobCache.put(posterKey(item), bytes, 'image/jpeg');
        debug('poster', 'decoded', { key: item.key, duration });
        return { url, duration };
    } catch (error) {
        debug('poster', 'failed', item.key, error);
        // Remember the failure as "nothing to say" so a tile scrolling back and
        // forth does not re-open the stream every time.
        if (!measured.has(item.key)) measured.set(item.key, null);
        return EMPTY;
    } finally {
        video.removeAttribute('src');
        video.load();
        if (streamOpen && progressive) {
            progressive.closeProgressiveStream(item, item.quality.id);
        }
        releaseSlot();
    }
}
