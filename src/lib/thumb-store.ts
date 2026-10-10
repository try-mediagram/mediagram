/**
 * Grid thumbnails kept on disk between launches.
 *
 * `blobCache` only lives as long as the window, so every launch used to fetch
 * every tile from Telegram again — one MTProto download per square, often on a
 * DC the session had not talked to yet. A message's media never changes under
 * the same id, so the bytes are safe to keep and the network is only asked for
 * tiles this browser has never seen.
 *
 * Cache Storage rather than IndexedDB because it stores Blobs natively and
 * needs no schema. Every call is best effort: a store that is missing, full or
 * denied just means a download, exactly as before.
 */
const STORE = 'mediagram-thumbs-v1';

function urlFor(key: string) {
    return `/__thumbs/${encodeURIComponent(key)}`;
}

function available() {
    return typeof caches !== 'undefined';
}

export async function readThumb(key: string): Promise<Uint8Array | null> {
    if (!available()) return null;
    try {
        const cache = await caches.open(STORE);
        const hit = await cache.match(urlFor(key));
        return hit ? new Uint8Array(await hit.arrayBuffer()) : null;
    } catch {
        return null;
    }
}

export async function writeThumb(
    key: string,
    bytes: Uint8Array,
    mime: string,
): Promise<void> {
    if (!available()) return;
    try {
        const cache = await caches.open(STORE);
        await cache.put(
            urlFor(key),
            new Response(new Blob([bytes as BlobPart], { type: mime })),
        );
    } catch {
        // Quota or storage denied; the tile still shows from memory.
    }
}

/** Drops one entry, for callers that cap what they keep. */
export async function deleteThumb(key: string): Promise<void> {
    if (!available()) return;
    try {
        const cache = await caches.open(STORE);
        await cache.delete(urlFor(key));
    } catch {
        // Already gone, or storage denied.
    }
}

/** Signing out takes the previous account's thumbnails with it. */
export async function clearThumbs(): Promise<void> {
    if (!available()) return;
    try {
        await caches.delete(STORE);
    } catch {
        // Nothing to clear.
    }
}
