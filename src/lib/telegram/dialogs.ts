import {
    getMarkedPeerId,
    type ChatPhoto,
    type Message,
    type Peer,
    type tl,
} from '@mtcute/web';

import { blobCache } from '@/lib/blob-cache';
import { bytesToBlob } from '@/lib/format';
import {
    checkCanSendMedia,
    checkCanWrite,
    combineRights,
    type SendTarget,
} from '@/lib/telegram/can-send';
import { getClient } from '@/lib/telegram/client';
import { withFloodWait } from '@/lib/telegram/errors';
import { readThumb, writeThumb } from '@/lib/thumb-store';
import type {
    ChatKind,
    DialogFolder,
    DialogItem,
    MediaKind,
} from '@/lib/telegram/types';

type DialogGlobals = typeof globalThis & {
    __mediagramChatPhotos?: Map<number, ChatPhoto>;
    __mediagramAvatars?: Map<number, string>;
};

const dialogGlobals = globalThis as DialogGlobals;
if (!dialogGlobals.__mediagramChatPhotos) {
    dialogGlobals.__mediagramChatPhotos = new Map();
}
if (!dialogGlobals.__mediagramAvatars) {
    dialogGlobals.__mediagramAvatars = new Map();
}
const photos = dialogGlobals.__mediagramChatPhotos;
const avatarUrls = dialogGlobals.__mediagramAvatars;

/** Exported so the paste-a-link resolver labels a chat the way the list does. */
export function kindOf(peer: Peer): ChatKind {
    if (peer.type === 'user') {
        if (peer.isSelf) return 'saved';
        if (peer.isBot) return 'bot';
        return 'direct';
    }
    switch (peer.chatType) {
        case 'channel':
            return 'channel';
        case 'group':
        case 'supergroup':
        case 'gigagroup':
            return 'group';
        default:
            return 'chat';
    }
}

/**
 * The handful of fields the send check needs, pulled off the peer.
 *
 * A gigagroup counts as a broadcast: it is a group by type but only its admins
 * may post, which is the rule that matters here. `permissions` is this
 * account's own, and falls back to the chat's defaults when Telegram sent only
 * those.
 */
function sendTargetOf(peer: Peer): SendTarget {
    if (peer.type === 'user') {
        return {
            kind: 'user',
            isMember: true,
            isBanned: false,
            isCreator: false,
            isAdmin: false,
            canPostAsAdmin: false,
            memberCanSendMedia: null,
            memberCanSendText: null,
        };
    }

    const broadcast =
        peer.chatType === 'channel' || peer.chatType === 'gigagroup';
    // Both apply: a member's own restrictions and the chat's defaults.
    // Reading only the first one present let a muted group look writable.
    const own = peer.permissions;
    const defaults = peer.defaultPermissions;

    return {
        kind: broadcast ? 'broadcast' : 'group',
        isMember: peer.isMember,
        isBanned: peer.isBanned,
        isCreator: peer.isCreator,
        isAdmin: peer.isAdmin,
        canPostAsAdmin: Boolean(peer.adminRights?.postMessages),
        memberCanSendMedia: combineRights(
            own?.canSendMedia,
            defaults?.canSendMedia,
        ),
        memberCanSendText: combineRights(
            own?.canSendText,
            defaults?.canSendText,
        ),
    };
}

function sendVerdict(peer: Peer) {
    return checkCanSendMedia(sendTargetOf(peer));
}

function writeVerdict(peer: Peer) {
    return checkCanWrite(sendTargetOf(peer));
}

/**
 * The chat's "restrict saving content" switch.
 *
 * mtcute's `Chat` does not surface `noforwards`, so it is read off the raw
 * peer. A user has no such flag — protection there is per message.
 */
function hasNoForwards(peer: Peer): boolean {
    if (peer.type === 'user') return false;
    const raw = peer.raw;
    return raw._ === 'chat' || raw._ === 'channel'
        ? Boolean(raw.noforwards)
        : false;
}

function mediaFromMessage(message: Message | null): {
    id: number;
    at: string;
    kind: MediaKind;
} | null {
    if (!message?.media) return null;
    if (message.media.type === 'photo') {
        return {
            id: message.id,
            at: message.date.toISOString(),
            kind: 'photo',
        };
    }
    if (message.media.type === 'video') {
        return {
            id: message.id,
            at: message.date.toISOString(),
            kind: message.media.isAnimation ? 'gif' : 'video',
        };
    }
    return null;
}

function jpegDataUrl(bytes: Uint8Array): string {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return `data:image/jpeg;base64,${btoa(binary)}`;
}

