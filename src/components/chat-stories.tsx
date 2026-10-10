import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
    ChevronDown,
    ChevronLeft,
    ChevronRight,
    CircleDashed,
    Pause,
    Play,
    X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
    Carousel,
    CarouselContent,
    CarouselItem,
    CarouselNext,
    CarouselPrevious,
} from '@/components/ui/carousel';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { useMouseBackToClose } from '@/hooks/use-mouse-navigation';
import { formatDuration, formatRelativeTime } from '@/lib/format';
import { readStorySnapshot, writeStorySnapshot } from '@/lib/story-snapshot';
import type { StoryItem, StoryPeer } from '@/lib/telegram/stories';
import type { DialogItem } from '@/lib/telegram/types';
import { cn } from '@/lib/utils';
import { useTelegram } from '@/providers/telegram-provider';

/** How long a photo story stays up before the viewer moves on. */
const PHOTO_MS = 6_000;

/** The strip's two fixed heights; nothing below moves except between them. */
const STRIP_EXPANDED = 'h-48';
const STRIP_COLLAPSED = 'h-16';

/**
 * One chat's stories, from last launch's snapshot until Telegram answers.
 * Shared by the chat strip and the library bar's viewer, so both read and
 * mark the same list.
 */
function useChatStories(peerId: number, enabled: boolean) {
    const accountId = useTelegram().user?.id;
    return useQuery({
        queryKey: ['stories', peerId],
        enabled,
        staleTime: 60_000,
        retry: false,
        initialData: () =>
            readStorySnapshot<StoryItem[]>(accountId, `chat:${peerId}`),
        initialDataUpdatedAt: 0,
        queryFn: async () => {
            const { loadStories } = await import('@/lib/telegram/stories');
            const items = await loadStories(peerId);
            writeStorySnapshot(accountId, `chat:${peerId}`, items);
            return items;
        },
    });
}

/**
 * How many stories a chat has, for the header's toggle. Same query as the
 * strip, so the count and the cards never disagree and only one request runs.
 */
export function useChatStoryCount(peerId: number, enabled: boolean) {
    const stories = useChatStories(peerId, enabled);
    return stories.data ? stories.data.length : null;
}

/**
 * A chat's stories, across the top of the centre.
 *
 * A channel's stories are its status: short-lived posts that sit above the
 * feed rather than in it. Big cards while the reader is at the start of the
 * content; once they scroll into it the strip folds to one slim row of
 * round thumbnails. Either way the strip is a fixed-height box — loading,
 * empty ("No stories") or full — so the chat below never jumps.
 */
