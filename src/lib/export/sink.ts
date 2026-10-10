/**
 * Where an export's bytes actually land.
 *
 * Two sinks, because two very different jobs. The directory sink streams each
 * file straight to a folder the reader picked: no size ceiling, and each file
 * is committed on its own, so one failure costs one item rather than the run.
 * The transcript sink is an ordinary download for the text half alone, which
 * is what a browser without the File System Access API can manage.
 *
 * Nothing here knows about Telegram. It takes paths and byte streams.
 */

import { debug } from '@/lib/debug';

export type ExportSink = {
    /** Stream a file in, chunk by chunk, without ever holding it whole. */
    writeStream(path: string, chunks: AsyncIterable<Uint8Array>): Promise<void>;
    writeText(path: string, text: string): Promise<void>;
    /** True when a non-empty file is already there, so a re-run can skip it. */
    has(path: string): Promise<boolean>;
    close(): Promise<void>;
    /** What to call the destination when telling the reader where it went. */
    readonly label: string;
    /** False when the sink cannot take media, only text. */
    readonly acceptsMedia: boolean;
};

type DirectoryPickerOptions = {
    id?: string;
    mode?: 'read' | 'readwrite';
    startIn?: string;
};

type PickerWindow = Window &
    typeof globalThis & {
        showDirectoryPicker?: (
            options?: DirectoryPickerOptions,
        ) => Promise<FileSystemDirectoryHandle>;
    };

/**
 * Whether this browser can be handed a folder.
 *
 * The secure-context check is not decoration: `showDirectoryPicker` is absent
 * over plain http, which is what a `.test` host is until `herd secure` has
 * been run — the same requirement the progressive service worker has.
 */
export function supportsDirectoryExport(): boolean {
    if (typeof window === 'undefined') return false;
    if (!window.isSecureContext) return false;
    return typeof (window as PickerWindow).showDirectoryPicker === 'function';
}

/** The reader closed the picker. Not a failure, and never reported as one. */
export class ExportCancelled extends Error {
    constructor() {
        super('Export cancelled.');
        this.name = 'ExportCancelled';
    }
}

function isAbort(error: unknown): boolean {
    return (
        error instanceof DOMException &&
        (error.name === 'AbortError' || error.name === 'NotAllowedError')
    );
}

async function resolveDirectory(
    root: FileSystemDirectoryHandle,
    segments: string[],
    create: boolean,
): Promise<FileSystemDirectoryHandle> {
    let handle = root;
    for (const segment of segments) {
        handle = await handle.getDirectoryHandle(segment, { create });
    }
    return handle;
}

function splitPath(path: string): { dirs: string[]; name: string } {
    const parts = path.split('/').filter(Boolean);
    const name = parts.pop();
    if (!name) throw new Error(`Not a file path: ${path}`);
    return { dirs: parts, name };
}

/**
 * Ask for a folder and create the export directory inside it.
 *
 * Must be called straight from the click handler — the picker needs a user
 * gesture, and an `await` before it is what turns "pick a folder" into a
 * silent no-op.
 */
export async function pickDirectorySink(
    folderName: string,
): Promise<ExportSink> {
    const picker = (window as PickerWindow).showDirectoryPicker;
    if (!picker) throw new Error('This browser cannot export to a folder.');

    let parent: FileSystemDirectoryHandle;
    try {
        parent = await picker({
            id: 'mediagram-export',
            mode: 'readwrite',
            startIn: 'downloads',
        });
    } catch (error) {
        if (isAbort(error)) throw new ExportCancelled();
        throw error;
    }

    // The export gets its own directory inside whatever was chosen, so picking
    // Downloads does not scatter a thousand files across it.
    const root = await parent.getDirectoryHandle(folderName, { create: true });

    return {
        label: folderName,
        acceptsMedia: true,

        async has(path) {
            const { dirs, name } = splitPath(path);
            try {
                const directory = await resolveDirectory(root, dirs, false);
                const handle = await directory.getFileHandle(name);
                const file = await handle.getFile();
                // A zero-byte file is a previous run that died mid-write, not
                // a file worth keeping.
                return file.size > 0;
            } catch {
                return false;
            }
        },

        async writeStream(path, chunks) {
            const { dirs, name } = splitPath(path);
            const directory = await resolveDirectory(root, dirs, true);
            const handle = await directory.getFileHandle(name, {
                create: true,
            });
            // createWritable() writes to a swap file and only replaces the
            // real one on close(), so an abandoned write leaves nothing
            // half-finished behind.
            const stream = await handle.createWritable();
            try {
                for await (const chunk of chunks) {
                    // mtcute types its chunks as `Uint8Array<ArrayBufferLike>`,
                    // which admits a SharedArrayBuffer that `write()` refuses.
                    // Bytes read off a socket are never shared-backed, so this
                    // narrows the type rather than lying about it.
                    await stream.write(chunk as Uint8Array<ArrayBuffer>);
                }
                await stream.close();
            } catch (error) {
                await stream.abort().catch(() => {});
                throw error;
            }
        },

        async writeText(path, text) {
            const { dirs, name } = splitPath(path);
            const directory = await resolveDirectory(root, dirs, true);
            const handle = await directory.getFileHandle(name, {
                create: true,
            });
            const stream = await handle.createWritable();
            await stream.write(new Blob([text]));
            await stream.close();
        },

        async close() {
            debug('export', 'directory sink closed', folderName);
        },
    };
}

/**
 * The text-only sink: each file arrives as an ordinary download.
 *
 * Downloads are queued and fired on `close()` rather than as they are written,
 * because a browser that sees two download requests in quick succession blocks
 * the second one. Two files is the whole of it — `index.html` and
 * `messages.json` — so the gap between them is cheap.
 */
export function createTranscriptSink(folderName: string): ExportSink {
    const queued: Array<{ name: string; text: string }> = [];

    return {
        label: folderName,
        acceptsMedia: false,

        async writeStream() {
            throw new Error(
                'A transcript-only export cannot save media files.',
            );
        },

        async writeText(path, text) {
            // The folder structure is flattened: there is no folder, so the
            // name has to carry what the path said.
            const name = path.split('/').filter(Boolean).join('-');
            queued.push({ name: `${folderName}-${name}`, text });
        },

        async has() {
            return false;
        },

        async close() {
            for (const [index, file] of queued.entries()) {
                if (index > 0) {
                    await new Promise((resolve) => setTimeout(resolve, 600));
                }
                saveText(file.name, file.text);
            }
            queued.length = 0;
        },
    };
}

function saveText(name: string, text: string) {
    const type = name.endsWith('.json')
        ? 'application/json'
        : name.endsWith('.html')
          ? 'text/html'
          : 'text/plain';
    const url = URL.createObjectURL(new Blob([text], { type }));
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.click();
    // Unlike the lightbox's download, this URL is ours to clean up: nothing
    // caches it, and the click has already handed the blob to the browser.
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
