import type { ChatKind, DialogFolder, DialogItem } from './types';

export type LibraryNav =
    | { type: 'all' }
    | { type: 'archive' }
    | { type: 'folder'; id: number }
    | { type: 'tag'; id: number };

/**
 * Which kinds of chat the library shows, on top of the nav choice.
 *
 * Mediagram reads media out of groups and channels, so those are the default
 * and a private chat or a bot is opt-in — see `defaultKindFilter`.
 */
export type LibraryKindFilter = 'groups' | 'direct' | 'bots' | 'all';

export const defaultKindFilter: LibraryKindFilter = 'groups';

export type LibraryTag = {
    id: number;
    chatIds: readonly number[];
};

export type VisibleDialogSelection = {
    dialogs: readonly DialogItem[];
    folders: readonly DialogFolder[];
    tags: readonly LibraryTag[];
    nav: LibraryNav;
    kinds: LibraryKindFilter;
    search: string;
};

/**
 * The chats the library shows for one nav choice plus a search needle.
 *
 * Folder matching follows Telegram's own rules (explicit include/pin,
 * exclude, then kind flags) so we can list dialogs once and filter in
 * memory instead of refetching per folder.
 */
export function selectVisibleDialogs({
    dialogs,
    folders,
    tags,
    nav,
    kinds,
    search,
}: VisibleDialogSelection): DialogItem[] {
    const needle = search.trim().toLowerCase();

    return dialogs.filter((dialog) => {
        if (!matchesNav(dialog, nav, folders, tags)) {
            return false;
        }

        if (!dialogMatchesKindFilter(dialog, kinds)) {
            return false;
        }

        return matchesSearch(dialog, needle);
    });
}

/**
 * A chat's place in the rail's Show section.
 *
 * Saved Messages is a conversation with yourself, so it sits with the direct
 * chats; the legacy "chat" kind is a small group and sits with the groups.
 */
export function kindFilterOf(
    kind: ChatKind,
): Exclude<LibraryKindFilter, 'all'> {
    switch (kind) {
        case 'bot':
            return 'bots';
        case 'direct':
        case 'saved':
            return 'direct';
        default:
            return 'groups';
    }
}

export function dialogMatchesKindFilter(
    dialog: Pick<DialogItem, 'kind'>,
    kinds: LibraryKindFilter,
): boolean {
    return kinds === 'all' || kindFilterOf(dialog.kind) === kinds;
}

export function dialogMatchesFolder(
    dialog: DialogItem,
    folder: DialogFolder,
): boolean {
    if (
        folder.includePeerIds.includes(dialog.id) ||
        folder.pinnedPeerIds.includes(dialog.id)
    ) {
        return true;
    }

    if (folder.excludePeerIds.includes(dialog.id)) {
        return false;
    }

    if (folder.isChatlist) {
        return false;
    }

    if (folder.excludeRead && !dialog.isUnread) {
        return false;
    }

    if (folder.excludeMuted && dialog.isMuted) {
        return false;
    }

    if (folder.excludeArchived && dialog.isArchived) {
        return false;
    }

    const isUser =
        dialog.kind === 'direct' ||
        dialog.kind === 'saved' ||
        dialog.kind === 'bot';

    if (folder.contacts && isUser && dialog.isContact) {
        return true;
    }

    if (folder.nonContacts && isUser && !dialog.isContact) {
        return true;
    }

    if (folder.groups && dialog.kind === 'group') {
        return true;
    }

    if (folder.broadcasts && dialog.kind === 'channel') {
        return true;
    }

    if (folder.bots && dialog.kind === 'bot') {
        return true;
    }

    return false;
}

export function kindLabel(kind: ChatKind): string {
    switch (kind) {
        case 'saved':
            return 'Saved';
        case 'direct':
            return 'Direct';
        case 'bot':
            return 'Bot';
        case 'group':
            return 'Group';
        case 'channel':
            return 'Channel';
        default:
            return 'Chat';
    }
}

export function canLeaveChat(kind: ChatKind): boolean {
    return kind === 'group' || kind === 'channel';
}

export function canArchiveChat(dialog: Pick<DialogItem, 'isSelf'>): boolean {
    return !dialog.isSelf;
}

/**
 * A private chat is deleted rather than left.
 *
 * Telegram has no way to delete a bot's account — the most you can do is drop
 * the conversation (and optionally block the bot), which takes it out of the
 * list. Groups and channels keep their Leave action instead.
 */
export function canDeleteChat(kind: ChatKind): boolean {
    return kind === 'direct' || kind === 'bot';
}

export function canBlockChat(kind: ChatKind): boolean {
    return kind === 'bot' || kind === 'direct';
}

function matchesNav(
    dialog: DialogItem,
    nav: LibraryNav,
    folders: readonly DialogFolder[],
    tags: readonly LibraryTag[],
): boolean {
    switch (nav.type) {
        case 'all':
            return !dialog.isArchived;
        case 'archive':
            return dialog.isArchived;
        case 'folder': {
            const folder = folders.find((item) => item.id === nav.id);
            return folder ? dialogMatchesFolder(dialog, folder) : false;
        }
        case 'tag': {
            const tag = tags.find((item) => item.id === nav.id);
            return tag ? tag.chatIds.includes(dialog.id) : false;
        }
    }
}

function matchesSearch(dialog: DialogItem, needle: string): boolean {
    if (needle === '') {
        return true;
    }

    return (
        dialog.title.toLowerCase().includes(needle) ||
        (dialog.username?.toLowerCase().includes(needle) ?? false)
    );
}
