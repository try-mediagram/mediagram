import {
    type InfiniteData,
    useInfiniteQuery,
    useQuery,
    useQueryClient,
} from '@tanstack/react-query';
import {
    ArrowDown,
    Check,
    CheckCheck,
    Copy,
    ExternalLink,
    FileText,
    Lock,
    MoreHorizontal,
    Mic,
    Music,
    Pencil,
    Play,
    Reply,
    Trash2,
} from 'lucide-react';
import {
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
} from 'react';
import { toast } from 'sonner';

import {
    ChatComposer,
    type ComposerMode,
    snippet,
} from '@/components/chat-composer';
import { Lightbox } from '@/components/lightbox';
import { SenderAvatar } from '@/components/sender-avatar';
import { Button } from '@/components/ui/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import {
    formatClockTime,
    formatDuration,
    formatMediaDate,
    formatMediaDateTime,
} from '@/lib/format';
import { playSound } from '@/lib/notify-sound';
import { telegramMessageLink } from '@/lib/telegram/links';
import type {
    ChatHistoryOffset,
    ChatHistoryPage,
    DialogItem,
    MediaItem,
    ThreadMessage,
} from '@/lib/telegram/types';
import { displayReaction } from '@/lib/telegram/reactions';
import { cn } from '@/lib/utils';

/** How close to the bottom still counts as reading the end of the chat. */
const AT_BOTTOM = 48;

/**
 * How often the open chat asks Telegram for its newest page anyway.
 *
 * Live updates are the fast path, but the session runs without an updates
 * manager and a push can be missed (a sleeping laptop, a dropped socket). A
 * slow poll while the tab is visible is what makes "new messages show up"
 * certain rather than likely.
 */
const POLL_MS = 20_000;

/** Quick reactions offered in a message's menu before the chat has answered. */
const QUICK_REACTIONS = 6;

type HistoryData = InfiniteData<ChatHistoryPage, ChatHistoryOffset | undefined>;

/**
 * The chat itself: read it, and write in it.
 *
 * Read the way Telegram reads: oldest at the top, the most recent message
 * last, and the stream opens scrolled to that end. Older pages are asked for
 * upwards, and the scroll position is pinned across them so the message being
 * read does not jump when a page lands above it.
 *
 * It is live. A message Telegram pushes for this chat is merged in where it
 * belongs, edits replace their message, deletes take it out, and the other
 * side reading your messages turns one tick into two. Messages are written,
 * replied to, edited, deleted and reacted to from here, and reaching the
 * bottom marks the chat read.
 *
 * Two shapes: `rail` is the narrow pane beside the media grid, `full` is the
 * centre of a direct conversation with bubbles either side.
 */