function toDialog(
    peer: Peer,
    options: {
        isPinned: boolean;
        unreadCount?: number;
        lastMessage?: Message | null;
        isArchived?: boolean;
        isMuted?: boolean;
        isUnread?: boolean;
    },
): DialogItem {
    const photo = peer.photo;
    const sending = sendVerdict(peer);
    const writing = writeVerdict(peer);
    if (photo) photos.set(peer.id, photo);
    const last = options.lastMessage ?? null;
    const media = mediaFromMessage(last);
    let avatarPreview: string | undefined;
    if (photo?.thumb) {
        try {
            avatarPreview = jpegDataUrl(photo.thumb);
        } catch {
            avatarPreview = undefined;
        }
    }
    return {
        id: peer.id,
        title:
            peer.type === 'user' && peer.isSelf
                ? 'Saved Messages'
                : peer.displayName,
        username: peer.username,
        kind: kindOf(peer),
        isPinned: options.isPinned,
        isSelf: peer.type === 'user' && peer.isSelf,
        hasPhoto: Boolean(photo),
        isRestricted: peer.isRestricted,
        restrictionReasons:
            peer.restrictions?.map((restriction) => restriction.reason) ?? [],
        avatarPreview,
        unreadCount: options.unreadCount ?? 0,
        isArchived: options.isArchived ?? false,
        isMuted: options.isMuted ?? false,
        isUnread: options.isUnread ?? (options.unreadCount ?? 0) > 0,
        isContact: peer.type === 'user' && peer.isContact,
        isMember: peer.type === 'user' ? true : peer.isMember,
        canSendMedia: sending.allowed,
        sendBlockedReason: sending.allowed ? null : sending.reason,
        canWrite: writing.allowed,
        writeBlockedReason: writing.allowed ? null : writing.reason,
        hasProtectedContent: hasNoForwards(peer),
        lastMessageAt: last?.date.toISOString(),
        lastMessageId: last?.id,
        lastMediaId: media?.id,
        lastMediaAt: media?.at,
        lastMediaKind: media?.kind,
    };
}

function pushDialog(
    dialog: {
        peer: Peer;
        isPinned: boolean;
        unreadCount: number;
        lastMessage: Message | null;
        isArchived: boolean;
        isMuted: boolean | null;
        isUnread: boolean;
    },
    items: DialogItem[],
    seen: Set<number>,
    isArchived: boolean,
): void {
    if (seen.has(dialog.peer.id)) {
        return;
    }
    seen.add(dialog.peer.id);
    items.push(
        toDialog(dialog.peer, {
            isPinned: dialog.isPinned,
            unreadCount: dialog.unreadCount,
            lastMessage: dialog.lastMessage,
            isArchived,
            isMuted: dialog.isMuted === true,
            isUnread: dialog.isUnread,
        }),
    );
}

/**
 * The listing in flight, if any. `downloadAvatar()` waits on it: the chat list
 * paints last launch's rows before this one has answered, and their photos are
 * only known once it has.
 */
let listing: Promise<DialogItem[]> | null = null;

export function listDialogs(): Promise<DialogItem[]> {
    const run = collectDialogs().finally(() => {
        if (listing === run) listing = null;
    });
    listing = run;
    return run;
}

async function collectDialogs(): Promise<DialogItem[]> {
    const tg = getClient();

    // Two independent walks of up to four pages each. They used to run one
    // after the other, which put eight sequential round trips between launch
    // and the first row of the chat list.
    const walk = async (archived: 'exclude' | 'only') => {
        const dialogs = [];
        for await (const dialog of tg.iterDialogs({
            pinned: 'keep',
            archived,
            limit: 400,
        })) {
            dialogs.push(dialog);
        }
        return dialogs;
    };
    const [active, archive] = await Promise.all([
        walk('exclude'),
        walk('only'),
    ]);

    const items: DialogItem[] = [];
    const seen = new Set<number>();
    for (const dialog of active) pushDialog(dialog, items, seen, false);
    for (const dialog of archive) pushDialog(dialog, items, seen, true);

    items.sort((a, b) => {
        if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1;
        if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
        return 0;
    });
    return items;
}

function peerIds(peers: readonly tl.TypeInputPeer[]): number[] {
    return peers.map((peer) => getMarkedPeerId(peer));
}