export function StoriesCarousel({
    chatId,
    title,
    enabled,
    collapsed = false,
    onExpand,
}: {
    chatId: number;
    title: string;
    enabled: boolean;
    /** The reader has scrolled into the content: show the slim row. */
    collapsed?: boolean;
    /** The slim row's chevron: open the cards again. */
    onExpand?: () => void;
}) {
    const [openAt, setOpenAt] = useState<number | null>(null);
    const queryClient = useQueryClient();
    const stories = useChatStories(chatId, enabled);

    const items = stories.data ?? [];

    const markRead = useCallback(
        (item: StoryItem) => {
            if (item.isRead) return;
            void import('@/lib/telegram/stories').then((mod) =>
                mod.markStoryRead(item),
            );
            queryClient.setQueryData<StoryItem[]>(['stories', chatId], (data) =>
                data?.map((story) =>
                    story.isActive && story.id <= item.id
                        ? { ...story, isRead: true }
                        : story,
                ),
            );
        },
        [chatId, queryClient],
    );

    const live = items.filter((item) => item.isActive).length;
    const label =
        live > 0
            ? `Stories · ${live} live`
            : `Stories · ${items.length} pinned`;
    // Not known yet: hold the slim height rather than guess big and shrink.
    const loading = items.length === 0 && (!enabled || stories.isPending);
    const empty = items.length === 0 && !loading;
    const slim = loading || empty || collapsed;

    return (
        <section
            aria-label={`${title} stories`}
            aria-busy={loading || undefined}
            className={cn(
                'border-border shrink-0 overflow-hidden border-b transition-[height] duration-200 ease-out',
                slim ? STRIP_COLLAPSED : STRIP_EXPANDED,
            )}
        >
            {loading ? (
                <div className="flex h-full items-center gap-3 px-4">
                    {['a', 'b', 'c', 'd', 'e', 'f'].map((id) => (
                        <Skeleton key={id} className="size-10 rounded-full" />
                    ))}
                </div>
            ) : empty ? (
                <p className="text-muted-foreground flex h-full items-center justify-center gap-2 px-4 text-xs">
                    <CircleDashed className="size-4" />
                    No stories
                </p>
            ) : collapsed ? (
                <div className="flex h-full items-center gap-3 px-4">
                    <p className="text-muted-foreground shrink-0 text-[11px] font-medium tracking-wide uppercase">
                        {label}
                    </p>
                    <ul className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto py-1 [scrollbar-width:none]">
                        {items.map((item, index) => (
                            <li key={item.key} className="shrink-0">
                                <StoryDot
                                    item={item}
                                    onOpen={() => setOpenAt(index)}
                                />
                            </li>
                        ))}
                    </ul>
                    {onExpand ? (
                        <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            aria-label="Show story cards"
                            className="text-muted-foreground shrink-0"
                            onClick={onExpand}
                        >
                            <ChevronDown />
                        </Button>
                    ) : null}
                </div>
            ) : (
                <div className="px-4 pt-3 pb-3">
                    <p className="text-muted-foreground mb-2 text-center text-[11px] font-medium tracking-wide uppercase">
                        {label}
                    </p>
                    <Carousel
                        opts={{ align: 'center', dragFree: true }}
                        className="mx-auto w-full max-w-3xl px-10"
                    >
                        <CarouselContent
                            className={cn(
                                '-ml-3',
                                // A short strip sits in the middle rather than
                                // hugging the left edge.
                                items.length <= 5 && 'justify-center',
                            )}
                        >
                            {items.map((item, index) => (
                                <CarouselItem
                                    key={item.key}
                                    className="basis-auto pl-3"
                                >
                                    <StoryCard
                                        item={item}
                                        onOpen={() => setOpenAt(index)}
                                    />
                                </CarouselItem>
                            ))}
                        </CarouselContent>
                        <CarouselPrevious className="left-0" />
                        <CarouselNext className="right-0" />
                    </Carousel>
                </div>
            )}

            {openAt !== null && items.length > 0 ? (
                <StoryViewer
                    title={title}
                    items={items}
                    index={Math.min(openAt, items.length - 1)}
                    onIndexChange={setOpenAt}
                    onSeen={markRead}
                    onClose={() => setOpenAt(null)}
                />
            ) : null}
        </section>
    );
}

/** A story in the slim row: a small round thumbnail, ringed until watched. */
function StoryDot({ item, onOpen }: { item: StoryItem; onOpen: () => void }) {
    const src = useStoryThumb(item);
    const unread = item.isActive && !item.isRead;
    return (
        <button
            type="button"
            onClick={onOpen}
            aria-label={`Open story from ${formatRelativeTime(item.date)}${unread ? ', not watched yet' : ''}`}
            className={cn(
                'focus-visible:ring-ring/50 block rounded-full p-0.5 outline-none focus-visible:ring-3',
                unread
                    ? 'bg-gradient-to-tr from-sky-500 via-violet-500 to-pink-500'
                    : 'bg-border',
            )}
        >
            <span className="bg-muted border-background block size-10 overflow-hidden rounded-full border-2">
                {src ? (
                    <img src={src} alt="" className="size-full object-cover" />
                ) : null}
            </span>
        </button>
    );
}

function useStoryThumb(item: StoryItem) {
    const thumb = useQuery({
        queryKey: ['story-thumb', item.key],
        staleTime: Infinity,
        retry: false,
        queryFn: async () => {
            const { downloadStoryThumb } = await import(
                '@/lib/telegram/stories'
            );
            return downloadStoryThumb(item);
        },
    });
    return thumb.data ?? null;
}

