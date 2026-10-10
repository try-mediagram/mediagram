import { Link } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
    Archive,
    Ban,
    Bot,
    Folder,
    Inbox,
    MessageCircle,
    MoreHorizontal,
    Pin,
    Plus,
    Tags,
    Trash2,
    Users,
} from 'lucide-react';
import {
    type ReactNode,
    type RefObject,
    useEffect,
    useMemo,
    useRef,
    useState,
} from 'react';
import { toast } from 'sonner';

import { AccountBar } from '@/components/account-bar';
import { StoriesBar } from '@/components/chat-stories';
import { OpenChatRow } from '@/components/open-chat';
import { RailFooter } from '@/components/rail-footer';
import { TagGlyph } from '@/components/tag-picker-dialog';
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from '@/components/ui/popover';
import {
    Sheet,
    SheetContent,
    SheetDescription,
    SheetHeader,
    SheetTitle,
} from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { useSensitiveSettings } from '@/hooks/use-entitlement';
import { debug } from '@/lib/debug';
import { readDialogSnapshot, writeDialogSnapshot } from '@/lib/dialog-snapshot';
import { formatRelativeTime } from '@/lib/format';
import { createTag, fetchTags, normaliseTag } from '@/lib/media-tags';
import { sourceHasNewMedia } from '@/lib/source-visits';
import { parseChatTarget } from '@/lib/telegram/chat-target';
import { isRestrictedByTelegram } from '@/lib/telegram/restrictions';
import {
    canArchiveChat,
    canBlockChat,
    canDeleteChat,
    canLeaveChat,
    defaultKindFilter,
    dialogMatchesFolder,
    dialogMatchesKindFilter,
    kindLabel,
    selectVisibleDialogs,
    type LibraryKindFilter,
    type LibraryNav,
} from '@/lib/telegram/select-visible-dialogs';
import type { DialogFolder, DialogItem, MediaKind } from '@/lib/telegram/types';
import { cn } from '@/lib/utils';
import { useTelegram } from '@/providers/telegram-provider';
import type { SourceMap } from '@/types/mediagram';
import type { Tag } from '@/types/tags';

type DialogAction =
    | 'archive'
    | 'unarchive'
    | 'leave'
    | 'delete'
    | 'delete-block';

/**
 * The Show section of the rail.
 *
 * Groups and channels are what the library is for, so they are the default and
 * the bots and direct chats are one click away rather than mixed in.
 */
const KIND_FILTERS: {
    value: LibraryKindFilter;
    label: string;
    icon: typeof Inbox;
}[] = [
    { value: 'groups', label: 'Groups & channels', icon: Users },
    { value: 'direct', label: 'Direct', icon: MessageCircle },
    { value: 'bots', label: 'Bots', icon: Bot },
    { value: 'all', label: 'Everything', icon: Inbox },
];

/** A row action that asks before it runs. */
type PendingAction = {
    dialog: DialogItem;
    action: Extract<DialogAction, 'leave' | 'delete' | 'delete-block'>;
};

