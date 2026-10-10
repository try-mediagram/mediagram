import babel from '@rolldown/plugin-babel';
import tailwindcss from '@tailwindcss/vite';
import { devtools } from '@tanstack/devtools-vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import viteReact, { reactCompilerPreset } from '@vitejs/plugin-react';
import { appendFile, mkdir } from 'node:fs/promises';
import { defineConfig, type Plugin } from 'vite';

/**
 * Dev only: the app posts its playback timings (`[video]`, `[stream]` debug
 * lines) here and they are appended to `.perf/playback.log`, one JSON object
 * per line — so a measurement is a file to read, not console output to copy.
 */
function playbackLog(): Plugin {
    return {
        name: 'mediagram-playback-log',
        apply: 'serve',
        configureServer(server) {
            server.middlewares.use('/__playback-log', (req, res) => {
                let body = '';
                req.on('data', (chunk) => {
                    body += chunk;
                });
                req.on('end', async () => {
                    await mkdir('.perf', { recursive: true });
                    await appendFile('.perf/playback.log', `${body.trim()}\n`);
                    res.statusCode = 204;
                    res.end();
                });
            });
        },
    };
}

/**
 * A plain SPA: Tauri serves the built `dist/` and mtcute must never run on a
 * server, so there is no SSR anywhere.
 */
export default defineConfig({
    resolve: { tsconfigPaths: true },
    plugins: [
        playbackLog(),
        devtools(),
        // Must come before the React plugin.
        tanstackRouter({ target: 'react', autoCodeSplitting: true }),
        viteReact(),
        babel({ presets: [reactCompilerPreset()] }),
        tailwindcss(),
    ],
    optimizeDeps: {
        exclude: ['@mtcute/wasm'],
    },
    // Tauri prints its own output; keep Vite from wiping it.
    clearScreen: false,
    envPrefix: ['VITE_', 'TAURI_ENV_'],
    server: {
        port: 3000,
        strictPort: true,
        watch: { ignored: ['**/src-tauri/**'] },
    },
    build: {
        // WKWebView on macOS 13+, which Tauri v2 targets.
        target: 'safari16',
    },
});