function StoryCard({ item, onOpen }: { item: StoryItem; onOpen: () => void }) {
    const src = useStoryThumb(item);
    const unread = item.isActive && !item.isRead;

    return (
        <button
            type="button"
            onClick={onOpen}
            aria-label={`Open story from ${formatRelativeTime(item.date)}${unread ? ', not watched yet' : ''}`}
            className={cn(
                'group focus-visible:ring-ring/50 relative block h-36 w-24 overflow-hidden rounded-xl p-0.5 outline-none focus-visible:ring-3',
                unread
                    ? 'bg-gradient-to-tr from-sky-500 via-violet-500 to-pink-500'
                    : 'bg-border',
            )}
        >
            <span className="bg-muted relative block size-full overflow-hidden rounded-[10px]">
                {src ? (
                    <img
                        src={src}
                        alt=""
                        className="size-full object-cover transition-transform group-hover:scale-105"
                    />
                ) : null}
                <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-1.5 pt-4 pb-1 text-left text-[10px] text-white">
                    {item.isActive ? formatRelativeTime(item.date) : 'Pinned'}
                </span>
                {item.type === 'video' ? (
                    <span className="absolute top-1 right-1 inline-flex items-center gap-0.5 rounded bg-black/60 px-1 text-[10px] text-white tabular-nums">
                        <Play className="size-2.5 fill-current" />
                        {item.duration ? formatDuration(item.duration) : ''}
                    </span>
                ) : null}
            </span>
        </button>
    );
}

/**
 * One story at a time, full height, the way Telegram plays them.
 *
 * Photos stay up for a few seconds and videos play to their end, then the
 * next story starts; the bars along the top say where in the run you are.
 * Arrow keys and the two halves of the picture step back and forward.
 */