export function ChatList({ sources }: { sources: SourceMap }) {
    const [query, setQuery] = useState('');
    const [nav, setNav] = useState<LibraryNav>({ type: 'all' });
    const [kinds, setKinds] = useState<LibraryKindFilter>(defaultKindFilter);
    const [railOpen, setRailOpen] = useState(false);
    const [confirming, setConfirming] = useState<PendingAction | null>(null);
    const [busyId, setBusyId] = useState<number | null>(null);
    const { restrictionReasons } = useSensitiveSettings();
    const queryClient = useQueryClient();

    const accountId = useTelegram().user?.id;
    const dialogs = useQuery({
        queryKey: ['dialogs'],
        queryFn: async () => {
            const { listDialogs } = await import('@/lib/telegram/dialogs');
            const items = await listDialogs();
            writeDialogSnapshot(accountId, items);
            return items;
        },
        // Last launch's list, shown while this one loads. Dated to the epoch
        // so it always counts as stale and the real listing still runs.
        initialData: () => readDialogSnapshot(accountId),
        initialDataUpdatedAt: 0,
    });

    const folders = useQuery({
        queryKey: ['telegram-folders'],
        queryFn: async () => {
            const { listFolders } = await import('@/lib/telegram/dialogs');
            return listFolders();
        },
    });

    const tags = useQuery({
        queryKey: ['tags'],
        queryFn: fetchTags,
    });

    const libraryTags = useMemo(
        () =>
            (tags.data ?? []).map((tag) => ({
                id: tag.id,
                chatIds: tag.chats.map((item) => item.chatId),
            })),
        [tags.data],
    );

    /*
     * Everything the nav and the search allow, before the Show filter. The
     * rail counts its kinds off this, so a list emptied by "Groups" says how
     * many bots or direct chats are sitting behind the filter rather than
     * reading as "you have no chats".
     */
    const inNav = useMemo(
        () =>
            selectVisibleDialogs({
                dialogs: dialogs.data ?? [],
                folders: folders.data ?? [],
                tags: libraryTags,
                nav,
                kinds: 'all',
                search: query,
            }),
        [dialogs.data, folders.data, libraryTags, nav, query],
    );

    const filtered = useMemo(
        () => inNav.filter((dialog) => dialogMatchesKindFilter(dialog, kinds)),
        [inNav, kinds],
    );

    const patchDialogs = (updater: (current: DialogItem[]) => DialogItem[]) => {
        queryClient.setQueryData<DialogItem[]>(['dialogs'], (current) =>
            current ? updater(current) : current,
        );
    };

    const runDialogAction = async (
        dialog: DialogItem,
        action: DialogAction,
    ) => {
        setBusyId(dialog.id);
        try {
            const {
                archiveDialog,
                unarchiveDialog,
                leaveDialog,
                deleteDialog,
                blockDialog,
            } = await import('@/lib/telegram/dialogs');

            if (action === 'leave') {
                await leaveDialog(dialog.id);
                patchDialogs((current) =>
                    current.filter((item) => item.id !== dialog.id),
                );
                toast.success(`Left ${dialog.title}`);
            } else if (action === 'delete' || action === 'delete-block') {
                if (action === 'delete-block') {
                    await blockDialog(dialog.id);
                }
                await deleteDialog(dialog.id);
                patchDialogs((current) =>
                    current.filter((item) => item.id !== dialog.id),
                );
                toast.success(
                    action === 'delete-block'
                        ? `Deleted and blocked ${dialog.title}`
                        : `Deleted ${dialog.title}`,
                );
            } else if (action === 'archive') {
                await archiveDialog(dialog.id);
                patchDialogs((current) =>
                    current.map((item) =>
                        item.id === dialog.id
                            ? { ...item, isArchived: true }
                            : item,
                    ),
                );
                toast.success(`Archived ${dialog.title}`);
            } else {
                await unarchiveDialog(dialog.id);
                patchDialogs((current) =>
                    current.map((item) =>
                        item.id === dialog.id
                            ? { ...item, isArchived: false }
                            : item,
                    ),
                );
                toast.success(`Unarchived ${dialog.title}`);
            }

            void queryClient.invalidateQueries({ queryKey: ['dialogs'] });
        } catch (error) {
            debug('library', `${action} failed`, error);
            toast.error(
                error instanceof Error
                    ? error.message
                    : `Could not ${actionVerb(action)} this chat.`,
            );
        } finally {
            setBusyId(null);
            setConfirming(null);
        }
    };

    const chooseNav = (next: LibraryNav) => {
        setNav(next);
        setRailOpen(false);
    };

    const chooseKinds = (next: LibraryKindFilter) => {
        setKinds(next);
        setRailOpen(false);
    };

    const emptyMessage = emptyCopy(nav, kinds, query, inNav.length);

    /*
     * Whether what was typed is an address as well as a search term. A t.me
     * link matches no local title, so without this the library would answer a
     * pasted invite with "no chats match" — which is true and useless.
     */
    const canOpenTyped = useMemo(
        () => parseChatTarget(query) !== null,
        [query],
    );

    return (
        <div className="flex h-dvh flex-col overflow-hidden">
            <AccountBar
                title="Library"
                wide
                onOpenNav={() => setRailOpen(true)}
                search={{
                    value: query,
                    onChange: setQuery,
                    placeholder: 'Search chats, or paste a t.me link',
                    label: 'Search chats, or paste a t.me link, @handle or id',
                }}
            />
            <div className="flex min-h-0 flex-1">
                <aside className="border-border bg-muted/40 hidden min-h-0 w-60 shrink-0 flex-col border-r md:flex">
                    <LibraryRail
                        nav={nav}
                        onNav={chooseNav}
                        kinds={kinds}
                        onKinds={chooseKinds}
                        folders={folders.data ?? []}
                        tags={tags.data ?? []}
                        dialogs={dialogs.data ?? []}
                        inNav={inNav}
                        onTagsChanged={() =>
                            void queryClient.invalidateQueries({
                                queryKey: ['tags'],
                            })
                        }
                    />
                </aside>
                <main className="flex min-h-0 min-w-0 flex-1 flex-col">
                    {/*
                        Everyone's stories, above every filter: they belong to
                        the account, not to whichever folder is showing.
                    */}
                    <StoriesBar dialogs={dialogs.data ?? []} />
                    {dialogs.isPending ? (
                        <div className="flex flex-col gap-1 p-3">
                            {['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(
                                (id) => (
                                    <Skeleton
                                        key={id}
                                        className="h-14 rounded-lg"
                                    />
                                ),
                            )}
                        </div>
                    ) : dialogs.error ? (
                        <p className="text-destructive px-4 py-6 text-sm">
                            {dialogs.error instanceof Error
                                ? dialogs.error.message
                                : 'Could not load sources.'}
                        </p>
                    ) : filtered.length === 0 && !canOpenTyped ? (
                        <p className="text-muted-foreground px-4 py-16 text-center text-sm">
                            {emptyMessage}
                        </p>
                    ) : (
                        <ul className="min-h-0 flex-1 overflow-y-auto">
                            {filtered.map((dialog) => (
                                <li
                                    key={dialog.id}
                                    className="border-border border-b last:border-b-0"
                                >
                                    <SourceRow
                                        dialog={dialog}
                                        isNew={sourceHasNewMedia(
                                            dialog,
                                            sources,
                                        )}
                                        restricted={isRestrictedByTelegram(
                                            dialog.restrictionReasons,
                                            restrictionReasons,
                                        )}
                                        busy={busyId === dialog.id}
                                        onArchive={() =>
                                            void runDialogAction(
                                                dialog,
                                                dialog.isArchived
                                                    ? 'unarchive'
                                                    : 'archive',
                                            )
                                        }
                                        onConfirm={(action) =>
                                            setConfirming({ dialog, action })
                                        }
                                    />
                                </li>
                            ))}
                            {canOpenTyped ? (
                                <li className="border-border border-b last:border-b-0">
                                    <OpenChatRow query={query} />
                                </li>
                            ) : null}
                        </ul>
                    )}
                </main>
            </div>
            <Sheet open={railOpen} onOpenChange={setRailOpen}>
                <SheetContent
                    side="left"
                    className="bg-muted/40 w-72 p-0"
                    showCloseButton
                >
                    <SheetHeader className="border-border border-b">
                        <SheetTitle>Library</SheetTitle>
                        <SheetDescription className="sr-only">
                            Filter chats by folder, archive, or tag
                        </SheetDescription>
                    </SheetHeader>
                    <LibraryRail
                        nav={nav}
                        onNav={chooseNav}
                        kinds={kinds}
                        onKinds={chooseKinds}
                        folders={folders.data ?? []}
                        tags={tags.data ?? []}
                        dialogs={dialogs.data ?? []}
                        inNav={inNav}
                        onTagsChanged={() =>
                            void queryClient.invalidateQueries({
                                queryKey: ['tags'],
                            })
                        }
                    />
                </SheetContent>
            </Sheet>
            <AlertDialog
                open={confirming !== null}
                onOpenChange={(open) => {
                    if (!open) {
                        setConfirming(null);
                    }
                }}
            >
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>
                            {confirming
                                ? confirmTitle(confirming)
                                : 'Are you sure?'}
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                            {confirming ? confirmBody(confirming) : ''}
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                            variant="destructive"
                            disabled={
                                confirming !== null &&
                                busyId === confirming.dialog.id
                            }
                            onClick={() => {
                                if (confirming) {
                                    void runDialogAction(
                                        confirming.dialog,
                                        confirming.action,
                                    );
                                }
                            }}
                        >
                            {confirming
                                ? confirmLabel(confirming.action)
                                : 'Confirm'}
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </div>
    );
}

