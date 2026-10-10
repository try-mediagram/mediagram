import { bytesToBlob } from '@/lib/format';

const thumbs = new Map<string, string>();
const fulls = new Map<string, string>();

const THUMB_MAX = 600;
// Room for the story being watched plus the two fetched ahead of it.
const FULL_MAX = 12;

function remember(
    map: Map<string, string>,
    max: number,
    key: string,
    url: string,
) {
    if (map.has(key)) {
        map.delete(key);
    }
    map.set(key, url);
    while (map.size > max) {
        const oldest = map.keys().next().value;
        if (!oldest) break;
        const stale = map.get(oldest);
        if (stale) URL.revokeObjectURL(stale);
        map.delete(oldest);
    }
    return url;
}

export const blobCache = {
    get(key: string, kind: 'thumb' | 'full' = 'thumb'): string | undefined {
        const map = kind === 'full' ? fulls : thumbs;
        const url = map.get(key);
        if (!url) return undefined;
        map.delete(key);
        map.set(key, url);
        return url;
    },
    put(
        key: string,
        bytes: Uint8Array,
        mime: string,
        kind: 'thumb' | 'full' = 'thumb',
    ): string {
        const existing = blobCache.get(key, kind);
        if (existing) return existing;
        const url = URL.createObjectURL(bytesToBlob(bytes, mime));
        return remember(
            kind === 'full' ? fulls : thumbs,
            kind === 'full' ? FULL_MAX : THUMB_MAX,
            key,
            url,
        );
    },
    clear() {
        for (const url of thumbs.values()) URL.revokeObjectURL(url);
        for (const url of fulls.values()) URL.revokeObjectURL(url);
        thumbs.clear();
        fulls.clear();
    },
};
