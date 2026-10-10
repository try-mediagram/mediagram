import type { ChatPhoto, Story, StoryMedia, Thumbnail } from '@mtcute/web';

import { blobCache } from '@/lib/blob-cache';
import {
    PINNED_CHECK_TTL_MS,
    readPinnedChecks,
    touchFullStory,
    writePinnedChecks,
} from '@/lib/story-snapshot';
import { getClient } from '@/lib/telegram/client';
import { withFloodWait } from '@/lib/telegram/errors';
import { deleteThumb, readThumb, writeThumb } from '@/lib/thumb-store';

/**
 * A chat's stories, the way the carousel draws them.
 *
 * Telegram calls them stories; a channel's are its status line, posts that
 * expire after a day. Active ones come first because they are the news. A
 * channel with nothing live still shows what it pinned to its profile, so the
 * strip is not empty on a chat that has stories, just none from today.
 */
export type StoryItem = {
    key: string;
    peerId: number;
    id: number;
    date: string;
    /** Absent on a pinned story that has already expired from the live feed. */
    expiresAt?: string;
    caption: string | null;
    type: 'photo' | 'video';
    duration?: number;
    width: number;
    height: number;
    /** Live (within its 24 hours) rather than only pinned to the profile. */
    isActive: boolean;
    /** This account has already seen it. */
    isRead: boolean;
    isPinned: boolean;
};

const PINNED_LIMIT = 20;

/** The mtcute media behind each story, kept so a download needs no refetch. */
const media = new Map<string, StoryMedia>();

function keyOf(peerId: number, id: number) {
    return `story:${peerId}:${id}`;
}

function toItem(peerId: number, story: Story, maxReadId: number): StoryItem {
    const key = keyOf(peerId, story.id);
    const source = story.media;
    media.set(key, source);
    const isVideo = source.type === 'video';
    return {
        key,
        peerId,
        id: story.id,
        date: story.date.toISOString(),
        expiresAt: story.isActive ? story.expireDate.toISOString() : undefined,
        caption: story.caption,
        type: isVideo ? 'video' : 'photo',
        duration: isVideo ? source.duration : undefined,
        width: source.width,
        height: source.height,
        isActive: story.isActive,
        isRead: story.id <= maxReadId,
        isPinned: story.isPinned,
    };
}

export async function loadStories(peerId: number): Promise<StoryItem[]> {
    const client = getClient();
    const [live, pinned] = await Promise.all([
        withFloodWait(() => client.getPeerStories(peerId)).catch(() => null),
        withFloodWait(() =>
            client.getProfileStories(peerId, { limit: PINNED_LIMIT }),
        ).catch(() => []),
    ]);

    const maxReadId = live?.maxReadId ?? 0;
    const seen = new Set<number>();
    const out: StoryItem[] = [];

    for (const story of live?.stories ?? []) {
        seen.add(story.id);
        out.push(toItem(peerId, story, maxReadId));
    }
    for (const story of pinned) {
        if (seen.has(story.id)) continue;
        seen.add(story.id);
        // A pinned story that is no longer live was seen or not seen a day
        // ago; nothing about it is news, so it never draws the unread ring.
        out.push({ ...toItem(peerId, story, maxReadId), isRead: true });
    }

    return out;
}

/**
 * Someone with live stories, for the bar across the top of the library: a
 * contact, a channel, a group. Only the summary; their stories themselves are
 * read with `loadStories` when the ring is opened.
 */
export type StoryPeer = {
    peerId: number;
    title: string;
    /** How many live stories they have up. */
    count: number;
    /** Something in there this account has not watched yet. */
    hasUnread: boolean;
    /** The newest live story, for ordering. */
    latestAt: string;
    hasPhoto: boolean;
};

/** Pages of `stories.getAllStories` read for the bar; each is ~20 peers. */
const STORY_PEER_PAGES = 3;

const peerPhotos = new Map<number, ChatPhoto>();

/**
 * Everyone this account follows who has stories up right now, unwatched
 * first and then newest first — the order Telegram's own top bar uses.
 * Hidden ("archived") peers stay hidden, as they do in Telegram.
 */
