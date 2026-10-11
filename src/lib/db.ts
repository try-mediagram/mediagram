import Database from '@tauri-apps/plugin-sql';

/**
 * The local SQLite file that holds tags and read markers.
 *
 * It is the same data the Laravel process kept, now opened straight from the
 * window through tauri-plugin-sql. The schema and its migrations live in
 * `src-tauri/src/lib.rs`; the plugin runs them before the first load resolves.
 *
 * Nothing here ever describes media: a row names a chat id, a message id and
 * a word. Telegram media still never leaves the window.
 */

const DB_URL = 'sqlite:mediagram.db';

let connection: Promise<Database> | null = null;

export function db(): Promise<Database> {
    if (connection === null) {
        connection = Database.load(DB_URL).catch((error: unknown) => {
            // Let the next call try again rather than caching the failure.
            connection = null;
            throw error;
        });
    }
    return connection;
}

/**
 * `$start, $start+1, …` for an IN list of `count` values. The plugin binds
 * positionally, so every list has to be spelled out.
 */
export function placeholders(count: number, start = 1): string {
    return Array.from({ length: count }, (_, i) => `$${start + i}`).join(', ');
}

export function now(): string {
    return new Date().toISOString();
}

/**
 * Split a list into runs of at most `size`, so a lookup over everything a
 * grid has loaded stays within SQLite's bound-parameter limit instead of
 * answering for the first few hundred and silently ignoring the rest.
 */
export function chunked<T>(items: T[], size: number): T[][] {
    const runs: T[][] = [];
    for (let start = 0; start < items.length; start += size) {
        runs.push(items.slice(start, start + size));
    }
    return runs;
}