function StoryViewer({
    title,
    items,
    index,
    onIndexChange,
    onSeen,
    onClose,
    onRunOut,
}: {
    title: string;
    items: StoryItem[];
    index: number;
    onIndexChange: (index: number) => void;
    onSeen: (item: StoryItem) => void;
    onClose: () => void;
    /**
     * Stepping past either end of this run. The stories bar uses it to move
     * on to the next person's stories; without it the end closes the viewer.
     */
    onRunOut?: (direction: 'next' | 'prev') => void;
}) {
    const item = items[index];
    const [paused, setPaused] = useState(false);
    const videoRef = useRef<HTMLVideoElement>(null);
    // The current story's bar is painted from a frame loop, straight onto the
    // DOM, so it glides instead of stepping with each render or `timeupdate`.
    // `progress` is the resume point the loop picks up from after a pause.
    const progress = useRef(0);
    const barRef = useRef<HTMLSpanElement>(null);
    const paintBar = useCallback((fraction: number) => {
        progress.current = fraction;
        if (barRef.current) {
            barRef.current.style.transform = `scaleX(${fraction})`;
        }
    }, []);

    // `paused` is the one switch for both kinds: the photo clock reads it
    // below, and a video is made to follow it here — otherwise pausing only
    // froze the bars while the video played on.
    useEffect(() => {
        const video = videoRef.current;
        if (!video) return;
        if (paused && !video.paused) video.pause();
        if (!paused && video.paused && !video.ended) {
            void video.play().catch(() => undefined);
        }
    }, [paused]);

    const full = useQuery({
        queryKey: ['story-full', item?.key],
        enabled: Boolean(item),
        staleTime: Infinity,
        retry: false,
        queryFn: async () => {
            const { downloadStoryFull } = await import(
                '@/lib/telegram/stories'
            );
            return downloadStoryFull(item as StoryItem);
        },
    });
    const thumb = useStoryThumb(item as StoryItem);
    const queryClient = useQueryClient();

    // The next two stories download while this one plays, so a tap forward
    // shows a picture rather than "Loading…". Same query key as above, so the
    // viewer simply finds them in the cache.
    useEffect(() => {
        for (const ahead of items.slice(index + 1, index + 3)) {
            void queryClient.prefetchQuery({
                queryKey: ['story-full', ahead.key],
                staleTime: Infinity,
                queryFn: async () => {
                    const { downloadStoryFull } = await import(
                        '@/lib/telegram/stories'
                    );
                    return downloadStoryFull(ahead);
                },
            });
        }
    }, [index, items, queryClient]);

    const next = useCallback(() => {
        if (index + 1 < items.length) onIndexChange(index + 1);
        else if (onRunOut) onRunOut('next');
        else onClose();
    }, [index, items.length, onClose, onIndexChange, onRunOut]);

    const prev = useCallback(() => {
        if (index > 0) onIndexChange(index - 1);
        else onRunOut?.('prev');
    }, [index, onIndexChange, onRunOut]);

    useEffect(() => {
        paintBar(0);
        setPaused(false);
        if (item) onSeen(item);
    }, [item, onSeen, paintBar]);

    // One frame loop for both kinds: a photo runs on its own clock, resumed
    // from `progress`; a video is read off the element every frame, which
    // moves far more smoothly than the few `timeupdate`s a second.
    useEffect(() => {
        if (!item || !full.data || paused) return;
        const isPhoto = item.type === 'photo';
        const started = performance.now() - progress.current * PHOTO_MS;
        let frame = 0;
        const tick = (now: number) => {
            if (isPhoto) {
                const done = (now - started) / PHOTO_MS;
                if (done >= 1) {
                    paintBar(1);
                    next();
                    return;
                }
                paintBar(Math.max(0, done));
            } else {
                const video = videoRef.current;
                if (video?.duration) {
                    paintBar(Math.min(1, video.currentTime / video.duration));
                }
            }
            frame = requestAnimationFrame(tick);
        };
        frame = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(frame);
    }, [item, full.data, paused, next, paintBar]);

    // Capture phase: the dialog stops keys from bubbling back out of it, so a
    // listener on the way up never hears the arrows.
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.key === 'ArrowRight') {
                event.preventDefault();
                next();
            }
            if (event.key === 'ArrowLeft') {
                event.preventDefault();
                prev();
            }
            if (event.key === ' ') {
                event.preventDefault();
                setPaused((value) => !value);
            }
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, [next, prev]);

    useMouseBackToClose(onClose);

    if (!item) return null;

    return (
        <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
            <DialogContent
                showCloseButton={false}
                // The whole window, the way a story is meant to be watched:
                // no card, no margin, nothing of the app showing round it.
                className="top-0 left-0 block h-dvh w-screen max-w-none translate-x-0 translate-y-0 gap-0 overflow-hidden rounded-none bg-black p-0 text-white ring-0 sm:max-w-none"
            >
                <DialogTitle className="sr-only">{title} story</DialogTitle>
                <DialogDescription className="sr-only">
                    Story {index + 1} of {items.length}
                </DialogDescription>

                <div className="relative size-full">
                    {/*
                        The picture again, blurred and cropped to fill, so a
                        portrait story on a wide screen sits in its own colour
                        rather than in two black bars.
                    */}
                    {thumb ? (
                        <img
                            src={thumb}
                            alt=""
                            aria-hidden="true"
                            className="absolute inset-0 size-full scale-110 object-cover opacity-50 blur-2xl"
                        />
                    ) : null}
                    {full.data ? (
                        item.type === 'video' ? (
                            <video
                                key={item.key}
                                ref={videoRef}
                                src={full.data}
                                autoPlay
                                playsInline
                                className="relative size-full object-contain"
                                onPause={() => setPaused(true)}
                                onPlay={() => setPaused(false)}
                                onEnded={next}
                            >
                                <track
                                    kind="captions"
                                    label="None"
                                    srcLang="und"
                                />
                            </video>
                        ) : (
                            <img
                                src={full.data}
                                alt={item.caption ?? ''}
                                className="relative size-full object-contain"
                            />
                        )
                    ) : (
                        <span className="absolute inset-0 grid place-items-center text-xs text-white/70">
                            {full.error
                                ? 'Could not load this story.'
                                : 'Loading…'}
                        </span>
                    )}

                    {/* Tap zones: left half back, right half forward. */}
                    <button
                        type="button"
                        aria-label="Previous story"
                        className="absolute inset-y-16 left-0 w-1/3"
                        onClick={prev}
                    />
                    <button
                        type="button"
                        aria-label="Next story"
                        className="absolute inset-y-16 right-0 w-1/3"
                        onClick={next}
                    />

                    <div className="absolute inset-x-0 top-0 bg-gradient-to-b from-black/70 to-transparent px-4 pt-3 pb-8">
                        <div className="flex gap-1">
                            {items.map((story, at) => (
                                <span
                                    key={story.key}
                                    className="h-0.5 flex-1 overflow-hidden rounded-full bg-white/30"
                                >
                                    {/*
                                        The current bar's transform is the
                                        frame loop's; React only ever writes
                                        scaleX(0) there, and never rewrites an
                                        unchanged style, so it stays out of
                                        the loop's way.
                                    */}
                                    <span
                                        ref={at === index ? barRef : undefined}
                                        className="block h-full origin-left bg-white will-change-transform"
                                        style={{
                                            transform: `scaleX(${at < index ? 1 : 0})`,
                                        }}
                                    />
                                </span>
                            ))}
                        </div>
                        <div className="mt-2 flex items-center gap-2">
                            <div className="min-w-0 flex-1">
                                <p className="truncate text-sm font-medium">
                                    {title}
                                </p>
                                <p className="text-xs text-white/60">
                                    {formatRelativeTime(item.date)}
                                    {item.isPinned ? ' · pinned' : ''}
                                </p>
                            </div>
                            <Button
                                type="button"
                                size="icon-sm"
                                variant="ghost"
                                className="text-white hover:bg-white/10 hover:text-white"
                                aria-label={paused ? 'Play' : 'Pause'}
                                onClick={() => setPaused((value) => !value)}
                            >
                                {paused ? (
                                    <Play className="fill-current" />
                                ) : (
                                    <Pause className="fill-current" />
                                )}
                            </Button>
                            <Button
                                type="button"
                                size="icon-sm"
                                variant="ghost"
                                className="text-white hover:bg-white/10 hover:text-white"
                                aria-label="Close"
                                onClick={onClose}
                            >
                                <X />
                            </Button>
                        </div>
                    </div>

                    {item.caption ? (
                        <p className="absolute inset-x-0 bottom-0 max-h-1/3 overflow-y-auto bg-gradient-to-t from-black/80 to-transparent px-4 pt-10 pb-6 text-center text-sm whitespace-pre-wrap">
                            <span className="mx-auto block max-w-2xl">
                                {item.caption}
                            </span>
                        </p>
                    ) : null}

                    <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost"
                        aria-label="Previous story"
                        disabled={index === 0 && !onRunOut}
                        className="absolute top-1/2 left-3 -translate-y-1/2 text-white hover:bg-white/10 hover:text-white"
                        onClick={prev}
                    >
                        <ChevronLeft />
                    </Button>
                    <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost"
                        aria-label="Next story"
                        className="absolute top-1/2 right-3 -translate-y-1/2 text-white hover:bg-white/10 hover:text-white"
                        onClick={next}
                    >
                        <ChevronRight />
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    );
}

