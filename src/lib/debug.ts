/**
 * Opt-in client-side tracing.
 *
 * Almost everything interesting in Mediagram happens in the browser — the
 * Telegram session, media downloads, progressive streaming, the sensitive-chat
 * gate — so there is no server log to read when something misbehaves. This is
 * that log.
 *
 * Turn it on with `?debug=1` (which sticks), or from the console:
 *
 *     mediagram.debug(true)   // on, persists across reloads
 *     mediagram.debug(false)  // off
 *
 * Off by default and cheap when off: every call site checks the flag before
 * building its message.
 */

const KEY = 'mediagram:debug';

let enabled = false;

function read(): boolean {
    if (typeof window === 'undefined') return false;

    try {
        const fromUrl = new URLSearchParams(window.location.search).get(
            'debug',
        );
        if (fromUrl === '1' || fromUrl === 'true') {
            window.localStorage.setItem(KEY, '1');
            return true;
        }
        if (fromUrl === '0' || fromUrl === 'false') {
            window.localStorage.removeItem(KEY);
            return false;
        }
        return window.localStorage.getItem(KEY) === '1';
    } catch {
        // Private mode, blocked storage — tracing is a convenience, not a need.
        return false;
    }
}

export function isDebugEnabled(): boolean {
    return enabled;
}

export function setDebugEnabled(on: boolean): boolean {
    enabled = on;
    try {
        if (on) window.localStorage.setItem(KEY, '1');
        else window.localStorage.removeItem(KEY);
    } catch {
        // ignore
    }
    console.info(`[mediagram] debug ${on ? 'on' : 'off'}`);
    return on;
}

/** Log one line under a scope, e.g. debug('gate', 'locked', locked). */
export function debug(scope: string, ...args: unknown[]): void {
    if (!enabled) return;
    console.debug(`%c[${scope}]`, 'color:#38bdf8;font-weight:600', ...args);
    if (import.meta.env.DEV && PLAYBACK_SCOPES.has(scope)) {
        recordPlayback(scope, args);
    }
}

/** Scopes the dev server also writes to `.perf/playback.log`. */
const PLAYBACK_SCOPES = new Set(['video', 'stream', 'photo']);

function recordPlayback(scope: string, args: unknown[]) {
    let body: string;
    try {
        body = JSON.stringify({ at: new Date().toISOString(), scope, args });
    } catch {
        return;
    }
    void fetch('/__playback-log', { method: 'POST', body }).catch(
        () => undefined,
    );
}

const lastSeen = new Map<string, string>();

/**
 * Log only when a scope's state actually changes.
 *
 * State that is derived during render would otherwise repeat on every render
 * and bury the lines that mark a real transition.
 */
export function debugChange(
    scope: string,
    state: Record<string, unknown>,
): void {
    if (!enabled) return;

    const serialised = JSON.stringify(state);
    if (lastSeen.get(scope) === serialised) return;

    lastSeen.set(scope, serialised);
    debug(scope, state);
}

/** Time an async step and log how long it took. */
export async function debugTime<T>(
    scope: string,
    label: string,
    run: () => Promise<T>,
): Promise<T> {
    if (!enabled) return run();

    const started = performance.now();
    try {
        const result = await run();
        debug(
            scope,
            `${label} ok`,
            `${Math.round(performance.now() - started)}ms`,
        );
        return result;
    } catch (error) {
        debug(
            scope,
            `${label} failed`,
            `${Math.round(performance.now() - started)}ms`,
            error,
        );
        throw error;
    }
}

/**
 * Wire up the console handle. Called once from the app shell.
 */
export function installDebug(): void {
    if (typeof window === 'undefined') return;

    enabled = read();

    (window as unknown as Record<string, unknown>).mediagram = {
        debug: setDebugEnabled,
        get enabled() {
            return enabled;
        },
    };

    if (enabled) {
        console.info(
            '[mediagram] debug on — mediagram.debug(false) to silence',
        );
    }
}
