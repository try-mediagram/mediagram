import { CheckSquare, FolderDown, Lock, Upload } from 'lucide-react';
import {
    useInfiniteQuery,
    useQuery,
    useQueryClient,
} from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { AccountBar } from '@/components/account-bar';
import { ChatIdentity } from '@/components/chat-context';
import { SelectionBar } from '@/components/selection-bar';
import { ChatSearchResults } from '@/components/chat-search-results';
import { StoriesCarousel, useChatStoryCount } from '@/components/chat-stories';
import { ChatStream } from '@/components/chat-stream';
import { TagPanel } from '@/components/tag-panel';
import { ExportDialog } from '@/components/export-dialog';
import { Lightbox } from '@/components/lightbox';
import {
    MediaFilters,
    MediaToolbar,
    type MediaSearchState,
} from '@/components/media-filters';
import { RailFooter } from '@/components/rail-footer';
import { JoinChatBanner } from '@/components/join-chat-banner';
import { ThumbImage } from '@/components/thumb-image';
import { UploadDialog } from '@/components/upload-dialog';
import { Button } from '@/components/ui/button';
import { Segmented } from '@/components/ui/segmented';
import {
    Sheet,
    SheetContent,
    SheetDescription,
    SheetHeader,
    SheetTitle,
} from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { useSensitiveSettings } from '@/hooks/use-entitlement';
import { useTyping } from '@/hooks/use-typing';
import { debugChange } from '@/lib/debug';
import {
    fetchChatVocabulary,
    fetchTaggedIds,
    fetchTagsOn,
} from '@/lib/media-tags';
import { fetchSeenOn, seenKey } from '@/lib/seen-media';
import { markSourceVisited } from '@/lib/source-visits';
import { describeSendBlock } from '@/lib/telegram/can-send';
import { isRestrictedByTelegram } from '@/lib/telegram/restrictions';
import type { DialogItem, MediaItem, MediaPage } from '@/lib/telegram/types';
import { cn } from '@/lib/utils';
import type { MediaItemTag } from '@/types/tags';

const SKELETONS = [
    'a',
    'b',
    'c',
    'd',
    'e',
    'f',
    'g',
    'h',
    'i',
    'j',
    'k',
    'l',
    'm',
    'n',
    'o',
];

/** How close to the end of the loaded media the viewer gets before we refill. */
const PREFETCH_AHEAD = 2;

/**
 * The grid's columns, and what the chat pane costs them.
 *
 * The pane takes 20rem out of the width the tiles were sharing, so five
 * columns beside it are five thumbnails the size of stamps. Closing it is what
 * takes the grid back to five: the toggle over the grid trades the chat for
 * the width rather than hiding the chat with nothing put in its place. Below
 * lg the pane is a sheet and costs the grid nothing, so both shapes agree
 * there.
 */
/**
 * What the centre of the screen is for.
 *
 * A conversation with a person is read and written, so it opens on the chat
 * itself, with the search box looking through its messages. Groups and
 * channels open on their media, which is what Mediagram is for, with the chat
 * in the rail. Either can be switched to the other.
 */
type CenterView = 'chat' | 'media';

function defaultView(dialog: DialogItem | undefined): CenterView {
    if (!dialog) return 'media';
    return dialog.kind === 'direct' ||
        dialog.kind === 'bot' ||
        dialog.kind === 'saved'
        ? 'chat'
        : 'media';
}

const GRID_COLUMNS = {
    open: 'grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-3',
    closed: 'grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5',
} as const;

function GridSkeleton({ columns }: { columns: string }) {
    return (
        <div className={columns}>
            {SKELETONS.map((id) => (
                <Skeleton key={id} className="aspect-square rounded-lg" />
            ))}
        </div>
    );
}

