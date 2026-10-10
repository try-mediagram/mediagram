/**
 * What goes into an export, and what each file is called.
 *
 * Pure on purpose — no imports — so it reads under `node --test` the way
 * chat-target.ts and reactions.ts do. Everything here is string and predicate
 * work over metadata; the half that talks to Telegram lives in run.ts.
 *
 * The types are declared rather than imported for the same reason. `MediaItem`
 * satisfies `ExportEntry` structurally, so the runtime passes its own items
 * straight in without a conversion step.
 */

export type ExportMediaKind = 'photo' | 'video' | 'gif' | 'audio' | 'voice';

/** Every kind an export can currently write. See `unsupported` in run.ts. */
export const EXPORTABLE_KINDS: readonly ExportMediaKind[] = [
    'photo',
    'video',
    'gif',
    'audio',
    'voice',
];

/**
 * The fields an export needs off a piece of media.
 *
 * A `MediaItem` has all of these and more, so it is assignable here as-is.
 */
export type ExportEntry = {
    messageId: number;
    /** ISO 8601, the way `MediaItem.date` is already written. */
    date: string;
    type: ExportMediaKind;
    fileName?: string;
    mimeType?: string;
    fileSize?: number;
    audioTitle?: string;
    audioPerformer?: string;
};

export type ExportSelection = {
    /** Which kinds the dialog asked for. Empty means none. */
    kinds: readonly ExportMediaKind[];
    /** Inclusive lower bound as `YYYY-MM-DD`, or absent for no bound. */
    since?: string;
    /** Inclusive upper bound as `YYYY-MM-DD`, or absent for no bound. */
    until?: string;
};

/** Why an entry is not being written, for the transcript to report. */
export type SkipReason = 'filtered' | 'unsupported';

export type Skipped = {
    entry: ExportEntry;
    reason: SkipReason;
};

export type Selection = {
    included: ExportEntry[];
    skipped: Skipped[];
};

/**
 * Names Windows refuses whatever the extension, plus the device names that
 * still resolve inside a folder. A file called `con.jpg` cannot be created.
 */
const RESERVED = new Set([
    'con',
    'prn',
    'aux',
    'nul',
    'com1',
    'com2',
    'com3',
    'com4',
    'com5',
    'com6',
    'com7',
    'com8',
    'com9',
    'lpt1',
    'lpt2',
    'lpt3',
    'lpt4',
    'lpt5',
    'lpt6',
    'lpt7',
    'lpt8',
    'lpt9',
]);

const MAX_SEGMENT = 60;

/**
 * Control characters become spaces.
 *
 * Done by code point rather than by regex because a character class spanning
 * the control range is exactly what `no-control-regex` exists to catch, and
 * the escape form trips it just the same. This says the intent plainly.
 */
function stripControl(value: string): string {
    let out = '';
    for (const char of value) {
        const code = char.codePointAt(0) ?? 0;
        out += code < 0x20 || code === 0x7f ? ' ' : char;
    }
    return out;
}

/**
 * One path segment a filesystem will actually accept.
 *
 * Deliberately strict rather than clever: separators, control characters and
 * the characters Windows reserves all become spaces and then hyphens, runs
 * collapse, and the result is capped. An export folder is written to whatever
 * disk the reader chose, and a name that works on one and throws on another is
 * worse than a plain one that works everywhere.
 */