/** The library bar's one height, whatever it is showing. */
const BAR_HEIGHT = 'h-[104px]';

/** How many of the most recent chats are checked for pinned stories. */
const PINNED_CANDIDATES = 30;

/** Open a ring at its first unwatched story. */
const RESUME = -2;
/** Open a ring at its last story. */
const LAST = -1;

/**
 * Everyone with stories up, across the top of the library — Telegram's own
 * top bar. A ring per person or channel, coloured until watched; opening one
 * plays their stories full screen and runs on into the next ring's, so the
 * whole bar can be watched in one go. A fixed-height box in every state, so
 * the chat list under it never jumps; says so when nobody has any.
 */
export function StoriesBar({ dialogs }: { dialogs: DialogItem[] }) {
    const queryClient = useQueryClient();
    const accountId = useTelegram().user?.id;
    // The newest chat list, read when the pinned check runs rather than put
    // in its key: the list reorders on every message, and a key that follows
    // it re-ran thirty requests each time.
    const latestDialogs = useRef(dialogs);
    latestDialogs.current = dialogs;
    const [open, setOpen] = useState<{ peer: number; index: number } | null>(
        null,
    );

    const peers = useQuery({
        queryKey: ['story-peers'],
        staleTime: 60_000,
        refetchInterval: 5 * 60_000,
        retry: false,
        initialData: () =>
            readStorySnapshot<StoryPeer[]>(accountId, 'live-peers'),
        initialDataUpdatedAt: 0,
        queryFn: async () => {
            const { loadStoryPeers } = await import('@/lib/telegram/stories');
            const list = await loadStoryPeers();
            writeStorySnapshot(accountId, 'live-peers', list);
            return list;
        },
    });

    // Telegram's story list holds live stories only. People and channels
    // whose stories are pinned to their profile are found among the most
    // recent chats instead, so the bar shows them too.
    const pinned = useQuery({
        queryKey: ['story-pinned-peers'],
        enabled: dialogs.length > 0,
        staleTime: 10 * 60_000,
        retry: false,
        initialData: () =>
            readStorySnapshot<StoryPeer[]>(accountId, 'pinned-peers'),
        initialDataUpdatedAt: 0,
        queryFn: async () => {
            const candidates = latestDialogs.current
                .filter(
                    (item) =>
                        !item.isArchived &&
                        (item.kind === 'direct' || item.kind === 'channel'),
                )
                .slice(0, PINNED_CANDIDATES)
                .map((item) => ({
                    id: item.id,
                    title: item.title,
                    hasPhoto: item.hasPhoto,
                }));
            const { loadPinnedStoryPeers } = await import(
                '@/lib/telegram/stories'
            );
            const list = await loadPinnedStoryPeers(candidates);
            writeStorySnapshot(accountId, 'pinned-peers', list);
            return list;
        },
    });

    const list = useMemo(() => {
        const live = peers.data ?? [];
        const ids = new Set(live.map((item) => item.peerId));
        return [
            ...live,
            ...(pinned.data ?? []).filter((item) => !ids.has(item.peerId)),
        ];
    }, [peers.data, pinned.data]);

    const current = open ? list[open.peer] : undefined;

    if (list.length === 0) {
        const loading = peers.isPending || pinned.isPending;
        return (
            <section
                aria-label="Stories"
                aria-busy={loading || undefined}
                className={cn(BAR_HEIGHT, 'border-border shrink-0 border-b')}
            >
                {loading ? (
                    <div className="flex h-full items-center gap-4 px-12">
                        {['a', 'b', 'c', 'd', 'e', 'f'].map((id) => (
                            <div
                                key={id}
                                className="flex flex-col items-center gap-1.5"
                            >
                                <Skeleton className="size-14 rounded-full" />
                                <Skeleton className="h-2.5 w-12" />
                            </div>
                        ))}
                    </div>
                ) : (
                    <p className="text-muted-foreground flex h-full items-center justify-center gap-2 text-xs">
                        <CircleDashed className="size-4" />
                        No stories right now
                    </p>
                )}
            </section>
        );
    }

    return (
        <section
            aria-label="Stories"
            className={cn(
                BAR_HEIGHT,
                'border-border flex shrink-0 items-center border-b px-4',
            )}
        >
            <Carousel
                opts={{ align: 'start', dragFree: true }}
                className="w-full px-8"
            >
                <CarouselContent className="-ml-4">
                    {list.map((peer, at) => (
                        <CarouselItem
                            key={peer.peerId}
                            className="basis-auto pl-4"
                        >
                            <StoryRing
                                peer={peer}
                                onOpen={() =>
                                    setOpen({ peer: at, index: RESUME })
                                }
                            />
                        </CarouselItem>
                    ))}
                </CarouselContent>
                <CarouselPrevious className="left-0" />
                <CarouselNext className="right-0" />
            </Carousel>

            {open && current ? (
                <PeerStoryViewer
                    key={current.peerId}
                    peer={current}
                    index={open.index}
                    onIndexChange={(index) => setOpen({ ...open, index })}
                    onClose={() => setOpen(null)}
                    onWatched={() =>
                        queryClient.setQueryData<StoryPeer[]>(
                            ['story-peers'],
                            (data) =>
                                data?.map((item) =>
                                    item.peerId === current.peerId
                                        ? { ...item, hasUnread: false }
                                        : item,
                                ),
                        )
                    }
                    onRunOut={(direction) => {
                        const to = open.peer + (direction === 'next' ? 1 : -1);
                        if (to < 0) return;
                        if (to >= list.length) setOpen(null);
                        // Going back lands on the previous person's last story.
                        else
                            setOpen({
                                peer: to,
                                index: direction === 'next' ? RESUME : LAST,
                            });
                    }}
                />
            ) : null}
        </section>
    );
}