export function MediaGrid({
    chatId,
    filters,
    onFiltersChange,
}: {
    chatId: number;
    filters: MediaSearchState;
    onFiltersChange: (next: MediaSearchState) => void;
}) {
    const [openIndex, setOpenIndex] = useState<number | null>(null);
    const [railOpen, setRailOpen] = useState(false);
    // The chat opens with the grid, because it is what the media came out of.
    // Reading it is the default; the wider grid is the thing asked for.
    const [chatSheetOpen, setChatSheetOpen] = useState(false);
    // Set when Next ran past the last loaded item: a step is owed, and gets
    // taken as soon as the page it is waiting on arrives.
    const [stepOwed, setStepOwed] = useState(false);
    const [exportOpen, setExportOpen] = useState(false);
    const [uploadOpen, setUploadOpen] = useState(false);
    const [selecting, setSelecting] = useState(false);
    const [selected, setSelected] = useState<ReadonlySet<number>>(
        () => new Set(),
    );
    // Where the last tick landed, so shift-click knows what range is meant.
    const [anchorIndex, setAnchorIndex] = useState<number | null>(null);
    const { restrictionReasons } = useSensitiveSettings();
    const [viewChoice, setViewChoice] = useState<CenterView | null>(null);
    const [focus, setFocus] = useState<{ id: number; nonce: number } | null>(
        null,
    );

    const queryClient = useQueryClient();

    // The library already holds this chat: start from its copy, so the screen
    // draws on the click instead of waiting behind whatever the connection is
    // busy with, and refresh from Telegram underneath. The copy is dated to
    // when the library got it, which makes it stale and the refresh certain.
    const listed = () =>
        queryClient
            .getQueryData<DialogItem[]>(['dialogs'])
            ?.find((item) => item.id === chatId);

    const chat = useQuery({
        queryKey: ['dialog', chatId],
        queryFn: async () => {
            const { getDialog } = await import('@/lib/telegram/dialogs');
            return withListState(await getDialog(chatId), listed());
        },
        initialData: listed,
        initialDataUpdatedAt: () =>
            queryClient.getQueryState(['dialogs'])?.dataUpdatedAt,
    });

    // Telegram's own flag, read straight off the peer. It never hides a chat:
    // it only means Telegram's sensitive-content filter has to be off before
    // Telegram will serve the media, so that is switched off below.
    const restricted = chat.data
        ? isRestrictedByTelegram(
              chat.data.restrictionReasons,
              restrictionReasons,
          )
        : false;

    // Until the dialog resolves we do not know whether the filter needs
    // clearing first, so the grid shows a skeleton.
    const checking = chat.isPending;

    // Telegram withholds sensitive content until the account's own filter is
    // off, so a restricted chat clears that before the grid asks for anything.
    // The switch belongs to the account and outlives this visit, which is why
    // the query is keyed once and not per chat.
    const sensitive = useQuery({
        queryKey: ['content-settings'],
        enabled: restricted,
        staleTime: Infinity,
        // One attempt: a failure is answered by loading the media anyway, so
        // three silent retries would only delay that.
        retry: false,
        queryFn: async () => {
            const { ensureSensitiveEnabled } = await import(
                '@/lib/telegram/content-settings'
            );
            return ensureSensitiveEnabled();
        },
    });

    // Hold the grid only while the switch is actually being read or flipped.
    // If that call fails we ask for media regardless: the peer's flag is
    // advisory, and refusing to load because we could not read a setting is
    // worse than letting Telegram answer for itself.
    const waitingOnFilter = restricted && sensitive.isLoading;

    // Telegram is still filtering. `canChange` false means an age or region
    // requirement this account has not met, and nothing here can override it —
    // so this explains an empty chat, it never gates one.
    const stillFiltered = sensitive.data ? !sensitive.data.enabled : false;

    // What the media query waits for, named once because the rail's chat
    // stream has to wait for exactly the same thing.
    const canRead = !checking && !waitingOnFilter;

    // Whether this account may post here at all, decided once in can-send.ts
    // off the peer. Unknown until the dialog resolves, and false is the safe
    // answer while it does.
    const canSend = Boolean(chat.data?.canSendMedia);
    const sendBlock = chat.data?.sendBlockedReason ?? null;

    const view: CenterView = viewChoice ?? defaultView(chat.data);
    const isDirect = chat.data?.kind === 'direct';
    // Stories are a channel's status line, and a person's too, and a boosted
    // group can post them as well. Asked of every chat but your own Saved
    // Messages; the strip draws nothing where there are none.
    const showStories = Boolean(chat.data) && chat.data?.kind !== 'saved';

    // The stories strip folds to its slim row once the reader is into the
    // content: the grid scrolled down, or the chat scrolled up into history.
    // The chevron on the slim row opens it again until the next scroll.
    const [gridScrolled, setGridScrolled] = useState(false);
    const [chatAway, setChatAway] = useState(false);
    const [storiesOpened, setStoriesOpened] = useState(false);
    // The strip itself is behind the header's Stories toggle, closed until
    // asked for; the toggle carries the count so nothing is missed.
    const [storiesShown, setStoriesShown] = useState(false);
    const storyCount = useChatStoryCount(chatId, showStories && canRead);
    const storiesCollapsed =
        !storiesOpened && (view === 'media' ? gridScrolled : chatAway);

    // Live from the other side; it outranks "last seen" while it lasts.
    const typing = useTyping(chatId, canRead);

    const presence = useQuery({
        queryKey: ['presence', chatId],
        enabled: isDirect && canRead,
        refetchInterval: 60_000,
        retry: false,
        queryFn: async () => {
            const { loadPresence } = await import('@/lib/telegram/stories');
            return loadPresence(chatId);
        },
    });

    const vocabulary = useQuery({
        queryKey: ['media-tags', chatId, 'vocabulary'],
        enabled: canRead,
        queryFn: () => fetchChatVocabulary(chatId),
    });

    const tagOptions = useMemo(
        () => vocabulary.data?.tags ?? [],
        [vocabulary.data],
    );

    // The seen filter is applied to the loaded pages, not asked of Telegram,
    // so flipping it must not start a fresh search.
    const { seen: seenFilter, ...searchFilters } = filters;

    const media = useInfiniteQuery({
        queryKey: ['media', chatId, searchFilters],
        // The chat view never draws the grid, so it does not pay for it.
        enabled: canRead && view === 'media',
        // Search is the request Telegram rate-limits hardest. A chat's media
        // barely moves in five minutes, and going back to a chat should not
        // spend searches on what is already on screen.
        staleTime: 5 * 60_000,
        // Telegram's search pages from message 1 upwards when read oldest
        // first; a tag page has no such floor and starts at no offset either
        // way, so 1 would skip the oldest tagged item.
        initialPageParam:
            filters.tags.length > 0 ? 0 : filters.order === 'old' ? 1 : 0,
        queryFn: async ({ pageParam }): Promise<MediaPage> => {
            // A tag filter cannot go through Telegram's search: the tags are
            // ours, and Telegram has never heard of them. The local database
            // answers with message ids instead and the media is fetched here, which keeps
            // the two halves apart exactly as everywhere else.
            if (filters.tags.length > 0) {
                const { loadMediaItems } = await import('@/lib/telegram/media');
                const page = await fetchTaggedIds(
                    chatId,
                    filters.tags,
                    filters.order,
                    pageParam || undefined,
                    filters.tagMatch,
                );
                return {
                    items: await loadMediaItems(chatId, page.messageIds),
                    nextOffset: page.nextOffset ?? undefined,
                    // Only page one carries a count; later pages say null and
                    // the grid reads the total off page one regardless.
                    total: page.total ?? 0,
                };
            }

            const { searchChatMedia } = await import('@/lib/telegram/media');
            return searchChatMedia({
                chatId,
                type: filters.type,
                order: filters.order,
                minDuration: filters.minDur,
                maxDuration: filters.maxDur,
                query: filters.query,
                offset: pageParam,
            });
        },
        getNextPageParam: (lastPage) => lastPage.nextOffset,
    });

    const loadedItems = useMemo(() => {
        const all = media.data?.pages.flatMap((page) => page.items) ?? [];
        // Telegram already applied the needle for its own search, but a tag
        // page came from the local database, which has never seen a caption. Matching the
        // loaded items here keeps the search box working under a tag filter
        // rather than quietly ignoring it.
        const searched =
            filters.tags.length > 0 && filters.query
                ? all.filter((item) => matchesNeedle(item, filters.query ?? ''))
                : all;
        return searched;
    }, [filters.query, filters.tags, media.data]);
    const total = media.data?.pages[0]?.total;

    // Chips for the media actually on screen, asked for by id. Scoping it to
    // the loaded items is the point: fetching the chat's whole tag map would
    // grow without bound as an account tags more of it.
    const loadedIds = useMemo(
        () => loadedItems.map((item) => item.messageId),
        [loadedItems],
    );

    const chips = useQuery({
        queryKey: ['media-tags', chatId, 'on', loadedIds],
        enabled: canRead && loadedIds.length > 0,
        // The ids grow a page at a time, so every page is a new key. Holding
        // the previous answer keeps the chips on screen instead of blinking
        // out and back while the next one lands.
        placeholderData: (previous) => previous,
        queryFn: () => fetchTagsOn(chatId, loadedIds),
    });

    const tagged = chips.data;

    // What this account has already opened, for the same loaded ids.
    const seenQuery = useQuery({
        queryKey: [...seenKey(chatId), loadedIds],
        enabled: canRead && loadedIds.length > 0,
        placeholderData: (previous) => previous,
        queryFn: () => fetchSeenOn(chatId, loadedIds),
    });
    const seen = useMemo(() => new Set(seenQuery.data), [seenQuery.data]);

    // Opening an item marks it seen. Under "not seen yet" that would pull it
    // out from under the viewer, so whatever is opened while the filter is on
    // stays put until the filter changes.
    const openedScope = `${chatId}:${seenFilter ?? ''}`;
    const [opened, setOpened] = useState<{ scope: string; ids: Set<number> }>(
        () => ({ scope: openedScope, ids: new Set() }),
    );
    const openedHere = useMemo(
        () => (opened.scope === openedScope ? opened.ids : new Set<number>()),
        [opened, openedScope],
    );

    const items = useMemo(() => {
        if (!seenFilter) return loadedItems;
        // Until the lookup answers, nothing is known to be seen; showing
        // everything would flash tiles that are about to be hidden.
        if (!seenQuery.data) return [];
        return loadedItems.filter((item) =>
            seenFilter === 'seen'
                ? seen.has(item.messageId)
                : !seen.has(item.messageId) || openedHere.has(item.messageId),
        );
    }, [loadedItems, openedHere, seen, seenFilter, seenQuery.data]);

    const refreshTags = useCallback(() => {
        void vocabulary.refetch();
        void chips.refetch();
    }, [chips, vocabulary]);

    // react-query hands back a fresh object every render; pull these out so the
    // navigation callbacks below can actually memoise on them.
    const { fetchNextPage, isFetchingNextPage } = media;
    const loaded = items.length;

    /**
     * Tick one tile, or a run of them.
     *
     * Shift extends from the last tile touched, which is what makes selecting
     * a screenful bearable — forty individual clicks is not "bulk".
     */
    const toggleSelected = useCallback(
        (index: number, shift: boolean) => {
            const item = items[index];
            if (!item) return;

            setSelected((current) => {
                const next = new Set(current);

                if (shift && anchorIndex !== null) {
                    const from = Math.min(anchorIndex, index);
                    const to = Math.max(anchorIndex, index);
                    // A range always adds. Extending a selection and having it
                    // punch holes in itself is nobody's intent.
                    for (let at = from; at <= to; at += 1) {
                        const inRange = items[at];
                        if (inRange) next.add(inRange.messageId);
                    }
                    return next;
                }

                if (next.has(item.messageId)) next.delete(item.messageId);
                else next.add(item.messageId);
                return next;
            });

            setAnchorIndex(index);
        },
        [anchorIndex, items],
    );

    const clearSelection = useCallback(() => {
        setSelected(new Set());
        setAnchorIndex(null);
    }, []);

    const stopSelecting = useCallback(() => {
        setSelecting(false);
        clearSelection();
        // Below lg the tag panel is a sheet over the grid. Leaving the mode
        // with it still open would leave a panel acting on a selection that no
        // longer exists.
        setChatSheetOpen(false);
    }, [clearSelection]);

    // Items can leave the grid when the filter changes, so anything picked
    // that is no longer on screen is dropped rather than silently tagged.
    const selectedIds = useMemo(
        () =>
            items
                .map((item) => item.messageId)
                .filter((id) => selected.has(id)),
        [items, selected],
    );

    const hasNextPage = media.hasNextPage;

    const goPrev = useCallback(() => {
        setOpenIndex((current) =>
            current === null ? current : Math.max(0, current - 1),
        );
    }, []);

    /**
     * Step forward, across the page boundary if that is where we are.
     *
     * The grid loads a page at a time, so the viewer used to stop dead on the
     * last item of the first batch — ten photos in a chat of hundreds, with
     * Next greyed out and no way on but closing the lightbox and pressing
     * "Load more". Running out of loaded media is not the same as running out
     * of media, and only the second one ends the walk.
     */
    const goNext = useCallback(() => {
        if (openIndex === null) return;

        if (openIndex + 1 < loaded) {
            setOpenIndex(openIndex + 1);
            return;
        }

        if (hasNextPage) setStepOwed(true);
    }, [hasNextPage, loaded, openIndex]);

    // Fetch ahead while the viewer is open so Next rarely has to wait at all.
    // The grid keeps its explicit "Load more" button — this is only for the
    // reader already stepping through one item at a time, who has asked for
    // more media by the act of walking to the end of it.
    useEffect(() => {
        if (openIndex === null || !hasNextPage || isFetchingNextPage) return;
        if (openIndex < loaded - PREFETCH_AHEAD) return;

        void fetchNextPage();
    }, [fetchNextPage, hasNextPage, isFetchingNextPage, loaded, openIndex]);

    // Open the download connection as soon as the chat's media is known, so
    // the first video played does not pay for setting it up — and preload the
    // first two videos in full, since a reader opening a chat most often
    // plays one of the newest. Everything else on screen warms on a budget.
    useEffect(() => {
        const videos = items
            .filter((item) => item.type === 'video' || item.type === 'gif')
            .slice(0, 2);
        if (videos.length === 0) return;
        void import('@/lib/telegram/progressive').then((mod) => {
            mod.preconnectFor(videos[0]);
            for (const item of videos) mod.warmProgressiveStream(item);
        });
    }, [items]);

    // The items either side of the one being watched start loading now, so
    // Next and Previous open onto a video that already has its first bytes.
    // Next goes in at the player's own priority: as background work it sat
    // behind the open video buffering the rest of its file (measured 2.3s),
    // and it is only its head, two requests among that video's dozens.
    useEffect(() => {
        if (openIndex === null) return;
        const next = items[openIndex + 1];
        const prev = items[openIndex - 1];
        void import('@/lib/telegram/progressive').then((mod) => {
            if (next && next.type !== 'photo') {
                mod.warmProgressiveStream(next, { urgent: true });
            }
            if (prev && prev.type !== 'photo') {
                mod.warmProgressiveStream(prev);
            }
        });
    }, [items, openIndex]);

    // Pay back the step Next could not take yet.
    useEffect(() => {
        if (!stepOwed) return;

        // Closing the viewer cancels the debt; otherwise reopening it would
        // jump a place for no reason anyone could see.
        if (openIndex === null) {
            setStepOwed(false);
            return;
        }

        if (openIndex + 1 < loaded) {
            setOpenIndex(openIndex + 1);
            setStepOwed(false);
            return;
        }

        // The page landed empty, or there was never another one. Stop waiting
        // rather than hold Next spinning forever.
        if (!hasNextPage && !isFetchingNextPage) setStepOwed(false);
    }, [hasNextPage, isFetchingNextPage, loaded, openIndex, stepOwed]);

    // Remember how far this chat has been read, for the "new" badges.
    useEffect(() => {
        if (items.length === 0) return;
        void markSourceVisited(
            chatId,
            Math.max(...items.map((item) => item.messageId)),
        );
    }, [chatId, items]);

    const search = useDebouncedNeedle(filters, onFiltersChange);

    // Selecting opens the right pane whether or not the chat was showing, so
    // the grid gives up the same width it would for the conversation. Without
    // this, entering select mode with the chat hidden would slide a panel over
    // thumbnails that had already laid themselves out five across.
    // The right pane is the tag panel, so it is there only while selecting;
    // the chat itself lives in the Chat view.
    const paneOpen = selecting;
    const gridColumns = paneOpen ? GRID_COLUMNS.open : GRID_COLUMNS.closed;

    const openItem: MediaItem | null =
        openIndex === null ? null : (items[openIndex] ?? null);

    const openId = openItem?.messageId;
    useEffect(() => {
        if (seenFilter !== 'unseen' || openId === undefined) return;
        setOpened((current) => {
            const ids =
                current.scope === openedScope ? current.ids : new Set<number>();
            return ids.has(openId)
                ? current
                : { scope: openedScope, ids: new Set(ids).add(openId) };
        });
    }, [openId, openedScope, seenFilter]);

    if (openIndex !== null) {
        debugChange('viewer', {
            index: openIndex,
            loaded,
            total,
            hasNextPage,
            isFetchingNextPage,
            stepOwed,
        });
    }

    debugChange('gate', {
        chatId,
        checking,
        restricted,
        sensitiveEnabled: sensitive.data?.enabled ?? null,
        sensitiveCanChange: sensitive.data?.canChange ?? null,
        sensitiveError:
            sensitive.error instanceof Error ? sensitive.error.message : null,
        items: items.length,
    });

    return (
        <div className="flex h-dvh flex-col overflow-hidden">
            <AccountBar
                title={chat.data?.title ?? 'Media'}
                back={{ label: 'Library' }}
                wide
                onOpenNav={() => setRailOpen(true)}
                search={{
                    value: search.draft,
                    onChange: search.setDraft,
                    placeholder:
                        view === 'chat'
                            ? 'Search messages'
                            : 'Search this chat',
                    label:
                        view === 'chat'
                            ? 'Search the messages in this conversation'
                            : 'Search messages in this chat',
                }}
            />

            <div className="flex min-h-0 flex-1">
                {/*
                    Chat above, small print below, filters scrolling between
                    them — the same three-part rail the library screen has.
                */}
                <aside className="border-border bg-muted/40 hidden min-h-0 w-64 shrink-0 flex-col border-r md:flex">
                    <div className="border-border shrink-0 border-b">
                        <ChatIdentity dialog={chat.data ?? null} />
                    </div>
                    <MediaFilters
                        value={filters}
                        tags={tagOptions}
                        onChange={onFiltersChange}
                    />
                    <RailFooter />
                </aside>

                <main
                    className="flex min-h-0 min-w-0 flex-1 flex-col"
                    // A deliberate scroll hands the strip back to the scroll
                    // position after the chevron opened it.
                    onWheel={() => setStoriesOpened(false)}
                    onTouchMove={() => setStoriesOpened(false)}
                >
                    <CenterHeader
                        title={chat.data?.title ?? ''}
                        status={
                            typing
                                ? { status: typing, online: true }
                                : isDirect
                                  ? (presence.data ?? null)
                                  : chat.data?.username
                                    ? {
                                          status: `@${chat.data.username}`,
                                          online: false,
                                      }
                                    : null
                        }
                        view={view}
                        onViewChange={(next) => {
                            if (next === 'chat' && selecting) stopSelecting();
                            setViewChoice(next);
                        }}
                        stories={
                            showStories
                                ? {
                                      count: storyCount,
                                      shown: storiesShown,
                                      onToggle: () =>
                                          setStoriesShown((shown) => !shown),
                                  }
                                : undefined
                        }
                    />
                    {/*
                        Pinned under the header in both views, outside any
                        scroller, so the stories never scroll away.
                    */}
                    {showStories && storiesShown ? (
                        <StoriesCarousel
                            chatId={chatId}
                            title={chat.data?.title ?? 'Chat'}
                            enabled={canRead}
                            collapsed={storiesCollapsed}
                            onExpand={() => setStoriesOpened(true)}
                        />
                    ) : null}
                    {view === 'chat' ? (
                        <>
                            {chat.data && !chat.data.isMember ? (
                                <JoinChatBanner
                                    chatId={chatId}
                                    title={chat.data.title}
                                    onJoined={() =>
                                        void queryClient.invalidateQueries({
                                            queryKey: ['dialog', chatId],
                                        })
                                    }
                                />
                            ) : null}
                            {filters.query ? (
                                <ChatSearchResults
                                    chatId={chatId}
                                    query={filters.query}
                                    enabled={canRead}
                                    onPick={(message) => {
                                        setFocus({
                                            id: message.id,
                                            nonce: Date.now(),
                                        });
                                        search.setDraft('');
                                        onFiltersChange({
                                            ...filters,
                                            query: undefined,
                                        });
                                    }}
                                />
                            ) : (
                                <ChatStream
                                    chatId={chatId}
                                    dialog={chat.data ?? null}
                                    enabled={canRead}
                                    variant="full"
                                    focus={focus}
                                    onAwayFromBottomChange={setChatAway}
                                    onAttach={
                                        canSend
                                            ? () => setUploadOpen(true)
                                            : undefined
                                    }
                                    className="flex-1"
                                />
                            )}
                        </>
                    ) : (
                        <div
                            className="min-h-0 flex-1 overflow-y-auto"
                            onScroll={(event) => {
                                const node = event.currentTarget;
                                // Fold only when there is enough grid to stay
                                // scrolled once the strip gives its height
                                // back; a short grid would otherwise fold,
                                // spring to the top and unfold forever.
                                const room =
                                    node.scrollHeight - node.clientHeight;
                                setGridScrolled(
                                    node.scrollTop > 48 && room > 240,
                                );
                            }}
                        >
                            {/*
                        The bar takes the toolbar's place rather than
                        stacking under it. Both are `sticky top-0`, so two
                        at once would overlap on scroll — and a strip that
                        both filters the grid and acts on a selection is
                        two modes in one row.

                        It carries the selection only. The tagging is in
                        the right pane, where there is room for the whole
                        vocabulary and a field to grow it.
                    */}
                            {selecting ? (
                                <SelectionBar
                                    count={selectedIds.length}
                                    loaded={loaded}
                                    onSelectAll={() =>
                                        setSelected(
                                            new Set(
                                                items.map(
                                                    (item) => item.messageId,
                                                ),
                                            ),
                                        )
                                    }
                                    onClear={clearSelection}
                                    onOpenTags={() => setChatSheetOpen(true)}
                                    onDone={stopSelecting}
                                />
                            ) : (
                                <MediaToolbar
                                    value={filters}
                                    onChange={onFiltersChange}
                                    actions={
                                        <>
                                            <Button
                                                type="button"
                                                variant="ghost"
                                                size="sm"
                                                className="text-muted-foreground"
                                                disabled={!canRead}
                                                onClick={() =>
                                                    setExportOpen(true)
                                                }
                                            >
                                                <FolderDown data-icon="inline-start" />
                                                Export
                                            </Button>
                                            <Button
                                                type="button"
                                                variant="ghost"
                                                size="sm"
                                                aria-pressed={selecting}
                                                className="text-muted-foreground"
                                                disabled={
                                                    !canRead || loaded === 0
                                                }
                                                onClick={() =>
                                                    selecting
                                                        ? stopSelecting()
                                                        : setSelecting(true)
                                                }
                                            >
                                                <CheckSquare data-icon="inline-start" />
                                                Select
                                            </Button>
                                            {/*
                                Telegram's answer is on the peer, so
                                whether this account may post is known
                                before the button is drawn. Offering Send
                                on a channel that refuses everyone but its
                                admins and letting the send fail is a
                                button that reads as broken.

                                A chat the account has not joined hides it
                                outright — JoinChatBanner is already
                                saying what to do, and a dead control
                                beside it is noise. Every other refusal
                                keeps the word and explains itself, the way
                                DownloadButton does.
                            */}
                                            {sendBlock ===
                                            'not-member' ? null : (
                                                <Button
                                                    type="button"
                                                    variant="ghost"
                                                    size="sm"
                                                    className="text-muted-foreground"
                                                    disabled={
                                                        !canRead || !canSend
                                                    }
                                                    title={
                                                        sendBlock
                                                            ? describeSendBlock(
                                                                  sendBlock,
                                                              )
                                                            : undefined
                                                    }
                                                    onClick={() =>
                                                        setUploadOpen(true)
                                                    }
                                                >
                                                    {canSend ? (
                                                        <Upload data-icon="inline-start" />
                                                    ) : (
                                                        <Lock data-icon="inline-start" />
                                                    )}
                                                    Send
                                                </Button>
                                            )}
                                        </>
                                    }
                                />
                            )}
                            {chat.data && !chat.data.isMember ? (
                                <JoinChatBanner
                                    chatId={chatId}
                                    title={chat.data.title}
                                    onJoined={() =>
                                        void queryClient.invalidateQueries({
                                            queryKey: ['dialog', chatId],
                                        })
                                    }
                                />
                            ) : null}
                            <div className="px-4 py-4">
                                {checking || media.isPending ? (
                                    <GridSkeleton columns={gridColumns} />
                                ) : null}
                                {sensitive.error ? (
                                    <p className="text-muted-foreground mt-4 text-sm">
                                        Could not reach your Telegram content
                                        settings
                                        {sensitive.error instanceof Error
                                            ? `: ${sensitive.error.message}`
                                            : '.'}
                                    </p>
                                ) : null}
                                {media.error ? (
                                    <p className="text-destructive mt-8 text-sm">
                                        {media.error instanceof Error
                                            ? media.error.message
                                            : 'Could not load media.'}
                                    </p>
                                ) : null}
                                {media.isSuccess &&
                                items.length === 0 &&
                                // A seen filter can hide a whole page; the
                                // next one may still hold something.
                                !(seenFilter && hasNextPage) ? (
                                    <div className="grid min-h-[40vh] place-items-center px-6">
                                        <p className="text-muted-foreground max-w-sm text-center text-sm text-pretty">
                                            {stillFiltered
                                                ? "Telegram is still filtering this chat. Its sensitive-content switch is locked on your account — usually Telegram's own age or region check — and Mediagram cannot override it."
                                                : filters.query
                                                  ? `Nothing in this chat matches “${filters.query}”.`
                                                  : seenFilter === 'unseen'
                                                    ? "You've already seen everything here."
                                                    : 'No media matches these filters.'}
                                        </p>
                                    </div>
                                ) : null}
                                {checking ? null : (
                                    <div className={gridColumns}>
                                        {items.map((item, index) => (
                                            <ThumbImage
                                                key={item.key}
                                                item={item}
                                                tags={tagsFor(tagged, item)}
                                                seen={seen.has(item.messageId)}
                                                blurred={false}
                                                selecting={selecting}
                                                selected={selected.has(
                                                    item.messageId,
                                                )}
                                                onToggleSelect={(shift) =>
                                                    toggleSelected(index, shift)
                                                }
                                                onOpen={() =>
                                                    setOpenIndex(index)
                                                }
                                            />
                                        ))}
                                    </div>
                                )}
                                {hasNextPage ? (
                                    <div className="flex justify-center py-8">
                                        <LoadMoreWhenNear
                                            busy={media.isFetchingNextPage}
                                            onNear={() =>
                                                void media.fetchNextPage()
                                            }
                                        />
                                        <Button
                                            variant="outline"
                                            disabled={media.isFetchingNextPage}
                                            onClick={() =>
                                                void media.fetchNextPage()
                                            }
                                        >
                                            {media.isFetchingNextPage
                                                ? 'Loading…'
                                                : 'Load more'}
                                        </Button>
                                    </div>
                                ) : (
                                    <div className="h-8" />
                                )}
                            </div>
                        </div>
                    )}
                </main>

                {/*
                    What the chat is, and then the chat itself: the pane reads
                    top to bottom as identity, counts, and the conversation
                    those counts came out of, most recent message last.

                    While selecting it is the tag panel instead. Selecting is a
                    mode and this is the only surface with room for one — the
                    alternative was a popover that could show the vocabulary or
                    a field to add to it, never both.
                */}
                <aside
                    className={cn(
                        'border-border min-h-0 w-80 shrink-0 flex-col border-l',
                        paneOpen ? 'hidden lg:flex' : 'hidden',
                    )}
                >
                    {selecting ? (
                        <TagPanel
                            chatId={chatId}
                            selected={selectedIds}
                            tagged={tagged ?? {}}
                            loaded={loaded}
                            onSelectAll={() =>
                                setSelected(
                                    new Set(
                                        items.map((item) => item.messageId),
                                    ),
                                )
                            }
                            onClear={clearSelection}
                            onDone={stopSelecting}
                            onChanged={refreshTags}
                            className="flex-1"
                        />
                    ) : null}
                </aside>
            </div>

            {/*
                The left rail below md, and only the rail: the chat used to
                ride along at the bottom of this sheet, which put the two
                panes that sit on opposite sides of the grid into one drawer
                and left the filters sharing their scroll with a conversation.
                It has its own sheet now, on its own side.
            */}
            <Sheet open={railOpen} onOpenChange={setRailOpen}>
                <SheetContent
                    side="left"
                    className="bg-background w-80 gap-0 p-0"
                    showCloseButton
                >
                    <SheetHeader className="border-border shrink-0 border-b">
                        <SheetTitle>{chat.data?.title ?? 'Chat'}</SheetTitle>
                        <SheetDescription className="sr-only">
                            The filters on this chat's media
                        </SheetDescription>
                    </SheetHeader>
                    <div className="min-h-0 flex-1 overflow-y-auto">
                        <MediaFilters
                            value={filters}
                            tags={tagOptions}
                            onChange={onFiltersChange}
                        />
                    </div>
                    <RailFooter />
                </SheetContent>
            </Sheet>

            {/*
                The right pane below lg, entering from the side it lives on so
                it reads as that pane arriving rather than the filter rail
                having grown a chat. Solid, because a conversation over a grid
                of thumbnails is unreadable through a translucent panel.
            */}
            <Sheet open={chatSheetOpen} onOpenChange={setChatSheetOpen}>
                <SheetContent
                    side="right"
                    className="bg-background w-80 gap-0 p-0"
                    showCloseButton
                >
                    <SheetHeader className="border-border shrink-0 border-b">
                        <SheetTitle>Tags</SheetTitle>
                        <SheetDescription className="sr-only">
                            Put your tags on what you have picked
                        </SheetDescription>
                    </SheetHeader>
                    <TagPanel
                        chatId={chatId}
                        selected={selectedIds}
                        tagged={tagged ?? {}}
                        loaded={loaded}
                        onSelectAll={() =>
                            setSelected(
                                new Set(items.map((item) => item.messageId)),
                            )
                        }
                        onClear={clearSelection}
                        // `stopSelecting` closes this sheet itself, so Done
                        // in here leaves the mode and the panel together.
                        onDone={stopSelecting}
                        onChanged={refreshTags}
                        className="min-h-0 flex-1"
                    />
                </SheetContent>
            </Sheet>

            {openItem ? (
                <Lightbox
                    item={openItem}
                    tags={tagsFor(tagged, openItem)}
                    onTagsChange={refreshTags}
                    index={openIndex ?? 0}
                    total={loaded}
                    hasMore={hasNextPage}
                    loadingMore={isFetchingNextPage}
                    onClose={() => setOpenIndex(null)}
                    onPrev={goPrev}
                    onNext={goNext}
                />
            ) : null}

            <UploadDialog
                open={uploadOpen && canSend}
                chatId={chatId}
                chatTitle={chat.data?.title ?? 'this chat'}
                onClose={() => setUploadOpen(false)}
            />

            <ExportDialog
                open={exportOpen}
                chat={chat.data ?? null}
                chatId={chatId}
                filters={filters}
                onClose={() => setExportOpen(false)}
            />
        </div>
    );
}