export function ChatStream({
    chatId,
    dialog,
    enabled,
    variant = 'rail',
    focus = null,
    onAttach,
    onAwayFromBottomChange,
    className,
}: {
    chatId: number;
    dialog: DialogItem | null;
    /** False while the chat is still being judged, or is behind the age gate. */
    enabled: boolean;
    variant?: 'rail' | 'full';
    /**
     * A message to bring into view — a search hit. Older pages are read until
     * it is on screen; `nonce` lets the same message be asked for twice.
     */
    focus?: { id: number; nonce: number } | null;
    /** Opens the file picker for photos, video and files; absent where media can't be sent. */
    onAttach?: () => void;
    /**
     * The reader scrolled up into history (true) or is back at the newest
     * message (false). The chat screen folds the stories strip on it.
     */
    onAwayFromBottomChange?: (away: boolean) => void;
    className?: string;
}) {
    const queryClient = useQueryClient();
    const scroller = useRef<HTMLDivElement>(null);
    // Set just before an older page is asked for, so the restore below knows
    // how far from the bottom the reader was standing.
    const anchor = useRef<{ height: number; top: number } | null>(null);
    const pinnedToBottom = useRef(true);
    const [awayFromBottom, setAwayFromBottom] = useState(false);

    const reportAway = useRef(onAwayFromBottomChange);
    reportAway.current = onAwayFromBottomChange;
    useEffect(() => {
        reportAway.current?.(awayFromBottom);
    }, [awayFromBottom]);

    // Whatever resizes the stream — the stories strip folding above it, the
    // composer growing below — a reader at the newest message stays there.
    // Without this, the strip opening would hide the last lines, read as
    // "scrolled away", fold the strip again, and so on.
    useEffect(() => {
        const node = scroller.current;
        if (!node) return;
        const observer = new ResizeObserver(() => {
            if (pinnedToBottom.current) node.scrollTop = node.scrollHeight;
        });
        observer.observe(node);
        return () => observer.disconnect();
    }, []);
    const [unseen, setUnseen] = useState(0);
    const [mode, setMode] = useState<ComposerMode>({ kind: 'new' });
    const [readOutbox, setReadOutbox] = useState(0);
    const lastMarkedRead = useRef(0);
    const full = variant === 'full';

    const historyKey = useMemo(() => ['chat-history', chatId], [chatId]);

    const history = useInfiniteQuery({
        queryKey: historyKey,
        enabled,
        initialPageParam: undefined as ChatHistoryOffset | undefined,
        queryFn: async ({ pageParam }) => {
            const { loadChatHistory } = await import('@/lib/telegram/thread');
            return loadChatHistory(chatId, pageParam);
        },
        getNextPageParam: (lastPage) => lastPage.nextOffset,
    });

    const reactions = useQuery({
        queryKey: ['chat-reactions', chatId],
        enabled,
        staleTime: Infinity,
        retry: false,
        queryFn: async () => {
            const { loadChatReactions } = await import('@/lib/telegram/thread');
            return loadChatReactions(chatId);
        },
    });

    // Pages arrive newest batch first and each one is ascending, so the whole
    // stream is the pages read backwards. The map is belt and braces: an
    // overlapping page would otherwise repeat a message.
    const messages = useMemo(() => {
        const byId = new Map<number, ThreadMessage>();
        for (const page of [...(history.data?.pages ?? [])].reverse()) {
            for (const message of page.messages) byId.set(message.id, message);
        }
        return [...byId.values()].sort((a, b) => a.id - b.id);
    }, [history.data]);

    const byId = useMemo(
        () => new Map(messages.map((message) => [message.id, message])),
        [messages],
    );

    const newestId = messages[messages.length - 1]?.id ?? 0;

    /** Put messages into the cache, replacing any already there by id. */
    const upsert = useCallback(
        (incoming: ThreadMessage[]) => {
            if (incoming.length === 0) return;
            queryClient.setQueryData<HistoryData>(historyKey, (data) =>
                data ? upsertMessages(data, incoming) : data,
            );
        },
        [historyKey, queryClient],
    );

    const remove = useCallback(
        (ids: number[]) => {
            const gone = new Set(ids);
            queryClient.setQueryData<HistoryData>(historyKey, (data) =>
                data
                    ? {
                          ...data,
                          pages: data.pages.map((page) => ({
                              ...page,
                              messages: page.messages.filter(
                                  (message) => !gone.has(message.id),
                              ),
                          })),
                      }
                    : data,
            );
        },
        [historyKey, queryClient],
    );

    /** Ask for the newest page and merge it over what is on screen. */
    const refreshLatest = useCallback(async () => {
        const { loadLatestMessages } = await import('@/lib/telegram/thread');
        const latest = await loadLatestMessages(chatId);
        const before = queryClient
            .getQueryData<HistoryData>(historyKey)
            ?.pages[0]?.messages.at(-1)?.id;
        upsert(latest);
        const fresh = latest.filter(
            (message) => before !== undefined && message.id > before,
        );
        if (fresh.length > 0 && !pinnedToBottom.current) {
            setUnseen((count) => count + fresh.length);
        }
    }, [chatId, historyKey, queryClient, upsert]);

    // This is the chat on screen: the notifier gives it the quiet cue.
    useEffect(() => {
        let live = true;
        void import('@/lib/telegram/live-updates').then((mod) => {
            if (live) mod.setActiveChat(chatId);
        });
        return () => {
            live = false;
            void import('@/lib/telegram/live-updates').then((mod) => {
                if (mod.getActiveChat() === chatId) mod.setActiveChat(null);
            });
        };
    }, [chatId]);

    // Live: Telegram's pushes for this chat, merged in as they land.
    useEffect(() => {
        if (!enabled) return;
        let unsubscribe: (() => void) | null = null;
        let live = true;
        let timer: ReturnType<typeof setTimeout> | null = null;

        const soon = () => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => {
                void refreshLatest().catch(() => undefined);
            }, 250);
        };

        void import('@/lib/telegram/live-updates').then((mod) => {
            if (!live) return;
            mod.startLiveUpdates();
            unsubscribe = mod.subscribeMessageEvents((event) => {
                switch (event.type) {
                    case 'new':
                        if (event.chatId === chatId) soon();
                        return;
                    case 'edit':
                        // An edit can be anywhere in the history, so the one
                        // message is read back rather than the newest page.
                        if (event.chatId === chatId)
                            void import('@/lib/telegram/thread')
                                .then((thread) =>
                                    thread.loadThreadMessages(chatId, [
                                        event.messageId,
                                    ]),
                                )
                                .then(upsert)
                                .catch(() => undefined);
                        return;
                    case 'delete':
                        if (event.chatId === null || event.chatId === chatId)
                            remove(event.messageIds);
                        return;
                    case 'read-outbox':
                        if (event.chatId === chatId)
                            setReadOutbox((current) =>
                                Math.max(current, event.maxId),
                            );
                        return;
                }
            });
        });

        const poll = setInterval(() => {
            if (document.visibilityState === 'visible') soon();
        }, POLL_MS);

        return () => {
            live = false;
            if (timer) clearTimeout(timer);
            clearInterval(poll);
            unsubscribe?.();
        };
    }, [chatId, enabled, refreshLatest, remove, upsert]);

    // Where the other side has read up to, for the ticks on your messages.
    useEffect(() => {
        if (!enabled) return;
        let live = true;
        void import('@/lib/telegram/thread')
            .then((mod) => mod.loadReadOutbox(chatId))
            .then((maxId) => {
                if (live) setReadOutbox((current) => Math.max(current, maxId));
            })
            .catch(() => undefined);
        return () => {
            live = false;
        };
    }, [chatId, enabled]);

    // Reaching the end of the chat, with the window in front, reads it.
    const markRead = useCallback(() => {
        if (!enabled || newestId === 0) return;
        if (!pinnedToBottom.current) return;
        if (document.visibilityState !== 'visible') return;
        if (newestId <= lastMarkedRead.current) return;
        lastMarkedRead.current = newestId;
        void import('@/lib/telegram/thread')
            .then((mod) => mod.markChatRead(chatId, newestId))
            .then(() =>
                queryClient.invalidateQueries({ queryKey: ['dialogs'] }),
            )
            .catch(() => {
                lastMarkedRead.current = 0;
            });
    }, [chatId, enabled, newestId, queryClient]);

    useEffect(() => {
        markRead();
        const onVisible = () => markRead();
        document.addEventListener('visibilitychange', onVisible);
        return () =>
            document.removeEventListener('visibilitychange', onVisible);
    }, [markRead]);

    useLayoutEffect(() => {
        const node = scroller.current;
        if (!node || messages.length === 0) return;

        if (anchor.current) {
            // An older page landed above: keep the same message under the
            // reader's eye rather than letting the new height push it down.
            node.scrollTop =
                node.scrollHeight - anchor.current.height + anchor.current.top;
            anchor.current = null;
            return;
        }

        if (pinnedToBottom.current) node.scrollTop = node.scrollHeight;
    }, [messages]);

    // A different chat is a different stream; start it at the end again.
    // biome-ignore lint/correctness/useExhaustiveDependencies: chatId is the trigger, not an input
    useEffect(() => {
        pinnedToBottom.current = true;
        anchor.current = null;
        lastMarkedRead.current = 0;
        setUnseen(0);
        setAwayFromBottom(false);
        setMode({ kind: 'new' });
        setReadOutbox(0);
    }, [chatId]);

    // Walk back through older pages until the asked-for message is loaded,
    // then put it in the middle of the screen. Bounded, so a message Telegram
    // no longer has cannot keep the stream paging forever.
    const focusPages = useRef(0);
    const handledFocus = useRef<number | null>(null);
    const { hasNextPage, isFetchingNextPage, fetchNextPage } = history;
    // biome-ignore lint/correctness/useExhaustiveDependencies: jumpTo reads the DOM, not state
    useEffect(() => {
        if (!focus || messages.length === 0) return;
        if (handledFocus.current === focus.nonce) return;
        if (byId.has(focus.id)) {
            handledFocus.current = focus.nonce;
            focusPages.current = 0;
            pinnedToBottom.current = false;
            // After paint, so the row exists to scroll to.
            requestAnimationFrame(() => jumpTo(focus.id));
            return;
        }
        const oldest = messages[0]?.id ?? 0;
        if (
            focus.id < oldest &&
            hasNextPage &&
            !isFetchingNextPage &&
            focusPages.current < 40
        ) {
            focusPages.current += 1;
            pinnedToBottom.current = false;
            void fetchNextPage();
        }
    }, [focus, byId, messages, hasNextPage, isFetchingNextPage, fetchNextPage]);

    function loadOlder() {
        const node = scroller.current;
        if (node)
            anchor.current = { height: node.scrollHeight, top: node.scrollTop };
        void history.fetchNextPage();
    }

    function scrollToBottom() {
        const node = scroller.current;
        if (!node) return;
        pinnedToBottom.current = true;
        node.scrollTo({ top: node.scrollHeight, behavior: 'smooth' });
        setUnseen(0);
        setAwayFromBottom(false);
    }

    function jumpTo(messageId: number) {
        const node = scroller.current?.querySelector<HTMLElement>(
            `[data-message-id="${messageId}"]`,
        );
        if (!node) {
            toast('That message is further up — load older messages first.');
            return;
        }
        node.scrollIntoView({ behavior: 'smooth', block: 'center' });
        node.classList.add('bg-primary/10');
        setTimeout(() => node.classList.remove('bg-primary/10'), 1_200);
    }

    // The chat's media in reading order, for the viewer to step through, and
    // which one it is showing (by key, so new messages arriving underneath
    // do not shift it onto a different item).
    const [viewing, setViewing] = useState<string | null>(null);
    const viewable = useMemo(
        () =>
            messages.flatMap((message) =>
                message.media && isViewable(message.media)
                    ? [message.media]
                    : [],
            ),
        [messages],
    );
    const viewIndex = viewing
        ? viewable.findIndex((item) => item.key === viewing)
        : -1;
    const viewItem = viewIndex >= 0 ? viewable[viewIndex] : null;
    // The same tag lookup the grid makes, for the one item on screen.
    const viewTags = useQuery({
        queryKey: ['chat-view-tags', chatId, viewItem?.messageId],
        enabled: viewItem !== null,
        queryFn: async () => {
            const { fetchTagsOn } = await import('@/lib/media-tags');
            return fetchTagsOn(chatId, [viewItem?.messageId ?? 0]);
        },
    });

    // The chat Telegram refused a message in, until the reader moves on.
    const [refusedAt, setRefusedAt] = useState<number | null>(null);

    async function send(text: string) {
        const thread = await import('@/lib/telegram/thread');
        try {
            if (mode.kind === 'edit') {
                const edited = await thread.editChatText(
                    chatId,
                    mode.message.id,
                    text,
                );
                if (edited) upsert([edited]);
            } else {
                const sent = await thread.sendChatText(
                    chatId,
                    text,
                    mode.kind === 'reply' ? mode.message.id : undefined,
                );
                if (sent) upsert([sent]);
                pinnedToBottom.current = true;
                playSound('sent');
            }
            setMode({ kind: 'new' });
        } catch (caught) {
            const { describeTelegramError, isWriteForbiddenError } =
                await import('@/lib/telegram/errors');
            toast.error(describeTelegramError(caught));
            // Telegram has said no outright: stop offering the box rather
            // than let every send fail the same way.
            if (isWriteForbiddenError(caught)) {
                setRefusedAt(chatId);
            }
            throw caught;
        }
    }

    async function deleteMessage(message: ThreadMessage, revoke: boolean) {
        try {
            const { deleteChatMessages } = await import(
                '@/lib/telegram/thread'
            );
            await deleteChatMessages(chatId, [message.id], revoke);
            remove([message.id]);
            if (mode.kind !== 'new' && mode.message.id === message.id)
                setMode({ kind: 'new' });
        } catch (caught) {
            const { describeTelegramError } = await import(
                '@/lib/telegram/errors'
            );
            toast.error(describeTelegramError(caught));
        }
    }

    async function react(message: ThreadMessage, emoji: string) {
        try {
            const { sendThreadReaction } = await import(
                '@/lib/telegram/thread'
            );
            upsert([await sendThreadReaction(message, emoji)]);
        } catch (caught) {
            const { describeTelegramError } = await import(
                '@/lib/telegram/errors'
            );
            toast.error(describeTelegramError(caught));
        }
    }

    // `canWrite` is the text rule from can-send.ts; a dialog cached before it
    // existed falls back to the media verdict it used to be read from.
    const refused = refusedAt === chatId;
    const canWrite =
        dialog === null || refused
            ? false
            : (dialog.canWrite ??
              (dialog.canSendMedia ||
                  dialog.sendBlockedReason === 'media-restricted'));
    const blockedBy = dialog?.writeBlockedReason ?? dialog?.sendBlockedReason;
    const writeBlock = !dialog
        ? null
        : refused
          ? 'You cannot write in this chat.'
          : canWrite
            ? null
            : blockedBy === 'not-member'
              ? 'Join this chat to write in it.'
              : blockedBy === 'broadcast-readonly'
                ? 'Only admins can post to this channel.'
                : blockedBy === 'banned'
                  ? 'You are banned from this chat.'
                  : blockedBy === 'text-restricted'
                    ? 'Only admins can write in this chat.'
                    : null;
    const isChannel = dialog?.kind === 'channel';
    const quick = (reactions.data?.emojis ?? []).slice(0, QUICK_REACTIONS);

    return (
        <section
            className={cn('relative flex min-h-0 flex-col', className)}
            aria-label="Chat"
        >
            {full ? null : (
                <h2 className="text-muted-foreground border-border shrink-0 border-b px-3 py-2 text-[11px] font-medium tracking-wide uppercase">
                    Chat
                </h2>
            )}

            <div
                ref={scroller}
                onScroll={(event) => {
                    const node = event.currentTarget;
                    const atBottom =
                        node.scrollHeight - node.scrollTop - node.clientHeight <
                        AT_BOTTOM;
                    pinnedToBottom.current = atBottom;
                    setAwayFromBottom(!atBottom);
                    if (atBottom) {
                        setUnseen(0);
                        markRead();
                    }
                }}
                className={cn(
                    'min-h-0 flex-1 overflow-y-auto',
                    full ? 'px-4 py-4 sm:px-8' : 'px-3 py-3',
                )}
            >
                {!enabled ? (
                    <p className="text-muted-foreground text-xs text-pretty">
                        This chat opens once it has been confirmed.
                    </p>
                ) : history.isPending ? (
                    <StreamSkeleton />
                ) : history.error ? (
                    <p className="text-destructive text-xs">
                        {history.error instanceof Error
                            ? history.error.message
                            : 'Could not load this chat.'}
                    </p>
                ) : messages.length === 0 ? (
                    <p className="text-muted-foreground text-center text-xs">
                        Nothing has been said in this chat yet.
                    </p>
                ) : (
                    <div className={cn(full && 'mx-auto max-w-3xl')}>
                        {history.hasNextPage ? (
                            <div className="flex justify-center pb-3">
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    className="text-muted-foreground h-7 text-xs"
                                    disabled={history.isFetchingNextPage}
                                    onClick={loadOlder}
                                >
                                    {history.isFetchingNextPage
                                        ? 'Loading…'
                                        : 'Older messages'}
                                </Button>
                            </div>
                        ) : (
                            <p className="text-muted-foreground/70 pb-3 text-center text-[11px]">
                                The start of this chat
                            </p>
                        )}
                        <ol
                            className={cn(
                                'flex flex-col',
                                full ? 'gap-1.5' : 'gap-3',
                            )}
                        >
                            {messages.map((message, index) => (
                                <li
                                    key={message.id}
                                    data-message-id={message.id}
                                    className="rounded-md transition-colors"
                                >
                                    {startsNewDay(
                                        message,
                                        messages[index - 1],
                                    ) ? (
                                        <DayDivider date={message.date} />
                                    ) : null}
                                    <MessageRow
                                        message={message}
                                        variant={variant}
                                        showSender={
                                            !full ||
                                            (!isChannel &&
                                                dialog?.kind !== 'direct' &&
                                                messages[index - 1]
                                                    ?.senderId !==
                                                    message.senderId)
                                        }
                                        repliedTo={
                                            message.replyToId
                                                ? (byId.get(
                                                      message.replyToId,
                                                  ) ?? null)
                                                : null
                                        }
                                        read={
                                            message.isOutgoing &&
                                            message.id <= readOutbox
                                        }
                                        username={dialog?.username ?? null}
                                        quickReactions={quick}
                                        canWrite={canWrite}
                                        onReply={() =>
                                            setMode({ kind: 'reply', message })
                                        }
                                        onEdit={() =>
                                            setMode({ kind: 'edit', message })
                                        }
                                        onDelete={(revoke) =>
                                            void deleteMessage(message, revoke)
                                        }
                                        onReact={(emoji) =>
                                            void react(message, emoji)
                                        }
                                        onJump={jumpTo}
                                        onOpenMedia={() =>
                                            setViewing(
                                                message.media?.key ?? null,
                                            )
                                        }
                                    />
                                </li>
                            ))}
                        </ol>
                    </div>
                )}
            </div>

            {awayFromBottom && messages.length > 0 ? (
                <Button
                    type="button"
                    variant="secondary"
                    size="icon"
                    className="absolute right-4 bottom-20 rounded-full shadow-md"
                    aria-label={
                        unseen > 0
                            ? `${unseen} new messages — scroll to the latest`
                            : 'Scroll to the latest message'
                    }
                    onClick={scrollToBottom}
                >
                    <ArrowDown />
                    {unseen > 0 ? (
                        <span className="bg-primary text-primary-foreground absolute -top-1.5 -right-1.5 min-w-5 rounded-full px-1 text-[10px] leading-5 font-semibold tabular-nums">
                            {unseen}
                        </span>
                    ) : null}
                </Button>
            ) : null}

            {enabled && dialog && (canWrite || writeBlock) ? (
                <ChatComposer
                    mode={mode}
                    compact={!full}
                    disabledReason={writeBlock}
                    onCancelMode={() => setMode({ kind: 'new' })}
                    onSend={send}
                    onAttach={onAttach}
                    onTyping={() =>
                        void import('@/lib/telegram/thread').then((mod) =>
                            mod.sendTypingAction(chatId),
                        )
                    }
                />
            ) : null}
            {viewItem ? (
                <Lightbox
                    item={viewItem}
                    tags={viewTags.data?.[String(viewItem.messageId)] ?? []}
                    onTagsChange={() => void viewTags.refetch()}
                    index={viewIndex}
                    total={viewable.length}
                    hasMore={false}
                    loadingMore={false}
                    onClose={() => setViewing(null)}
                    onPrev={() =>
                        setViewing(
                            viewable[Math.max(0, viewIndex - 1)]?.key ?? null,
                        )
                    }
                    onNext={() => {
                        const next = viewable[viewIndex + 1];
                        if (next) setViewing(next.key);
                    }}
                />
            ) : null}
        </section>
    );
}