function StoryRing({ peer, onOpen }: { peer: StoryPeer; onOpen: () => void }) {
    const avatar = useQuery({
        queryKey: ['story-peer-avatar', peer.peerId],
        enabled: peer.hasPhoto,
        staleTime: Infinity,
        retry: false,
        queryFn: async () => {
            const { downloadStoryPeerAvatar } = await import(
                '@/lib/telegram/stories'
            );
            // A ring found through the chat list has its photo there.
            const fromStories = await downloadStoryPeerAvatar(peer.peerId);
            if (fromStories) return fromStories;
            const { downloadAvatar } = await import('@/lib/telegram/dialogs');
            return downloadAvatar(peer.peerId);
        },
    });

    return (
        <button
            type="button"
            onClick={onOpen}
            aria-label={`Stories from ${peer.title}${peer.hasUnread ? ', not watched yet' : ''}`}
            className="group focus-visible:ring-ring/50 flex w-16 flex-col items-center gap-1 rounded-lg outline-none focus-visible:ring-3"
        >
            <span
                className={cn(
                    'block rounded-full p-0.5',
                    peer.hasUnread
                        ? 'bg-gradient-to-tr from-sky-500 via-violet-500 to-pink-500'
                        : 'bg-border',
                )}
            >
                <span className="bg-muted border-background grid size-14 place-items-center overflow-hidden rounded-full border-2 text-sm font-semibold">
                    {avatar.data ? (
                        <img
                            src={avatar.data}
                            alt=""
                            className="size-full object-cover transition-transform group-hover:scale-105"
                        />
                    ) : (
                        initialsOf(peer.title)
                    )}
                </span>
            </span>
            <span
                className={cn(
                    'w-full truncate text-center text-[11px]',
                    peer.hasUnread
                        ? 'text-foreground'
                        : 'text-muted-foreground',
                )}
            >
                {peer.title}
            </span>
        </button>
    );
}

