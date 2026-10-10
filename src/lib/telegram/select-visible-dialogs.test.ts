import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    canDeleteChat,
    canLeaveChat,
    defaultKindFilter,
    selectVisibleDialogs,
    type LibraryKindFilter,
    type LibraryNav,
} from './select-visible-dialogs.ts';
import type { DialogFolder, DialogItem } from './types.ts';

function dialog(
    id: number,
    title: string,
    extra: Partial<DialogItem> = {},
): DialogItem {
    return {
        id,
        title,
        username: extra.username ?? null,
        kind: extra.kind ?? 'channel',
        isPinned: extra.isPinned ?? false,
        isSelf: extra.isSelf ?? false,
        hasPhoto: extra.hasPhoto ?? false,
        isRestricted: extra.isRestricted ?? false,
        restrictionReasons: extra.restrictionReasons ?? [],
        unreadCount: extra.unreadCount ?? 0,
        isArchived: extra.isArchived ?? false,
        isMuted: extra.isMuted ?? false,
        isUnread: extra.isUnread ?? false,
        isContact: extra.isContact ?? false,
        isMember: extra.isMember ?? true,
        canSendMedia: extra.canSendMedia ?? true,
        sendBlockedReason: extra.sendBlockedReason ?? null,
        canWrite: extra.canWrite ?? true,
        writeBlockedReason: extra.writeBlockedReason ?? null,
        hasProtectedContent: extra.hasProtectedContent ?? false,
        lastMessageAt: extra.lastMessageAt,
        lastMessageId: extra.lastMessageId,
        lastMediaId: extra.lastMediaId,
        lastMediaAt: extra.lastMediaAt,
        lastMediaKind: extra.lastMediaKind,
        avatarPreview: extra.avatarPreview,
    };
}

function folder(
    id: number,
    title: string,
    extra: Partial<DialogFolder> = {},
): DialogFolder {
    return {
        id,
        title,
        includePeerIds: extra.includePeerIds ?? [],
        excludePeerIds: extra.excludePeerIds ?? [],
        pinnedPeerIds: extra.pinnedPeerIds ?? [],
        contacts: extra.contacts ?? false,
        nonContacts: extra.nonContacts ?? false,
        groups: extra.groups ?? false,
        broadcasts: extra.broadcasts ?? false,
        bots: extra.bots ?? false,
        excludeMuted: extra.excludeMuted ?? false,
        excludeRead: extra.excludeRead ?? false,
        excludeArchived: extra.excludeArchived ?? false,
        isChatlist: extra.isChatlist ?? false,
    };
}

function ids(
    dialogs: readonly DialogItem[],
    nav: LibraryNav,
    extra: {
        folders?: DialogFolder[];
        tags?: { id: number; chatIds: number[] }[];
        kinds?: LibraryKindFilter;
        search?: string;
    } = {},
): number[] {
    return selectVisibleDialogs({
        dialogs,
        folders: extra.folders ?? [],
        tags: extra.tags ?? [],
        nav,
        kinds: extra.kinds ?? 'all',
        search: extra.search ?? '',
    }).map((item) => item.id);
}

const news = dialog(1, 'News Channel', {
    username: 'worldnews',
    kind: 'channel',
});
const work = dialog(2, 'Work Group', { kind: 'group', isUnread: true });
const alice = dialog(3, 'Alice', { kind: 'direct', isContact: true });
const bob = dialog(4, 'Bob', {
    kind: 'direct',
    isContact: false,
    username: 'bobdev',
});
const bot = dialog(5, 'Helper Bot', { kind: 'bot' });
const archivedNews = dialog(6, 'Old News', {
    kind: 'channel',
    isArchived: true,
});
const mutedGroup = dialog(7, 'Muted Group', {
    kind: 'group',
    isMuted: true,
    isUnread: true,
});
const pinnedWork = dialog(8, 'Pinned Client', {
    kind: 'channel',
    isPinned: true,
});

const allDialogs = [
    news,
    work,
    alice,
    bob,
    bot,
    archivedNews,
    mutedGroup,
    pinnedWork,
];

const workFolder = folder(11, 'Work', {
    includePeerIds: [8],
    excludePeerIds: [7],
    groups: true,
    broadcasts: true,
    excludeArchived: true,
    excludeMuted: true,
});

const peopleFolder = folder(12, 'People', {
    contacts: true,
    nonContacts: true,
});

const botsFolder = folder(13, 'Bots', { bots: true });

const shareFolder = folder(14, 'Shared', {
    isChatlist: true,
    includePeerIds: [1],
    pinnedPeerIds: [2],
});

