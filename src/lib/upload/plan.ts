/**
 * What a bulk upload will actually send, worked out before anything leaves.
 *
 * Pure on purpose — no imports — so it reads under `node --test` the way
 * chat-target.ts and reactions.ts do. Grouping, captioning and the limits are
 * all decidable from metadata, and they are where the mistakes live: an album
 * of eleven is rejected outright by Telegram, and a photo sent under the wrong
 * type arrives as a file attachment nobody can look at.
 */

/** Where the text goes. */
export type CaptionMode =
    /** Send the files bare. */
    | 'none'
    /** One caption, carried by every message. */
    | 'shared'
    /** Its own caption per file. */
    | 'each';

export type Delivery =
    /** Group them, the way dragging a folder into Telegram does. */
    | 'album'
    /** One message per file. */
    | 'separate';

/**
 * How Telegram is told to treat the file.
 *
 * Never `auto`: mtcute's own note is that a newly uploaded file sent as `auto`
 * goes up as a *document*, so a holiday photo arrives as an attachment with a
 * paperclip rather than a picture. The kind is chosen here instead.
 */
export type SendKind = 'photo' | 'video' | 'audio' | 'document';

/**
 * What may share an album.
 *
 * Telegram groups photos with videos, documents with documents and audio with
 * audio, and refuses a group that mixes those families.
 */
export type MediaClass = 'visual' | 'audio' | 'document';

/** A file the reader picked. A `File` satisfies this structurally. */
export type PickedFile = {
    id: string;
    name: string;
    size: number;
    /** The browser's mime type, which may be empty for an unknown extension. */
    type: string;
};

export type PlannedItem = {
    fileId: string;
    kind: SendKind;
    caption?: string;
};

export type PlannedBatch = {
    /** More than one is an album; exactly one is an ordinary message. */
    items: PlannedItem[];
};

export type PlanIssue =
    | { kind: 'too-large'; fileId: string; limit: number }
    | { kind: 'caption-too-long'; fileId: string | null; limit: number }
    | { kind: 'empty' };

export type UploadPlan = {
    batches: PlannedBatch[];
    issues: PlanIssue[];
    /** Files that will be sent. */
    files: number;
    bytes: number;
    /** Messages that will appear in the chat. An album counts once. */
    messages: number;
    /** True when something must be fixed before sending. */
    blocked: boolean;
};

export type UploadPlanInput = {
    files: readonly PickedFile[];
    captionMode: CaptionMode;
    sharedCaption: string;
    /** Per-file captions, by file id. Only read when the mode is `each`. */
    captions: Readonly<Record<string, string>>;
    delivery: Delivery;
};

/** Telegram takes at most ten media in one group. */
export const ALBUM_MAX = 10;

/** Caption length for an account without Premium. */
export const CAPTION_MAX = 1024;

/** Upload size for an account without Premium, in bytes. */
export const FILE_MAX = 2 * 1024 * 1024 * 1024;

/**
 * The most message ids one bulk tag request may carry.
 *
 * Matches `BULK_LIMIT` in `MediaTagController`, which is itself tied to the
 * chip lookup's ceiling. An upload run has no such ceiling — a folder of two
 * thousand files is one run — so the ids are chunked before they are sent
 * rather than trusted to fit.
 */
export const TAG_BULK_MAX = 500;

const IMAGE = /^image\//;
const VIDEO = /^video\//;
const AUDIO = /^audio\//;

/**
 * What to send a file as.
 *
 * A GIF goes as a document deliberately: Telegram turns an uploaded `.gif`
 * into a silent mp4 animation on its own, and forcing it through the photo or
 * video path is what loses the animation.
 */
export function sendKindFor(file: PickedFile): SendKind {
    const mime = file.type.split(';')[0].trim().toLowerCase();

    if (mime === 'image/gif') return 'document';
    if (IMAGE.test(mime)) return 'photo';
    if (VIDEO.test(mime)) return 'video';
    if (AUDIO.test(mime)) return 'audio';

    // An unknown mime is common — a browser reports "" for plenty of
    // extensions — so fall back to the name rather than giving up.
    const extension = /\.([a-z0-9]+)$/i.exec(file.name)?.[1]?.toLowerCase();
    if (!extension) return 'document';
    if (['jpg', 'jpeg', 'png', 'webp', 'heic', 'bmp'].includes(extension)) {
        return 'photo';
    }
    if (['mp4', 'mov', 'webm', 'mkv', 'm4v'].includes(extension)) {
        return 'video';
    }
    if (['mp3', 'm4a', 'flac', 'wav', 'ogg', 'opus'].includes(extension)) {
        return 'audio';
    }
    return 'document';
}