export async function loadStoryPeers(): Promise<StoryPeer[]> {
    const client = getClient();
    const out: StoryPeer[] = [];
    const seen = new Set<number>();
    let offset: string | undefined;

    for (let page = 0; page < STORY_PEER_PAGES; page += 1) {
        const all = await withFloodWait(() =>
            client.getAllStories(offset ? { offset } : {}),
        );
        for (const entry of all.peerStories) {
            const peer = entry.peer;
            if (seen.has(peer.id)) continue;
            seen.add(peer.id);
            // The raw list counts stories Telegram skipped sending in full.
            const ids = entry.raw.stories.map((story) => story.id);
            if (ids.length === 0) continue;
            const dates = entry.raw.stories
                .map((story) => ('date' in story ? story.date : 0))
                .filter((date) => date > 0);
            if (peer.photo) peerPhotos.set(peer.id, peer.photo);
            out.push({
                peerId: peer.id,
                title: peer.displayName,
                count: ids.length,
                hasUnread: Math.max(...ids) > entry.maxReadId,
                latestAt: new Date(
                    (dates.length > 0 ? Math.max(...dates) : 0) * 1000,
                ).toISOString(),
                hasPhoto: peer.photo !== null,
            });
        }
        if (!all.hasMore) break;
        offset = all.next;
    }

    return out.sort(
        (a, b) =>
            Number(b.hasUnread) - Number(a.hasUnread) ||
            b.latestAt.localeCompare(a.latestAt),
    );
}

/** How many at once: a profile-stories check is one call per chat. */
const PINNED_CONCURRENCY = 2;

/**
 * Which of these chats keep stories pinned to their profile.
 *
 * Telegram's story list only carries live ones, so a contact or channel whose
 * stories are all past their 24 hours never reaches the bar through it, even
 * though their profile still shows them. One small call per chat answers that;
 * the caller keeps the list short (the most recent chats) and caches it.
 */
export async function loadPinnedStoryPeers(
    candidates: { id: number; title: string; hasPhoto: boolean }[],
): Promise<StoryPeer[]> {
    const client = getClient();
    const checks = readPinnedChecks();
    const now = Date.now();
    // Only chats not asked about recently cost a request; the rest answer
    // from memory, so a chat list that reshuffles on every new message does
    // not re-ask Telegram thirty times over.
    const due = candidates.filter(
        (item) => (checks[item.id]?.at ?? 0) < now - PINNED_CHECK_TTL_MS,
    );
    let next = 0;

    async function worker() {
        while (next < due.length) {
            const candidate = due[next];
            next += 1;
            if (!candidate) continue;
            try {
                const stories = await withFloodWait(() =>
                    client.getProfileStories(candidate.id, { limit: 1 }),
                );
                const newest = stories[0];
                checks[candidate.id] = {
                    at: Date.now(),
                    peer: newest
                        ? {
                              peerId: candidate.id,
                              title: candidate.title,
                              count: Math.max(
                                  stories.total ?? 0,
                                  stories.length,
                              ),
                              hasUnread: false,
                              latestAt: newest.date.toISOString(),
                              hasPhoto: candidate.hasPhoto,
                          }
                        : null,
                };
            } catch {
                // A private profile or a channel that went away: no ring,
                // and not asked again until the check expires.
                checks[candidate.id] = { at: Date.now(), peer: null };
            }
        }
    }

    await Promise.all(
        Array.from({ length: PINNED_CONCURRENCY }, () => worker()),
    );
    writePinnedChecks(checks);

    // Keep the order the chats came in: most recent conversation first. The
    // title comes from the list, which may have been renamed since the check.
    return candidates.flatMap((item) => {
        const peer = checks[item.id]?.peer;
        return peer ? [{ ...peer, title: item.title }] : [];
    });
}

/** The small profile photo of someone in the stories bar. */
export async function downloadStoryPeerAvatar(
    peerId: number,
): Promise<string | null> {
    const photo = peerPhotos.get(peerId);
    if (!photo) return null;
    const { downloadPhotoAvatar } = await import('@/lib/telegram/dialogs');
    return downloadPhotoAvatar(peerId, photo);
}

function previewOf(source: StoryMedia): Thumbnail | StoryMedia {
    const ladder = ['m', 'x', 'c', 'b', 's'];
    for (const type of ladder) {
        const thumb = source.getThumbnail(type);
        if (thumb) return thumb;
    }
    return source.type === 'photo' ? source : (source.thumbnails[0] ?? source);
}

/** Story reads under way, so a burst of misses refills a chat only once. */
const refilling = new Map<number, Promise<unknown>>();