/** Messages into the infinite-query data: replaced in place, or added newest. */
function upsertMessages(
    data: HistoryData,
    incoming: ThreadMessage[],
): HistoryData {
    const pending = new Map(incoming.map((message) => [message.id, message]));
    const pages = data.pages.map((page) => ({
        ...page,
        messages: page.messages.map((message) => {
            const next = pending.get(message.id);
            if (!next) return message;
            pending.delete(message.id);
            return next;
        }),
    }));
    const first = pages[0];
    if (first && pending.size > 0) {
        pages[0] = {
            ...first,
            messages: [...first.messages, ...pending.values()].sort(
                (a, b) => a.id - b.id,
            ),
        };
    }
    return { ...data, pages };
}

function startsNewDay(message: ThreadMessage, previous?: ThreadMessage) {
    if (!previous) return true;
    return (
        new Date(message.date).toDateString() !==
        new Date(previous.date).toDateString()
    );
}

function DayDivider({ date }: { date: string }) {
    return (
        <p className="text-muted-foreground/70 py-2 text-center text-[11px]">
            {formatMediaDate(date)}
        </p>
    );
}

type RowActions = {
    quickReactions: string[];
    canWrite: boolean;
    onReply: () => void;
    onEdit: () => void;
    onDelete: (revoke: boolean) => void;
    onReact: (emoji: string) => void;
    onJump: (messageId: number) => void;
    /** Open this message's media in the viewer. */
    onOpenMedia: () => void;
};