/**
 * The top of the centre: who this is, and whether it is showing the chat or
 * the media. A person's line says when they were last seen; a public chat's
 * says its handle.
 */
function CenterHeader({
    title,
    status,
    view,
    onViewChange,
    stories,
}: {
    title: string;
    status: { status: string; online: boolean } | null;
    view: CenterView;
    onViewChange: (view: CenterView) => void;
    /** The stories strip's toggle; absent where a chat has no stories. */
    stories?: { count: number | null; shown: boolean; onToggle: () => void };
}) {
    return (
        <div className="border-border bg-background flex shrink-0 items-center gap-3 border-b px-4 py-2">
            <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{title}</p>
                {status?.status ? (
                    <p
                        className={cn(
                            'flex items-center gap-1.5 truncate text-xs',
                            status.online
                                ? 'text-emerald-500'
                                : 'text-muted-foreground',
                        )}
                    >
                        {status.online ? (
                            <span className="size-1.5 rounded-full bg-emerald-500" />
                        ) : null}
                        {status.status}
                    </p>
                ) : null}
            </div>
            <Segmented
                value={view}
                onChange={onViewChange}
                options={[
                    { value: 'chat', label: 'Chat' },
                    { value: 'media', label: 'Media' },
                ]}
            />
            {stories ? (
                <StoriesToggle
                    count={stories.count}
                    shown={stories.shown}
                    onToggle={stories.onToggle}
                />
            ) : null}
        </div>
    );
}