export function sanitizeSegment(value: string, fallback = 'chat'): string {
    const cleaned = stripControl(value)
        .replace(/[\\/:*?"<>|]/g, ' ')
        .trim()
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        // A leading dot hides the file; a trailing dot or space is stripped by
        // Windows on create, which turns two distinct names into one.
        .replace(/^[.-]+/, '')
        .replace(/[.\-\s]+$/, '')
        .slice(0, MAX_SEGMENT)
        .replace(/[.\-\s]+$/, '');

    if (!cleaned) return fallback;
    if (RESERVED.has(cleaned.toLowerCase())) return `${cleaned}-file`;
    return cleaned;
}

/** `YYYY-MM-DD` in the reader's own timezone, which is the date they mean. */
export function localDateStamp(at: Date): string {
    const year = at.getFullYear();
    const month = String(at.getMonth() + 1).padStart(2, '0');
    const day = String(at.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

/** The folder an export is written into: `export-<chat>-<date>`. */
export function exportFolderName(title: string, at: Date): string {
    return `export-${sanitizeSegment(title)}-${localDateStamp(at)}`;
}

const MIME_EXTENSIONS: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/heic': 'heic',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'video/quicktime': 'mov',
    'video/x-matroska': 'mkv',
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/mp4': 'm4a',
    'audio/x-m4a': 'm4a',
    'audio/ogg': 'ogg',
    'audio/opus': 'opus',
    'audio/flac': 'flac',
    'audio/x-flac': 'flac',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
};

/** What to write when Telegram says nothing useful about the file. */
const KIND_EXTENSIONS: Record<ExportMediaKind, string> = {
    photo: 'jpg',
    video: 'mp4',
    // Telegram's "gif" is a silent mp4, not a GIF89a.
    gif: 'mp4',
    audio: 'mp3',
    voice: 'ogg',
};

/**
 * The trailing `.xyz` of a filename, when it really is an extension.
 *
 * At least one letter is required, which is what separates `clip.mp4` from
 * `clip.from.2019`. A bare number after a dot is part of the name — treating
 * it as the extension both mangles the name and writes a file nothing opens.
 */
function extensionFromName(fileName: string | undefined): string | null {
    const match = /\.([a-z0-9]{1,8})$/i.exec(fileName ?? '');
    if (!match || !/[a-z]/i.test(match[1])) return null;
    return match[1].toLowerCase();
}

/**
 * The extension to write, most trustworthy source first.
 *
 * The sender's own filename wins: it is the only one that knows an `.mkv` from
 * the `.mp4` its mime type claims. The mime type is next, and the kind is the
 * floor — every branch returns something, because a file with no extension is
 * one the reader's system will not open.
 */
export function extensionFor(entry: ExportEntry): string {
    const fromName = extensionFromName(entry.fileName);
    if (fromName) return fromName;

    const mime = entry.mimeType?.split(';')[0].trim().toLowerCase();
    if (mime && MIME_EXTENSIONS[mime]) return MIME_EXTENSIONS[mime];

    return KIND_EXTENSIONS[entry.type] ?? 'bin';
}

/** The descriptive middle of a filename, before it is sanitised. */
function describe(entry: ExportEntry): string {
    if (entry.fileName) {
        // Strip only what `extensionFor` actually took, so a name ending in a
        // year keeps it.
        const base = extensionFromName(entry.fileName)
            ? entry.fileName.replace(/\.[a-z0-9]{1,8}$/i, '')
            : entry.fileName;
        if (base.trim()) return base;
    }

    const performer = entry.audioPerformer?.trim();
    const title = entry.audioTitle?.trim();
    if (title) return performer ? `${performer} - ${title}` : title;

    return entry.type;
}

/**
 * What one file is called inside `media/`.
 *
 * The message id leads, zero-padded, so names are unique without a counter and
 * a plain alphabetical listing is the chat's own order. Telegram gives every
 * item in an album its own message, so there is no case where two files share
 * an id.
 */
export function mediaFileName(entry: ExportEntry): string {
    const id = String(entry.messageId).padStart(7, '0');
    const label = sanitizeSegment(describe(entry), entry.type);
    return `${id}-${label}.${extensionFor(entry)}`;
}

/** Where that file sits relative to the export folder. */
export function mediaFilePath(entry: ExportEntry): string {
    return `media/${mediaFileName(entry)}`;
}

/**
 * The calendar day an entry belongs to, in the reader's timezone.
 *
 * Compared as `YYYY-MM-DD` strings rather than as instants: the dialog asks
 * for days, and a day is what someone picking "up to the 3rd" means, not
 * midnight UTC on the 3rd.
 */
function dayOf(entry: ExportEntry): string {
    const at = new Date(entry.date);
    if (Number.isNaN(at.getTime())) return '';
    return localDateStamp(at);
}

/**
 * Split what was scanned into what will be written and what will not.
 *
 * Telegram's noforwards flag is not consulted: protected chats export like any
 * other, the same way the lightbox downloads from them.
 */
export function selectForExport(
    entries: readonly ExportEntry[],
    selection: ExportSelection,
): Selection {
    const kinds = new Set(selection.kinds);
    const included: ExportEntry[] = [];
    const skipped: Skipped[] = [];

    for (const entry of entries) {
        if (!EXPORTABLE_KINDS.includes(entry.type)) {
            skipped.push({ entry, reason: 'unsupported' });
            continue;
        }

        if (!kinds.has(entry.type)) {
            skipped.push({ entry, reason: 'filtered' });
            continue;
        }

        const day = dayOf(entry);
        if (selection.since && day && day < selection.since) {
            skipped.push({ entry, reason: 'filtered' });
            continue;
        }
        if (selection.until && day && day > selection.until) {
            skipped.push({ entry, reason: 'filtered' });
            continue;
        }

        included.push(entry);
    }

    return { included, skipped };
}

/**
 * What the dialog prints before anyone commits to a download.
 *
 * `bytes` is a floor, not a promise: Telegram does not publish a size for
 * every rendition, so an item without one contributes nothing. `partial` is
 * what lets the dialog say "at least" instead of quietly understating.
 */
export function summarize(entries: readonly ExportEntry[]): {
    items: number;
    bytes: number;
    partial: boolean;
} {
    let bytes = 0;
    let partial = false;

    for (const entry of entries) {
        if (entry.fileSize && entry.fileSize > 0) bytes += entry.fileSize;
        else partial = true;
    }

    return { items: entries.length, bytes, partial };
}