function LibraryRail({
    nav,
    onNav,
    kinds,
    onKinds,
    folders,
    tags,
    dialogs,
    inNav,
    onTagsChanged,
}: {
    nav: LibraryNav;
    onNav: (nav: LibraryNav) => void;
    kinds: LibraryKindFilter;
    onKinds: (kinds: LibraryKindFilter) => void;
    folders: DialogFolder[];
    tags: Tag[];
    dialogs: DialogItem[];
    /** What the nav and search allow, so Show can count its own kinds. */
    inNav: DialogItem[];
    /** A tag was made here; the library's copy of the vocabulary is stale. */
    onTagsChanged: () => void;
}) {
    /*
     * Both directions of the rail count what the other one allows: a nav row
     * counts within the chosen Show filter, a Show row within the chosen nav.
     * Otherwise "All 240" sits above a list of nine groups.
     */
    const ofKind = dialogs.filter((item) =>
        dialogMatchesKindFilter(item, kinds),
    );
    const allCount = ofKind.filter((item) => !item.isArchived).length;
    const archiveCount = ofKind.filter((item) => item.isArchived).length;
    const countOfKind = (kind: LibraryKindFilter) =>
        inNav.filter((item) => dialogMatchesKindFilter(item, kind)).length;

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <nav
                aria-label="Library filters"
                className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-2"
            >
                <NavButton
                    active={nav.type === 'all'}
                    icon={Inbox}
                    label="All"
                    count={allCount}
                    onClick={() => onNav({ type: 'all' })}
                />
                <NavButton
                    active={nav.type === 'archive'}
                    icon={Archive}
                    label="Archive"
                    count={archiveCount}
                    onClick={() => onNav({ type: 'archive' })}
                />
                <RailHeading>Show</RailHeading>
                {KIND_FILTERS.map((item) => (
                    <NavButton
                        key={item.value}
                        active={kinds === item.value}
                        icon={item.icon}
                        label={item.label}
                        count={countOfKind(item.value)}
                        onClick={() => onKinds(item.value)}
                    />
                ))}
                {folders.length > 0 ? <RailHeading>Folders</RailHeading> : null}
                {folders.map((item) => (
                    <NavButton
                        key={item.id}
                        active={nav.type === 'folder' && nav.id === item.id}
                        icon={Folder}
                        label={item.title}
                        count={
                            ofKind.filter((dialog) =>
                                dialogMatchesFolder(dialog, item),
                            ).length
                        }
                        onClick={() => onNav({ type: 'folder', id: item.id })}
                    />
                ))}
                <RailHeading
                    action={<NewTagButton onCreated={onTagsChanged} />}
                >
                    Tags
                </RailHeading>
                {tags
                    .filter((tag) => tag.pinned)
                    .map((tag) => (
                        <PinnedTag key={tag.id} tag={tag} />
                    ))}
                {tags.some((tag) => tag.pinned) ? null : (
                    <p className="text-muted-foreground px-2.5 pb-1 text-xs text-pretty">
                        Pin a tag from its page and it shows up here.
                    </p>
                )}
                <Link
                    to="/tags"
                    className={cn(
                        'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors duration-150',
                        'focus-visible:ring-ring/50 outline-none focus-visible:ring-2',
                        'text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground',
                    )}
                >
                    <Tags className="size-4 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">All tags</span>
                    <span className="text-muted-foreground text-xs tabular-nums">
                        {tags.length}
                    </span>
                </Link>
            </nav>

            <RailFooter />
        </div>
    );
}