/**
 * Opens and closes the stories strip above the content. Styled as a tab in
 * the same kind of track as Chat / Media, but it is not a third view: it only
 * shows or hides the strip over whichever view is up.
 */
function StoriesToggle({
    count,
    shown,
    onToggle,
}: {
    count: number | null;
    shown: boolean;
    onToggle: () => void;
}) {
    return (
        <div className="ring-border/60 bg-muted/60 inline-flex rounded-lg p-1 ring-1 ring-inset">
            <button
                type="button"
                aria-pressed={shown}
                aria-label={`${shown ? 'Hide' : 'Show'} stories${count !== null ? ` (${count})` : ''}`}
                onClick={onToggle}
                className={cn(
                    'inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium transition-colors duration-150',
                    'focus-visible:ring-ring outline-none focus-visible:ring-2',
                    shown
                        ? 'bg-accent text-accent-foreground ring-border ring-1 ring-inset'
                        : 'text-muted-foreground hover:text-foreground hover:bg-foreground/[0.06]',
                )}
            >
                Stories
                <span
                    className={cn(
                        'min-w-5 rounded-full px-1.5 text-center text-[11px] leading-5 tabular-nums',
                        count
                            ? 'bg-primary text-primary-foreground'
                            : 'bg-foreground/10 text-muted-foreground',
                    )}
                >
                    {count ?? '–'}
                </span>
            </button>
        </div>
    );
}