describe('selectVisibleDialogs', () => {
    it('keeps non-archived chats in All and only archived chats in Archive', () => {
        assert.deepEqual(
            ids(allDialogs, { type: 'all' }),
            [1, 2, 3, 4, 5, 7, 8],
        );
        assert.deepEqual(ids(allDialogs, { type: 'archive' }), [6]);
    });

    it('applies a folder include, exclude, and kind flags', () => {
        assert.deepEqual(
            ids(
                allDialogs,
                { type: 'folder', id: 11 },
                { folders: [workFolder] },
            ),
            [1, 2, 8],
        );
        assert.deepEqual(
            ids(
                [
                    ...allDialogs,
                    dialog(9, 'Muted News', { kind: 'channel', isMuted: true }),
                ],
                { type: 'folder', id: 11 },
                { folders: [workFolder] },
            ),
            [1, 2, 8],
        );
    });

    it('matches contact and non-contact users from kind flags', () => {
        assert.deepEqual(
            ids(
                allDialogs,
                { type: 'folder', id: 12 },
                { folders: [peopleFolder] },
            ),
            [3, 4, 5],
        );
        assert.deepEqual(
            ids(
                allDialogs,
                { type: 'folder', id: 13 },
                { folders: [botsFolder] },
            ),
            [5],
        );
        assert.deepEqual(
            ids(
                allDialogs,
                { type: 'folder', id: 12 },
                {
                    folders: [folder(12, 'Contacts', { contacts: true })],
                },
            ),
            [3],
        );
    });

    it('limits a chatlist folder to include and pinned peers', () => {
        assert.deepEqual(
            ids(
                allDialogs,
                { type: 'folder', id: 14 },
                { folders: [shareFolder] },
            ),
            [1, 2],
        );
    });

    it('shows chats a Mediagram tag names', () => {
        assert.deepEqual(
            ids(
                allDialogs,
                { type: 'tag', id: 90 },
                {
                    tags: [{ id: 90, chatIds: [1, 6, 99] }],
                },
            ),
            [1, 6],
        );
    });

    it('filters the visible list by title or username', () => {
        assert.deepEqual(
            ids(allDialogs, { type: 'all' }, { search: 'news' }),
            [1],
        );
        assert.deepEqual(
            ids(allDialogs, { type: 'all' }, { search: 'bobdev' }),
            [4],
        );
        assert.deepEqual(
            ids(allDialogs, { type: 'archive' }, { search: 'news' }),
            [6],
        );
        assert.deepEqual(
            ids(
                allDialogs,
                { type: 'folder', id: 11 },
                {
                    folders: [workFolder],
                    search: 'work',
                },
            ),
            [2],
        );
        assert.deepEqual(
            ids(
                allDialogs,
                { type: 'tag', id: 90 },
                {
                    tags: [{ id: 90, chatIds: [1, 6] }],
                    search: 'old',
                },
            ),
            [6],
        );
    });

    it('returns nothing when the chosen folder or tag is missing', () => {
        assert.deepEqual(ids(allDialogs, { type: 'folder', id: 404 }), []);
        assert.deepEqual(ids(allDialogs, { type: 'tag', id: 404 }), []);
    });

    it('shows only groups and channels by default', () => {
        assert.equal(defaultKindFilter, 'groups');
        assert.deepEqual(
            ids(allDialogs, { type: 'all' }, { kinds: defaultKindFilter }),
            [1, 2, 7, 8],
        );
    });

    it('keeps Saved Messages with the direct chats and bots on their own', () => {
        const saved = dialog(10, 'Saved Messages', {
            kind: 'saved',
            isSelf: true,
        });
        const legacy = dialog(11, 'Old Chat', { kind: 'chat' });
        const everything = [...allDialogs, saved, legacy];

        assert.deepEqual(
            ids(everything, { type: 'all' }, { kinds: 'direct' }),
            [3, 4, 10],
        );
        assert.deepEqual(
            ids(everything, { type: 'all' }, { kinds: 'bots' }),
            [5],
        );
        assert.deepEqual(
            ids(everything, { type: 'all' }, { kinds: 'groups' }),
            [1, 2, 7, 8, 11],
        );
    });

    it('narrows a folder or a search the same way', () => {
        assert.deepEqual(
            ids(
                allDialogs,
                { type: 'folder', id: 13 },
                { folders: [botsFolder], kinds: 'groups' },
            ),
            [],
        );
        assert.deepEqual(
            ids(
                allDialogs,
                { type: 'all' },
                { kinds: 'groups', search: 'bob' },
            ),
            [],
        );
    });
});

describe('row actions', () => {
    it('leaves groups and channels but deletes private chats', () => {
        assert.equal(canLeaveChat('group'), true);
        assert.equal(canLeaveChat('channel'), true);
        assert.equal(canLeaveChat('bot'), false);
        assert.equal(canDeleteChat('bot'), true);
        assert.equal(canDeleteChat('direct'), true);
        assert.equal(canDeleteChat('saved'), false);
        assert.equal(canDeleteChat('group'), false);
    });
});