function MessageRow({
    message,
    variant,
    showSender,
    repliedTo,
    read,
    username,
    ...actions
}: {
    message: ThreadMessage;
    variant: 'rail' | 'full';
    showSender: boolean;
    repliedTo: ThreadMessage | null;
    /** An outgoing message the other side has read. */
    read: boolean;
    /** The chat's public handle, when it has one — it shapes the t.me link. */
    username: string | null;
} & RowActions) {
    const time = (
        <span
            className="text-muted-foreground inline-flex shrink-0 items-center gap-0.5 text-[11px] tabular-nums"
            title={formatMediaDateTime(message.date)}
        >
            {message.isEdited ? <span className="italic">edited</span> : null}
            {formatClockTime(message.date)}
            {message.isOutgoing ? (
                read ? (
                    <CheckCheck className="text-primary size-3.5" />
                ) : (
                    <Check className="size-3.5" />
                )
            ) : null}
        </span>
    );

    const body = (
        <>
            {message.replyToId ? (
                <button
                    type="button"
                    onClick={() =>
                        message.replyToId && actions.onJump(message.replyToId)
                    }
                    className="border-primary hover:bg-primary/5 mt-1 block w-full min-w-0 rounded-sm border-l-2 py-0.5 pl-2 text-left"
                >
                    <span className="text-primary block truncate text-[11px] font-medium">
                        {repliedTo?.senderName ?? 'Reply'}
                    </span>
                    <span className="text-muted-foreground block truncate text-[11px]">
                        {repliedTo ? snippet(repliedTo) : 'Earlier message'}
                    </span>
                </button>
            ) : null}
            <InlineMedia
                message={message}
                username={username}
                onOpen={actions.onOpenMedia}
            />
            {message.text ? (
                <p
                    className={cn(
                        'mt-1 break-words whitespace-pre-wrap',
                        variant === 'full' ? 'text-sm' : 'text-xs',
                    )}
                >
                    {message.text}
                </p>
            ) : null}
            <ReactionChips message={message} onReact={actions.onReact} />
        </>
    );

    if (variant === 'full') {
        const mine = message.isOutgoing;
        return (
            <div
                className={cn(
                    'group flex items-end gap-2',
                    mine ? 'flex-row-reverse' : 'flex-row',
                )}
            >
                {mine ? null : showSender ? (
                    <SenderAvatar message={message} size={28} />
                ) : (
                    <span className="w-7 shrink-0" />
                )}
                <div
                    className={cn(
                        'max-w-[min(36rem,80%)] min-w-0 rounded-2xl px-3 py-1.5',
                        mine
                            ? 'bg-primary/15 rounded-br-md'
                            : 'bg-muted rounded-bl-md',
                    )}
                >
                    {showSender && !mine ? (
                        <p className="text-primary truncate text-xs font-medium">
                            {message.senderName || 'Unknown'}
                        </p>
                    ) : null}
                    {body}
                    <div className="flex justify-end">{time}</div>
                </div>
                <MessageMenu
                    message={message}
                    username={username}
                    {...actions}
                />
            </div>
        );
    }

    return (
        <div className="group flex gap-2">
            <SenderAvatar message={message} size={28} />
            <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                    <p className="min-w-0 truncate text-xs font-medium">
                        {message.senderName || 'Unknown'}
                    </p>
                    <span className="flex items-center gap-1">
                        <MessageMenu
                            message={message}
                            username={username}
                            {...actions}
                        />
                        {time}
                    </span>
                </div>
                {body}
            </div>
        </div>
    );
}