/**
 * One person's live stories in the full-screen viewer, read when their ring
 * is opened. `index` may also be RESUME (their first unwatched story) or LAST
 * (their last, for stepping back into them); both are resolved here, once the
 * stories are known.
 */
function PeerStoryViewer({
    peer,
    index,
    onIndexChange,
    onClose,
    onWatched,
    onRunOut,
}: {
    peer: StoryPeer;
    index: number;
    onIndexChange: (index: number) => void;
    onClose: () => void;
    onWatched: () => void;
    onRunOut: (direction: 'next' | 'prev') => void;
}) {
    const queryClient = useQueryClient();
    const stories = useChatStories(peer.peerId, true);

    // The bar is about what is live; pinned profile stories stay in the chat.
    const live = (stories.data ?? []).filter((item) => item.isActive);
    const items = live.length > 0 ? live : (stories.data ?? []);
    const firstUnread = items.findIndex((item) => !item.isRead);
    const at =
        index === LAST
            ? items.length - 1
            : index === RESUME
              ? Math.max(firstUnread, 0)
              : index;

    // Pin a RESUME or LAST down to a real index as soon as it is known, so
    // watching a story (which moves "first unwatched") cannot move the viewer.
    useEffect(() => {
        if (index < 0 && items.length > 0) onIndexChange(at);
    }, [at, index, items.length, onIndexChange]);

    const markRead = useCallback(
        (item: StoryItem) => {
            if (item.isRead) return;
            void import('@/lib/telegram/stories').then((mod) =>
                mod.markStoryRead(item),
            );
            queryClient.setQueryData<StoryItem[]>(
                ['stories', peer.peerId],
                (data) =>
                    data?.map((story) =>
                        story.isActive && story.id <= item.id
                            ? { ...story, isRead: true }
                            : story,
                    ),
            );
            if (item.id === items[items.length - 1]?.id) onWatched();
        },
        [items, onWatched, peer.peerId, queryClient],
    );

    // Only while loading: once the stories are in, StoryViewer claims the button.
    const loading = stories.isPending || items.length === 0;
    useMouseBackToClose(onClose, loading);

    if (loading) {
        return (
            <Dialog open onOpenChange={(next) => (next ? null : onClose())}>
                <DialogContent
                    showCloseButton
                    className="top-0 left-0 grid h-dvh w-screen max-w-none translate-x-0 translate-y-0 place-items-center rounded-none bg-black text-white ring-0 sm:max-w-none"
                >
                    <DialogTitle className="sr-only">
                        {peer.title} stories
                    </DialogTitle>
                    <DialogDescription className="text-sm text-white/70">
                        {stories.isPending
                            ? 'Loading…'
                            : 'These stories are no longer available.'}
                    </DialogDescription>
                </DialogContent>
            </Dialog>
        );
    }

    return (
        <StoryViewer
            title={peer.title}
            items={items}
            index={Math.min(Math.max(at, 0), items.length - 1)}
            onIndexChange={onIndexChange}
            onSeen={markRead}
            onClose={onClose}
            onRunOut={onRunOut}
        />
    );
}

function initialsOf(title: string) {
    const parts = title.trim().split(/\s+/).slice(0, 2);
    return parts.map((part) => part[0]?.toUpperCase() ?? '').join('') || '·';
}