export function mediaClassOf(kind: SendKind): MediaClass {
    if (kind === 'photo' || kind === 'video') return 'visual';
    if (kind === 'audio') return 'audio';
    return 'document';
}

function chunk<T>(items: T[], size: number): T[][] {
    const out: T[][] = [];
    for (let at = 0; at < items.length; at += size) {
        out.push(items.slice(at, at + size));
    }
    return out;
}

/**
 * Cut a run's landed message ids into requests the bulk tag endpoint accepts.
 *
 * Here rather than in `send.ts` so it is testable: `plan.ts` imports nothing
 * and runs under `node --test`, and off-by-one in a chunker is exactly the
 * kind of thing that only shows up on the one upload big enough to need it.
 */
export function chunkMessageIds(
    messageIds: readonly number[],
    size: number = TAG_BULK_MAX,
): number[][] {
    return chunk([...messageIds], Math.max(1, size));
}

/**
 * Work out the messages a selection will become.
 *
 * Files too large to upload are dropped from the plan and reported, because
 * one oversized video should not stop the other nine from going. A caption
 * that is too long blocks instead: it is text the reader can shorten, and
 * silently truncating someone's words is not ours to do.
 */
export function planUpload(input: UploadPlanInput): UploadPlan {
    const issues: PlanIssue[] = [];

    const sendable = input.files.filter((file) => {
        if (file.size > FILE_MAX) {
            issues.push({
                kind: 'too-large',
                fileId: file.id,
                limit: FILE_MAX,
            });
            return false;
        }
        return true;
    });

    if (sendable.length === 0) {
        if (input.files.length === 0) issues.push({ kind: 'empty' });
        return {
            batches: [],
            issues,
            files: 0,
            bytes: 0,
            messages: 0,
            blocked: true,
        };
    }

    if (
        input.captionMode === 'shared' &&
        input.sharedCaption.length > CAPTION_MAX
    ) {
        issues.push({
            kind: 'caption-too-long',
            fileId: null,
            limit: CAPTION_MAX,
        });
    }

    if (input.captionMode === 'each') {
        for (const file of sendable) {
            const caption = input.captions[file.id] ?? '';
            if (caption.length > CAPTION_MAX) {
                issues.push({
                    kind: 'caption-too-long',
                    fileId: file.id,
                    limit: CAPTION_MAX,
                });
            }
        }
    }

    const groups =
        input.delivery === 'separate'
            ? sendable.map((file) => [file])
            : groupForAlbums(sendable);

    const batches: PlannedBatch[] = groups.map((group) => ({
        items: group.map((file, index) => ({
            fileId: file.id,
            kind: sendKindFor(file),
            caption: captionFor(input, file, index),
        })),
    }));

    return {
        batches,
        issues,
        files: sendable.length,
        bytes: sendable.reduce((total, file) => total + file.size, 0),
        messages: batches.length,
        blocked: issues.some((issue) => issue.kind !== 'too-large'),
    };
}

/**
 * Bucket by what Telegram will let share a group, then cut at ten.
 *
 * Order inside a family is the order they were picked. The families come out
 * in the order they first appear, so a selection of photos followed by a PDF
 * does not put the PDF first.
 */
function groupForAlbums(files: readonly PickedFile[]): PickedFile[][] {
    const buckets = new Map<MediaClass, PickedFile[]>();

    for (const file of files) {
        const family = mediaClassOf(sendKindFor(file));
        const bucket = buckets.get(family);
        if (bucket) bucket.push(file);
        else buckets.set(family, [file]);
    }

    return [...buckets.values()].flatMap((bucket) => chunk(bucket, ALBUM_MAX));
}

/**
 * The text one item carries.
 *
 * A shared caption goes on the first item of each batch and nowhere else.
 * Telegram renders an album's caption from the single item that has one, so
 * repeating it across ten photos would show it ten times.
 */
function captionFor(
    input: UploadPlanInput,
    file: PickedFile,
    indexInBatch: number,
): string | undefined {
    if (input.captionMode === 'none') return undefined;

    if (input.captionMode === 'shared') {
        if (indexInBatch !== 0) return undefined;
        return input.sharedCaption.trim() || undefined;
    }

    return input.captions[file.id]?.trim() || undefined;
}
