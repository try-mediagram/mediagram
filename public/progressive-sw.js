const VERSION = 5;
const PART_SIZE = 1024 * 1024;
const MB = 1024 * 1024;
const PART_TIMEOUT = 60_000;
const pending = new Map();

self.addEventListener('install', (event) => {
    event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    if (!url.pathname.startsWith('/progressive/')) return;
    event.respondWith(respondProgressive(event));
});

self.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || data.type !== 'partResponse') return;
    const waiter = pending.get(data.messageId);
    if (!waiter) return;
    pending.delete(data.messageId);
    if (data.error) waiter.reject(new Error(data.error));
    else waiter.resolve(data.result);
});

function abortedResponse() {
    return new Response(null, { status: 499, statusText: 'Aborted' });
}

function clampEnd(start, end) {
    const windowEnd = Math.floor(start / MB) * MB + MB - 1;
    return Math.min(end, windowEnd, start + PART_SIZE - 1);
}

async function respondProgressive(event) {
    const signal = event.request.signal;
    if (signal.aborted) return abortedResponse();

    const url = new URL(event.request.url);
    const rangeHeader = event.request.headers.get('range') || 'bytes=0-';
    const match = /^bytes=(\d+)-(\d+)?$/.exec(rangeHeader);
    if (!match) {
        return new Response('Range required', { status: 416 });
    }

    const start = Number(match[1]);
    const originalEnd = match[2] ? Number(match[2]) : undefined;
    let end = originalEnd;
    if (end === undefined || end - start + 1 > PART_SIZE) {
        end = start + PART_SIZE - 1;
    }
    end = clampEnd(start, end);

    if (start === 0 && originalEnd === 1) {
        const fileSize = Number(url.searchParams.get('fileSize') || 0);
        const mimeType = url.searchParams.get('mimeType') || 'video/mp4';
        if (fileSize > 0) {
            return new Response(new Uint8Array(2), {
                status: 206,
                headers: {
                    'Content-Range': `bytes 0-1/${fileSize}`,
                    'Accept-Ranges': 'bytes',
                    'Content-Length': '2',
                    'Content-Type': mimeType,
                },
            });
        }
    }

    try {
        const part = await requestPart(event, url.href, start, end);
        if (signal.aborted) return abortedResponse();
        const fullSize = part.fullSize || '*';
        const partSize = part.arrayBuffer.byteLength;
        if (partSize === 0) {
            return new Response(null, {
                status: 416,
                statusText: 'Range Not Satisfiable',
            });
        }
        const actualEnd = start + partSize - 1;
        return new Response(part.arrayBuffer, {
            status: 206,
            headers: {
                'Content-Range': `bytes ${start}-${actualEnd}/${fullSize}`,
                'Accept-Ranges': 'bytes',
                'Content-Length': String(partSize),
                'Content-Type': part.mimeType || 'video/mp4',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Expose-Headers':
                    'Content-Range, Accept-Ranges, Content-Length, Content-Type',
            },
        });
    } catch (error) {
        if (signal.aborted) return abortedResponse();
        const message =
            error instanceof Error ? error.message : 'Failed to fetch part';
        console.warn('progressive part failed', message, {
            start,
            end,
            VERSION,
        });
        return new Response(message, {
            status: 500,
            statusText: 'Failed to fetch part',
            headers: { 'Content-Type': 'text/plain' },
        });
    }
}

async function requestPart(event, url, start, end) {
    let client = event.clientId
        ? await self.clients.get(event.clientId)
        : undefined;
    if (!client) {
        const windows = await self.clients.matchAll({ type: 'window' });
        client =
            windows.find((item) => item.frameType === 'top-level') ||
            windows[0];
    }
    if (!client) throw new Error('No client');

    const messageId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const channel = new MessageChannel();
    const result = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            pending.delete(messageId);
            channel.port1.close();
            reject(new Error('part timeout'));
        }, PART_TIMEOUT);
        const settle = (fn, value) => {
            clearTimeout(timer);
            pending.delete(messageId);
            fn(value);
        };
        channel.port1.onmessage = (event) => {
            const data = event.data;
            if (data?.error) settle(reject, new Error(data.error));
            else settle(resolve, data?.result);
        };
        pending.set(messageId, {
            resolve: (value) => settle(resolve, value),
            reject: (error) => settle(reject, error),
        });
    });

    const onAbort = () => {
        const waiter = pending.get(messageId);
        if (!waiter) return;
        pending.delete(messageId);
        client.postMessage({ type: 'abortPart', messageId });
        waiter.reject(new Error('aborted'));
    };
    event.request.signal.addEventListener('abort', onAbort, { once: true });

    client.postMessage(
        {
            type: 'requestPart',
            messageId,
            params: { url, start, end },
        },
        [channel.port2],
    );

    try {
        return await result;
    } finally {
        event.request.signal.removeEventListener('abort', onAbort);
    }
}
