/**
 * The desktop shell, when there is one.
 *
 * The Tauri app opens on a splash window with the main window hidden behind
 * it (src-tauri/src/lib.rs). Once the app has something real to show —
 * signed in, or on the sign-in screen — this shows the main window and closes
 * the splash. In a browser it does nothing.
 */

/**
 * The splash stays at least this long from launch, so a fast start shows it
 * rather than flashing it. `performance.now()` counts from the main window's
 * page load, which begins with the app.
 */
const SPLASH_MIN_MS = 2_000;

let told = false;

export function notifyAppReady() {
    if (told || typeof window === 'undefined') return;
    if (!('__TAURI_INTERNALS__' in window)) return;
    told = true;
    void (async () => {
        const wait = Math.max(0, SPLASH_MIN_MS - performance.now());
        await new Promise((resolve) => setTimeout(resolve, wait));
        const { getCurrentWindow, Window } = await import(
            '@tauri-apps/api/window'
        );
        const main = getCurrentWindow();
        await main.show();
        await main.setFocus();
        const splash = await Window.getByLabel('splash');
        await splash?.close();
    })().catch((error: unknown) => {
        // The shell shows the window on its own after a timeout anyway.
        console.warn('could not swap the splash for the main window', error);
    });
}