function toFolder(
    filter: tl.RawDialogFilter | tl.RawDialogFilterChatlist,
): DialogFolder {
    const isChatlist = filter._ === 'dialogFilterChatlist';

    return {
        id: filter.id,
        title: filter.title.text,
        includePeerIds: peerIds(filter.includePeers),
        excludePeerIds: isChatlist ? [] : peerIds(filter.excludePeers),
        pinnedPeerIds: peerIds(filter.pinnedPeers),
        contacts: isChatlist ? false : Boolean(filter.contacts),
        nonContacts: isChatlist ? false : Boolean(filter.nonContacts),
        groups: isChatlist ? false : Boolean(filter.groups),
        broadcasts: isChatlist ? false : Boolean(filter.broadcasts),
        bots: isChatlist ? false : Boolean(filter.bots),
        excludeMuted: isChatlist ? false : Boolean(filter.excludeMuted),
        excludeRead: isChatlist ? false : Boolean(filter.excludeRead),
        excludeArchived: isChatlist ? false : Boolean(filter.excludeArchived),
        isChatlist,
    };
}

export async function listFolders(): Promise<DialogFolder[]> {
    const { filters } = await withFloodWait(() => getClient().getFolders());
    const folders: DialogFolder[] = [];

    for (const filter of filters) {
        // The default "all" filter is a sentinel, not a user folder.
        if (filter._ === 'dialogFilterDefault') {
            continue;
        }
        folders.push(toFolder(filter));
    }

    return folders;
}

export async function archiveDialog(chatId: number): Promise<void> {
    await withFloodWait(() => getClient().archiveChats(chatId));
}

export async function unarchiveDialog(chatId: number): Promise<void> {
    await withFloodWait(() => getClient().unarchiveChats(chatId));
}

export async function leaveDialog(chatId: number): Promise<void> {
    await withFloodWait(() => getClient().leaveChat(chatId));
}

/**
 * Drop a private chat — the closest thing Telegram has to deleting a bot.
 *
 * A bot's account belongs to its owner, so all an account can do is delete the
 * conversation for itself, which takes the row out of the dialog list. `delete`
 * mode removes the dialog too; `revoke` would also wipe the messages on the
 * other side, which is not ours to decide.
 */
export async function deleteDialog(chatId: number): Promise<void> {
    await withFloodWait(() =>
        getClient().deleteHistory(chatId, { mode: 'delete' }),
    );
}

/** Blocking a bot stops it messaging again after the chat is deleted. */
export async function blockDialog(chatId: number): Promise<void> {
    await withFloodWait(() => getClient().blockUser(chatId));
}

export async function getDialog(chatId: number): Promise<DialogItem> {
    const tg = getClient();
    const peer = await withFloodWait(() => tg.getPeer(chatId));
    return toDialog(peer, { isPinned: false });
}

export function rememberPeerAvatar(peer: Peer): string | undefined {
    if (!peer.photo) return undefined;
    photos.set(peer.id, peer.photo);
    if (!peer.photo.thumb) return undefined;
    try {
        return jpegDataUrl(peer.photo.thumb);
    } catch {
        return undefined;
    }
}

export async function downloadAvatar(peerId: number): Promise<string | null> {
    const cached = avatarUrls.get(peerId) ?? blobCache.get(`avatar:${peerId}`);
    if (cached) return cached;
    let photo = photos.get(peerId);
    if (!photo && listing) {
        await listing.catch(() => undefined);
        photo = photos.get(peerId);
    }
    if (!photo) return null;
    return downloadPhotoAvatar(peerId, photo);
}

/**
 * A profile photo's small size: memory, then disk, then Telegram.
 *
 * Keyed on the photo's own id, so the disk copy is reused across launches and
 * a new profile photo is a new key rather than a stale hit. Every avatar in
 * the app — library rows, the stories bar, the account menu — comes here.
 */
export async function downloadPhotoAvatar(
    peerId: number,
    photo: ChatPhoto,
): Promise<string> {
    const known = avatarUrls.get(peerId);
    if (known) return known;
    const diskKey = `avatar:${peerId}:${photo.small.uniqueFileId}`;
    let bytes = await readThumb(diskKey);
    if (!bytes) {
        bytes = await withFloodWait(() =>
            getClient().downloadAsBuffer(photo.small),
        );
        void writeThumb(diskKey, bytes, 'image/jpeg');
    }
    const url = URL.createObjectURL(bytesToBlob(bytes, 'image/jpeg'));
    avatarUrls.set(peerId, url);
    return url;
}

/**
 * The signed-in account's own avatar, for the user menu.
 *
 * `photos` is filled by listDialogs, and the account's own peer is only in
 * there when Saved Messages happens to be in the list — so ask for the peer
 * first rather than relying on that. The download itself is the shared,
 * cached one.
 */
export async function downloadSelfAvatar(): Promise<string | null> {
    const me = await withFloodWait(() => getClient().getMe());
    rememberPeerAvatar(me);
    return downloadAvatar(me.id);
}