/**
 * The nav's search box, held locally and pushed into the filters once typing
 * settles.
 *
 * Every filter change is a new react-query key and a fresh Telegram search, so
 * a keystroke straight into `filters` would fire one search per letter. The
 * field stays responsive because the draft is local; the grid only moves when
 * the typing stops.
 */
function useDebouncedNeedle(
    filters: MediaSearchState,
    onFiltersChange: (next: MediaSearchState) => void,
) {
    const committed = filters.query ?? '';
    const [draft, setDraft] = useState(committed);

    // A needle can also arrive from outside the box — the url on first paint,
    // or a back button. Following it keeps the field honest about what the
    // grid is actually showing, but only when it says something different:
    // overwriting unconditionally would eat the space in "cat dog" the moment
    // "cat " committed.
    useEffect(() => {
        setDraft((current) =>
            current.trim() === committed ? current : committed,
        );
    }, [committed]);

    useEffect(() => {
        const next = draft.trim();
        if (next === committed) return;

        const timer = window.setTimeout(() => {
            onFiltersChange({ ...filters, query: next || undefined });
        }, 300);

        return () => window.clearTimeout(timer);
    }, [committed, draft, filters, onFiltersChange]);

    return { draft, setDraft };
}

/** Matches a loaded item against the needle, for the tag path only. */
function matchesNeedle(item: MediaItem, query: string): boolean {
    const needle = query.trim().toLowerCase();
    if (needle === '') return true;

    return [
        item.caption,
        item.fileName,
        item.audioTitle,
        item.audioPerformer,
    ].some((field) => field?.toLowerCase().includes(needle));
}