/** The reactions already on a message; tapping one toggles yours. */
function ReactionChips({
    message,
    onReact,
}: {
    message: ThreadMessage;
    onReact: (emoji: string) => void;
}) {
    const shown = message.reactions.filter((item) => item.count > 0);
    if (shown.length === 0) return null;
    return (
        <div className="mt-1 flex flex-wrap gap-1">
            {shown.map((item) => (
                <button
                    key={item.emoji}
                    type="button"
                    aria-pressed={item.chosen}
                    aria-label={`React with ${item.emoji}`}
                    onClick={() => onReact(item.emoji)}
                    className={cn(
                        'inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs',
                        item.chosen
                            ? 'border-primary/50 bg-primary/15'
                            : 'border-border bg-background/60 hover:bg-accent',
                    )}
                >
                    <span>{displayReaction(item.emoji)}</span>
                    <span className="text-muted-foreground tabular-nums">
                        {item.count}
                    </span>
                </button>
            ))}
        </div>
    );
}

/** Everything that can be done to one message, behind its "…" button. */
function MessageMenu({
    message,
    username,
    quickReactions,
    canWrite,
    onReply,
    onEdit,
    onDelete,
    onReact,
}: { message: ThreadMessage; username: string | null } & RowActions) {
    const mine = message.isOutgoing;
    const canEdit = mine && message.text.length > 0;

    return (
        <DropdownMenu>
            <DropdownMenuTrigger
                render={
                    <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        aria-label="Message actions"
                        className="text-muted-foreground shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[popup-open]:opacity-100"
                    />
                }
            >
                <MoreHorizontal />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
                {quickReactions.length > 0 ? (
                    <>
                        <div className="flex flex-wrap gap-0.5 px-1 py-1">
                            {quickReactions.map((emoji) => (
                                <DropdownMenuItem
                                    key={emoji}
                                    aria-label={`React with ${emoji}`}
                                    className="justify-center px-1.5 text-base"
                                    onClick={() => onReact(emoji)}
                                >
                                    {displayReaction(emoji)}
                                </DropdownMenuItem>
                            ))}
                        </div>
                        <DropdownMenuSeparator />
                    </>
                ) : null}
                {canWrite ? (
                    <DropdownMenuItem onClick={onReply}>
                        <Reply />
                        Reply
                    </DropdownMenuItem>
                ) : null}
                {canEdit ? (
                    <DropdownMenuItem onClick={onEdit}>
                        <Pencil />
                        Edit
                    </DropdownMenuItem>
                ) : null}
                {message.text ? (
                    <DropdownMenuItem
                        onClick={() =>
                            void navigator.clipboard
                                .writeText(message.text)
                                .then(() => toast('Copied'))
                        }
                    >
                        <Copy />
                        Copy text
                    </DropdownMenuItem>
                ) : null}
                <DropdownMenuItem
                    render={
                        // biome-ignore lint/a11y/useAnchorContent: the menu item supplies the content
                        <a
                            href={telegramMessageLink(
                                message.chatId,
                                message.id,
                                username,
                            )}
                            target="_blank"
                            rel="noreferrer noopener"
                        />
                    }
                >
                    <ExternalLink />
                    Open in Telegram
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                {mine ? (
                    <DropdownMenuItem
                        variant="destructive"
                        onClick={() => onDelete(true)}
                    >
                        <Trash2 />
                        Delete for everyone
                    </DropdownMenuItem>
                ) : null}
                <DropdownMenuItem
                    variant="destructive"
                    onClick={() => onDelete(false)}
                >
                    <Trash2 />
                    {mine ? 'Delete for me' : 'Delete'}
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

/**
 * The message's media. A picture, video or sound opens in the app's own
 * viewer, the same one the media grid uses; a plain file, which the viewer
 * has nothing to show for, still hands the message to Telegram.
 */
function InlineMedia({
    message,
    username,
    onOpen,
}: {
    message: ThreadMessage;
    username: string | null;
    onOpen: () => void;
}) {
    const item = message.media;

    if (!item && message.kind !== 'file') return null;

    // Spoilers are shown uncovered, the same way the grid shows them.
    const blurred = false;
    const frame =
        'group/media border-border bg-card hover:border-ring/60 focus-visible:ring-ring/50 mt-1.5 block max-w-sm overflow-hidden rounded-md border text-left transition-colors focus-visible:ring-2 focus-visible:outline-none';

    if (item && isViewable(item)) {
        return (
            <button
                type="button"
                onClick={onOpen}
                aria-label={`Open ${item.type === 'photo' ? 'photo' : item.type === 'audio' || item.type === 'voice' ? 'audio' : 'video'}`}
                className={cn(frame, 'w-full')}
            >
                {item.type === 'photo' ||
                item.type === 'video' ||
                item.type === 'gif' ? (
                    <MediaPreview item={item} blurred={blurred} />
                ) : (
                    <FileRow message={message} />
                )}
            </button>
        );
    }

    return (
        <a
            href={telegramMessageLink(message.chatId, message.id, username)}
            target="_blank"
            rel="noreferrer noopener"
            className={frame}
        >
            <FileRow message={message} />
            <span className="text-muted-foreground group-hover/media:text-foreground border-border flex items-center gap-1.5 border-t px-2 py-1.5 text-[11px]">
                <ExternalLink className="size-3" />
                Open in Telegram
            </span>
        </a>
    );
}

/** What the viewer can show: pictures, video and sound. */
function isViewable(item: MediaItem) {
    return (
        item.type === 'photo' ||
        item.type === 'video' ||
        item.type === 'gif' ||
        item.type === 'audio' ||
        item.type === 'voice'
    );
}

/** A thumbnail, downloaded only once the row has been scrolled anywhere near. */
function MediaPreview({
    item,
    blurred,
}: {
    item: NonNullable<ThreadMessage['media']>;
    blurred: boolean;
}) {
    const ref = useRef<HTMLDivElement>(null);
    const [src, setSrc] = useState<string | null>(null);
    const [visible, setVisible] = useState(false);

    useEffect(() => {
        const node = ref.current;
        if (!node) return;
        const observer = new IntersectionObserver(
            ([entry]) => {
                if (entry?.isIntersecting) setVisible(true);
            },
            { rootMargin: '240px' },
        );
        observer.observe(node);
        return () => observer.disconnect();
    }, []);

    useEffect(() => {
        if (!visible) return;
        let live = true;
        void import('@/lib/telegram/media')
            .then((mod) => mod.downloadThumb(item))
            .then((url) => {
                if (live) setSrc(url);
            });
        return () => {
            live = false;
        };
    }, [item, visible]);

    return (
        <div ref={ref} className="bg-secondary/60 relative aspect-video">
            {src ? (
                <img
                    src={src}
                    alt={blurred ? '' : (item.caption ?? item.type)}
                    loading="lazy"
                    decoding="async"
                    className={cn(
                        'size-full object-cover',
                        blurred && 'scale-110 blur-xl saturate-50',
                    )}
                />
            ) : null}
            {blurred ? (
                <span className="bg-background/30 absolute inset-0 grid place-items-center">
                    <Lock className="text-foreground/80 size-4" />
                </span>
            ) : null}
            {item.type !== 'photo' ? (
                <span className="absolute bottom-1.5 left-1.5 inline-flex items-center gap-1 rounded bg-black/70 px-1.5 py-0.5 text-[11px] font-medium text-white tabular-nums">
                    <Play className="size-3 fill-current" />
                    {item.duration
                        ? formatDuration(item.duration)
                        : item.type === 'gif'
                          ? 'GIF'
                          : 'Video'}
                </span>
            ) : null}
        </div>
    );
}

/** Sound and documents, which the stream names rather than draws. */
function FileRow({ message }: { message: ThreadMessage }) {
    const isVoice = message.kind === 'voice';
    const Icon = message.kind === 'file' ? FileText : isVoice ? Mic : Music;
    const label =
        message.audioTitle ??
        message.fileName ??
        (isVoice
            ? 'Voice message'
            : message.kind === 'file'
              ? 'File'
              : 'Audio');

    return (
        <span className="flex items-center gap-2 px-2 py-2">
            <Icon className="text-muted-foreground size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate text-xs">{label}</span>
            {message.duration ? (
                <span className="text-muted-foreground shrink-0 text-[11px] tabular-nums">
                    {formatDuration(message.duration)}
                </span>
            ) : null}
        </span>
    );
}

function StreamSkeleton() {
    return (
        <div className="flex flex-col gap-3">
            {['a', 'b', 'c', 'd'].map((id) => (
                <div key={id} className="flex gap-2">
                    <Skeleton className="size-7 shrink-0 rounded-full" />
                    <div className="min-w-0 flex-1">
                        <Skeleton className="h-3 w-24" />
                        <Skeleton className="mt-1.5 h-3 w-full" />
                    </div>
                </div>
            ))}
        </div>
    );
}