/**
 * The mtcute media for a story, reading the chat's stories again when it is
 * missing: an item painted from last launch's snapshot has none yet.
 */
async function sourceOf(item: StoryItem): Promise<StoryMedia | undefined> {
    const known = media.get(item.key);
    if (known) return known;
    let run = refilling.get(item.peerId);
    if (!run) {
        run = loadStories(item.peerId).finally(() =>
            refilling.delete(item.peerId),
        );
        refilling.set(item.peerId, run);
    }
    await run.catch(() => undefined);
    return media.get(item.key);
}

/** A story's preview: memory, then disk, then Telegram. */
export async function downloadStoryThumb(
    item: StoryItem,
): Promise<string | null> {
    const cacheKey = `${item.key}:thumb`;
    const cached = blobCache.get(cacheKey);
    if (cached) return cached;
    const stored = await readThumb(cacheKey);
    if (stored) return blobCache.put(cacheKey, stored, 'image/jpeg');

    const source = await sourceOf(item);
    if (!source) return null;
    const location = previewOf(source);
    // A video with no thumbnail would mean downloading the whole clip for a
    // tile; the tile draws its own placeholder instead.
    if (location === source && source.type === 'video') return null;
    const bytes = await withFloodWait(() =>
        getClient().downloadAsBuffer(location),
    );
    void writeThumb(cacheKey, bytes, 'image/jpeg');
    return blobCache.put(cacheKey, bytes, 'image/jpeg');
}

/** Story files bigger than this are watched but not kept on disk. */
const FULL_DISK_MAX = 20 * 1024 * 1024;

/**
 * A story's file: memory, then disk, then Telegram. A story never changes
 * under its id, so what was watched once plays from disk after that; the
 * newest few dozen are kept and the oldest dropped.
 */
export async function downloadStoryFull(item: StoryItem): Promise<string> {
    const cacheKey = `${item.key}:full`;
    const mime = item.type === 'video' ? 'video/mp4' : 'image/jpeg';
    const cached = blobCache.get(cacheKey, 'full');
    if (cached) return cached;

    const stored = await readThumb(cacheKey);
    if (stored) {
        rememberFull(cacheKey);
        return blobCache.put(cacheKey, stored, mime, 'full');
    }

    const source = await sourceOf(item);
    if (!source) throw new Error('That story is no longer available.');
    const bytes = await withFloodWait(() =>
        getClient().downloadAsBuffer(source),
    );
    const type =
        source.type === 'video' ? source.mimeType || 'video/mp4' : 'image/jpeg';
    if (bytes.byteLength <= FULL_DISK_MAX) {
        void writeThumb(cacheKey, bytes, type);
        rememberFull(cacheKey);
    }
    return blobCache.put(cacheKey, bytes, type, 'full');
}

function rememberFull(cacheKey: string) {
    for (const evicted of touchFullStory(cacheKey)) void deleteThumb(evicted);
}

/** Tell Telegram the story was watched, which clears its unread ring. */
export async function markStoryRead(item: StoryItem): Promise<void> {
    if (!item.isActive) return;
    try {
        await getClient().readStories(item.peerId, item.id);
    } catch {
        // Best effort: a read receipt that fails is not worth an error.
    }
}

export type PeerPresence = {
    status: string;
    online: boolean;
};

/**
 * A person's last-seen line, as Telegram lets this account see it.
 *
 * Only meaningful for a conversation with a person; a bot is "bot" and a
 * group has no presence of its own.
 */
export async function loadPresence(userId: number): Promise<PeerPresence> {
    const [user] = await withFloodWait(() => getClient().getUsers(userId));
    if (!user) return { status: '', online: false };
    switch (user.status) {
        case 'online':
            return { status: 'online', online: true };
        case 'bot':
            return { status: 'bot', online: false };
        case 'recently':
            return { status: 'last seen recently', online: false };
        case 'within_week':
            return { status: 'last seen within a week', online: false };
        case 'within_month':
            return { status: 'last seen within a month', online: false };
        case 'long_time_ago':
            return { status: 'last seen a long time ago', online: false };
        default:
            return {
                status: user.lastOnline
                    ? `last seen ${lastSeen(user.lastOnline)}`
                    : 'offline',
                online: false,
            };
    }
}

function lastSeen(date: Date): string {
    const minutes = Math.round((Date.now() - date.getTime()) / 60_000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours} h ago`;
    return date.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
    });
}