/**
 * A pinned tag in the rail. It opens the tag's own page, with everything it
 * is on across every chat.
 */
function PinnedTag({ tag }: { tag: Tag }) {
    return (
        <Link
            to="/tag/$name"
            params={{ name: tag.name }}
            className={cn(
                'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors duration-150',
                'focus-visible:ring-ring/50 outline-none focus-visible:ring-2',
                'text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground',
            )}
        >
            <TagGlyph
                name={tag.name}
                className={cn(
                    'size-4 shrink-0',
                    tag.name === 'favorite' && 'text-rose-500',
                    tag.name === 'bookmark' && 'text-amber-400',
                )}
            />
            <span className="min-w-0 flex-1 truncate">{tag.name}</span>
            {tag.count > 0 ? (
                <span className="text-muted-foreground text-xs tabular-nums">
                    {tag.count.toLocaleString()}
                </span>
            ) : null}
        </Link>
    );
}

function RailHeading({
    children,
    action,
}: {
    children: string;
    action?: ReactNode;
}) {
    return (
        <div className="mt-4 mb-1 flex h-6 items-center justify-between gap-1 pr-0.5 pl-2.5">
            <p className="text-muted-foreground text-[11px] font-medium tracking-[0.14em] uppercase">
                {children}
            </p>
            {action}
        </div>
    );
}