/** The tags on one item, from the chat-wide map: the reader's own and public ones. */
function tagsFor(
    tagged: Record<string, MediaItemTag[]> | undefined,
    item: MediaItem,
): MediaItemTag[] {
    return tagged?.[String(item.messageId)] ?? [];
}

/**
 * A peer fetched on its own knows nothing of the account's dialog list —
 * archived, muted, pinned, unread are all properties of that list — so those
 * are carried over from the library's copy rather than reset to false. The
 * notifier reads muted and archived off this very entry.
 */
function withListState(
    fresh: DialogItem,
    listed: DialogItem | undefined,
): DialogItem {
    if (!listed) return fresh;
    return {
        ...listed,
        ...fresh,
        isPinned: listed.isPinned,
        unreadCount: listed.unreadCount,
        isArchived: listed.isArchived,
        isMuted: listed.isMuted,
        isUnread: listed.isUnread,
        lastMessageAt: listed.lastMessageAt,
        lastMessageId: listed.lastMessageId,
        lastMediaId: listed.lastMediaId,
        lastMediaAt: listed.lastMediaAt,
        lastMediaKind: listed.lastMediaKind,
    };
}

/**
 * Asks for the next page as the end of the grid comes within a screen of
 * view, so scrolling reads on without a click. The button beside it stays for
 * anyone who gets there first, and for keyboard readers.
 */
function LoadMoreWhenNear({
    busy,
    onNear,
}: {
    busy: boolean;
    onNear: () => void;
}) {
    const ref = useRef<HTMLSpanElement>(null);
    const [near, setNear] = useState(false);

    useEffect(() => {
        const node = ref.current;
        if (!node) return;
        const observer = new IntersectionObserver(
            ([entry]) => setNear(entry?.isIntersecting ?? false),
            { rootMargin: '0px 0px 900px 0px' },
        );
        observer.observe(node);
        return () => observer.disconnect();
    }, []);

    // The caller's callback changes every render; only the edge matters.
    const latest = useRef(onNear);
    latest.current = onNear;

    // Re-arms after each page: if the new tiles still leave the end in reach,
    // the next page is asked for too, until the screen is full.
    useEffect(() => {
        if (near && !busy) latest.current();
    }, [near, busy]);

    return <span ref={ref} aria-hidden="true" />;
}