/**
 * Grows the tag vocabulary from the rail.
 *
 * A tag is a word and nothing else, so this is a field and a button rather than
 * a trip to /tags — the rail is where the tags are, so it is where a new one is
 * wanted. The cap is the server's answer, not a count kept here: a 402 comes
 * back as `limited` and the pitch is already in the rail below.
 */
function NewTagButton({ onCreated }: { onCreated: () => void }) {
    const [open, setOpen] = useState(false);
    const [draft, setDraft] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [creating, setCreating] = useState(false);

    const create = async () => {
        const name = normaliseTag(draft);

        if (name === null) {
            setError(
                'A tag is a single word: letters, numbers, dashes or underscores.',
            );
            return;
        }

        setCreating(true);
        try {
            await createTag(name);

            setDraft('');
            setOpen(false);
            onCreated();
        } catch (caught) {
            debug('library', 'tag create failed', caught);
            setError(
                caught instanceof Error
                    ? caught.message
                    : 'Could not make that tag.',
            );
        } finally {
            setCreating(false);
        }
    };

    return (
        <Popover
            open={open}
            onOpenChange={(next) => {
                setOpen(next);
                setError(null);
            }}
        >
            <PopoverTrigger
                render={
                    <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        aria-label="New tag"
                        title="New tag"
                        className="text-muted-foreground hover:text-foreground"
                    />
                }
            >
                <Plus />
            </PopoverTrigger>
            <PopoverContent align="start" className="w-60 gap-2">
                <form
                    className="flex items-center gap-1.5"
                    onSubmit={(event) => {
                        event.preventDefault();
                        void create();
                    }}
                >
                    <Input
                        value={draft}
                        onChange={(event) => {
                            setDraft(event.target.value);
                            setError(null);
                        }}
                        placeholder="New tag"
                        maxLength={32}
                        aria-label="New tag"
                        className="h-7 text-xs"
                    />
                    <Button
                        type="submit"
                        size="xs"
                        disabled={creating || draft.trim() === ''}
                    >
                        {creating ? <Spinner /> : 'Add'}
                    </Button>
                </form>

                {error ? (
                    <p className="text-destructive text-xs text-pretty">
                        {error}
                    </p>
                ) : null}
            </PopoverContent>
        </Popover>
    );
}

function NavButton({
    active,
    icon: Icon,
    label,
    count,
    onClick,
}: {
    active: boolean;
    icon: typeof Inbox;
    label: string;
    count?: number;
    onClick: () => void;
}) {
    return (
        <button
            type="button"
            aria-current={active ? 'true' : undefined}
            onClick={onClick}
            className={cn(
                'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors duration-150',
                'focus-visible:ring-ring/50 outline-none focus-visible:ring-2',
                active
                    ? 'bg-accent text-accent-foreground font-medium'
                    : 'text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground',
            )}
        >
            <Icon className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{label}</span>
            {typeof count === 'number' ? (
                <span className="text-[11px] font-medium tabular-nums opacity-70">
                    {count}
                </span>
            ) : null}
        </button>
    );
}

function SourceRow({
    dialog,
    isNew,
    restricted,
    busy,
    onArchive,
    onConfirm,
}: {
    dialog: DialogItem;
    isNew: boolean;
    /** Telegram flags it adult. Shown as a label, never hidden or dimmed. */
    restricted: boolean;
    busy: boolean;
    onArchive: () => void;
    onConfirm: (action: PendingAction['action']) => void;
}) {
    const rootRef = useRef<HTMLDivElement>(null);
    const { src, broken, setBroken } = useAvatarLoad({ dialog, rootRef });
    const showLeave = canLeaveChat(dialog.kind);
    const showDelete = canDeleteChat(dialog.kind);
    const showBlock = canBlockChat(dialog.kind);
    const showArchive = canArchiveChat(dialog);

    return (
        <div
            ref={rootRef}
            className="group hover:bg-muted/60 flex items-stretch transition-colors duration-150"
        >
            <Link
                to="/c/$chatId"
                params={{ chatId: String(dialog.id) }}
                preload="intent"
                className="focus-visible:ring-ring/70 flex min-w-0 flex-1 items-center gap-3 px-3 py-2.5 text-left focus-visible:ring-2 focus-visible:outline-none sm:px-4"
            >
                <SourceAvatar
                    dialog={dialog}
                    src={src}
                    broken={broken}
                    onBroken={() => setBroken(true)}
                />
                <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-3">
                        <h2 className="min-w-0 truncate text-sm font-medium">
                            {dialog.title}
                        </h2>
                        {restricted ? (
                            <span className="bg-secondary text-muted-foreground shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium">
                                18+
                            </span>
                        ) : isNew ? (
                            <span className="bg-primary/15 text-primary shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium">
                                New
                            </span>
                        ) : null}
                    </div>
                    <p className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
                        {dialog.isPinned ? (
                            <Pin
                                className="size-3 shrink-0"
                                aria-label="Pinned"
                            />
                        ) : null}
                        <span>{kindLabel(dialog.kind)}</span>
                        {dialog.lastMediaKind ? (
                            <>
                                <span aria-hidden="true">·</span>
                                <span>
                                    {mediaKindLabel(dialog.lastMediaKind)}
                                </span>
                            </>
                        ) : null}
                        {dialog.lastMediaAt || dialog.lastMessageAt ? (
                            <>
                                <span aria-hidden="true">·</span>
                                <span>
                                    {formatRelativeTime(
                                        dialog.lastMediaAt ||
                                            dialog.lastMessageAt ||
                                            '',
                                    )}
                                </span>
                            </>
                        ) : null}
                    </p>
                    {dialog.username ? (
                        <p className="text-muted-foreground truncate text-[11px]">
                            @{dialog.username}
                        </p>
                    ) : null}
                </div>
            </Link>
            {showArchive || showLeave || showDelete ? (
                <div className="flex items-center pr-2">
                    <DropdownMenu>
                        <DropdownMenuTrigger
                            disabled={busy}
                            render={
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon-sm"
                                    aria-label={`Actions for ${dialog.title}`}
                                    className="text-muted-foreground"
                                />
                            }
                        >
                            <MoreHorizontal />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent
                            align="end"
                            className="w-auto min-w-40"
                        >
                            {showArchive ? (
                                <DropdownMenuItem
                                    disabled={busy}
                                    onClick={onArchive}
                                >
                                    <Archive />
                                    {dialog.isArchived
                                        ? 'Unarchive'
                                        : 'Archive'}
                                </DropdownMenuItem>
                            ) : null}
                            {showLeave ? (
                                <DropdownMenuItem
                                    disabled={busy}
                                    variant="destructive"
                                    onClick={() => onConfirm('leave')}
                                >
                                    Leave
                                </DropdownMenuItem>
                            ) : null}
                            {showDelete ? (
                                <DropdownMenuItem
                                    disabled={busy}
                                    variant="destructive"
                                    onClick={() => onConfirm('delete')}
                                >
                                    <Trash2 />
                                    Delete chat
                                </DropdownMenuItem>
                            ) : null}
                            {showBlock ? (
                                <DropdownMenuItem
                                    disabled={busy}
                                    variant="destructive"
                                    onClick={() => onConfirm('delete-block')}
                                >
                                    <Ban />
                                    Delete and block
                                </DropdownMenuItem>
                            ) : null}
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>
            ) : null}
        </div>
    );
}

/** Lazily fetch a chat's avatar once its row scrolls into view. */
function useAvatarLoad({
    dialog,
    rootRef,
}: {
    dialog: DialogItem;
    rootRef: RefObject<HTMLDivElement | null>;
}) {
    const [src, setSrc] = useState<string | null>(dialog.avatarPreview ?? null);
    const [broken, setBroken] = useState(false);

    useEffect(() => {
        setSrc(dialog.avatarPreview ?? null);
        setBroken(false);
    }, [dialog.avatarPreview]);

    useEffect(() => {
        if (!dialog.hasPhoto) return;

        const node = rootRef.current;
        if (!node) return;

        let live = true;
        const observer = new IntersectionObserver(
            ([entry]) => {
                if (!entry?.isIntersecting) return;
                observer.disconnect();
                void import('@/lib/telegram/dialogs')
                    .then((mod) => mod.downloadAvatar(dialog.id))
                    .then((url) => {
                        if (!live || !url) return;
                        setBroken(false);
                        setSrc(url);
                    })
                    .catch(() => undefined);
            },
            { rootMargin: '160px' },
        );
        observer.observe(node);
        return () => {
            live = false;
            observer.disconnect();
        };
    }, [dialog.hasPhoto, dialog.id, rootRef]);

    return { src, broken, setBroken };
}

function SourceAvatar({
    dialog,
    src,
    broken,
    onBroken,
}: {
    dialog: DialogItem;
    src: string | null;
    broken: boolean;
    onBroken: () => void;
}) {
    return (
        <div className="bg-muted grid size-10 shrink-0 place-items-center overflow-hidden rounded-full text-xs font-semibold">
            {src && !broken ? (
                <img
                    src={src}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    className="size-full object-cover"
                    onError={onBroken}
                />
            ) : (
                <span>{initials(dialog.title)}</span>
            )}
        </div>
    );
}

function initials(title: string) {
    const parts = title.trim().split(/\s+/).slice(0, 2);
    return parts.map((part) => part[0]?.toUpperCase() ?? '').join('') || '·';
}

function mediaKindLabel(kind: MediaKind) {
    switch (kind) {
        case 'photo':
            return 'Photo';
        case 'gif':
            return 'GIF';
        case 'audio':
            return 'Audio';
        case 'voice':
            return 'Voice';
        default:
            return 'Video';
    }
}

function actionVerb(action: DialogAction): string {
    switch (action) {
        case 'delete':
            return 'delete';
        case 'delete-block':
            return 'delete and block';
        default:
            return action;
    }
}

function confirmLabel(action: PendingAction['action']): string {
    switch (action) {
        case 'leave':
            return 'Leave';
        case 'delete':
            return 'Delete';
        default:
            return 'Delete and block';
    }
}

function confirmTitle({ dialog, action }: PendingAction): string {
    switch (action) {
        case 'leave':
            return `Leave ${dialog.title}?`;
        case 'delete':
            return `Delete chat with ${dialog.title}?`;
        default:
            return `Delete and block ${dialog.title}?`;
    }
}

/**
 * Why a bot cannot simply be deleted.
 *
 * A bot's account is its owner's, so Telegram only lets an account drop the
 * conversation for itself — and block it, which is what stops it coming back.
 */
function confirmBody({ dialog, action }: PendingAction): string {
    if (action === 'leave') {
        return `You will leave this ${kindLabel(dialog.kind).toLowerCase()}. Rejoining may need an invite.`;
    }

    const subject =
        dialog.kind === 'bot'
            ? 'The bot keeps existing on Telegram, but the chat leaves your list and its messages are deleted for you.'
            : 'The chat leaves your list and its messages are deleted for you. The other person keeps their copy.';

    return action === 'delete-block'
        ? `${subject} Blocking also stops ${dialog.title} messaging you again — undo it from Telegram's Blocked users.`
        : subject;
}

function emptyCopy(
    nav: LibraryNav,
    kinds: LibraryKindFilter,
    query: string,
    inNavCount: number,
): string {
    /*
     * A list emptied by the Show filter is not an empty account. Say what the
     * filter is holding back, since the default hides bots and direct chats.
     */
    if (kinds !== 'all' && inNavCount > 0) {
        return `Nothing here under ${showLabel(kinds)}. ${inNavCount} other ${inNavCount === 1 ? 'chat is' : 'chats are'} hidden by that filter — pick Everything in the left panel to see ${inNavCount === 1 ? 'it' : 'them'}.`;
    }

    if (query.trim() !== '') {
        return 'No sources match that search.';
    }

    switch (nav.type) {
        case 'archive':
            return 'No archived chats.';
        case 'folder':
            return 'No chats in this folder.';
        case 'tag':
            return 'No chats carry this tag.';
        default:
            return 'No chats to show.';
    }
}

function showLabel(kinds: LibraryKindFilter): string {
    return (
        KIND_FILTERS.find((item) => item.value === kinds)?.label ??
        'this filter'
    );
}
