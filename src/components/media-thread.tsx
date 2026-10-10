import {
    ChevronLeft,
    ChevronRight,
    LoaderCircle,
    Pause,
    Play,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { SenderAvatar } from '@/components/sender-avatar';
import { Button } from '@/components/ui/button';
import { debug } from '@/lib/debug';
import {
    formatClockTime,
    formatDuration,
    formatMediaDateTime,
    formatRelativeDateTime,
} from '@/lib/format';
import { buildReactionRow, displayReaction } from '@/lib/telegram/reactions';
import type { MediaItem, ThreadMessage } from '@/lib/telegram/types';
import { cn } from '@/lib/utils';

function fallbackMessage(item: MediaItem): ThreadMessage {
    return {
        id: item.messageId,
        chatId: item.chatId,
        date: item.date,
        dateUnix: Math.floor(new Date(item.date).getTime() / 1000),
        senderName: '',
        text: item.caption ?? '',
        kind: item.type,
        duration: item.duration,
        isOutgoing: false,
        reactions: [],
    };
}

/**
 * The conversation around one media item.
 *
 * Beside the media from `lg` up, and inside the viewer's own drawer below it —
 * `className` is how the caller says which. Only ever one of the two is
 * mounted: this pane asks Telegram for the thread as soon as it renders, so a
 * second copy kept alive behind `hidden` would fetch every thread twice.
 */
export function MediaThread({
    item,
    index,
    total,
    hasMore,
    loadingMore,
    onPrev,
    onNext,
    className,
}: {
    item: MediaItem;
    index: number;
    /** How many items are loaded — not how many the chat holds. */
    total: number;
    /** Another page can still be fetched, so the end of `total` is not the end. */
    hasMore: boolean;
    /** That page is on its way; Next is waiting on it rather than refusing. */
    loadingMore: boolean;
    onPrev: () => void;
    onNext: () => void;
    /** Where this pane sits: the side rail's width, or the drawer's height. */
    className?: string;
}) {
    const [current, setCurrent] = useState<ThreadMessage>(() =>
        fallbackMessage(item),
    );
    const [messages, setMessages] = useState<ThreadMessage[]>([]);
    const [nextVideo, setNextVideo] = useState<ThreadMessage | null>(null);
    const [hasNewer, setHasNewer] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [loadingNewer, setLoadingNewer] = useState(false);

    const atLoadedEnd = index >= total - 1;

    useEffect(() => {
        let live = true;
        setLoading(true);
        setError(null);
        setMessages([]);
        setNextVideo(null);
        setCurrent(fallbackMessage(item));
        void import('@/lib/telegram/thread')
            .then((mod) =>
                mod.loadThreadAround(item.chatId, item.messageId, item.date),
            )
            .then((page) => {
                if (!live) return;
                if (page.current) setCurrent(page.current);
                setMessages(page.messages);
                setNextVideo(page.nextVideo ?? null);
                setHasNewer(page.hasNewer);
            })
            .catch((caught: unknown) => {
                if (!live) return;
                setError(
                    caught instanceof Error
                        ? caught.message
                        : 'Could not load the next messages.',
                );
            })
            .finally(() => {
                if (live) setLoading(false);
            });
        return () => {
            live = false;
        };
    }, [item]);

    async function loadMore() {
        const newest = messages[messages.length - 1] ?? current;
        setLoadingNewer(true);
        try {
            const { loadNewerThread } = await import('@/lib/telegram/thread');
            const page = await loadNewerThread(item.chatId, newest);
            setMessages((currentMessages) =>
                mergeMessages(currentMessages, page.messages),
            );
            setNextVideo(page.nextVideo ?? null);
            setHasNewer(page.hasNewer);
        } catch (caught) {
            setError(
                caught instanceof Error
                    ? caught.message
                    : 'Could not load more messages.',
            );
        } finally {
            setLoadingNewer(false);
        }
    }

    return (
        <aside
            className={cn(
                'flex min-h-0 w-full shrink-0 flex-col bg-black',
                className,
            )}
        >
            {/*
                A tall caption must not crowd out the messages under
                it. The cap is a share of this pane, not of the
                viewport: in the drawer those are not the same thing,
                and `50vh` of a screen inside an 80dvh sheet left room
                for barely a message.
            */}
            <header className="flex max-h-[45%] shrink-0 flex-col border-b border-white/10">
                <div className="min-h-0 overflow-y-auto px-4 py-3">
                    <SenderHeading
                        message={current}
                        time={formatRelativeDateTime(current.date)}
                        exactTime={formatMediaDateTime(current.date)}
                        size="lg"
                    />
                    {current.text ? (
                        <p className="mt-3 text-sm whitespace-pre-wrap text-white/80">
                            {current.text}
                        </p>
                    ) : null}
                </div>
                <div className="sticky bottom-0 shrink-0 border-t border-white/10 bg-black px-4 py-2">
                    <ReactionRow
                        message={current}
                        onChange={(next) => setCurrent(next)}
                        explainEmpty
                    />
                </div>
            </header>
            <div className="flex shrink-0 items-center justify-between gap-2 border-b border-white/10 px-2 py-1.5">
                <Button
                    variant="ghost"
                    size="icon-sm"
                    className="text-white hover:bg-white/10"
                    onClick={onPrev}
                    disabled={index === 0}
                    aria-label="Previous media"
                >
                    <ChevronLeft />
                </Button>
                <p className="text-xs text-white/55 tabular-nums">
                    {index + 1} / {total}
                </p>
                <Button
                    variant="ghost"
                    size="icon-sm"
                    className="text-white hover:bg-white/10"
                    onClick={onNext}
                    disabled={atLoadedEnd && !hasMore}
                    aria-label="Next media"
                >
                    {atLoadedEnd && loadingMore ? (
                        <LoaderCircle className="animate-spin" />
                    ) : (
                        <ChevronRight />
                    )}
                </Button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
                {loading ? (
                    <p className="py-6 text-center text-sm text-white/50">
                        Loading next messages…
                    </p>
                ) : null}
                {error ? (
                    <p className="pb-3 text-sm text-red-300">{error}</p>
                ) : null}
                {!loading && messages.length === 0 && !nextVideo ? (
                    <p className="text-sm text-white/45">
                        No messages after this.
                    </p>
                ) : null}
                <ul className="space-y-4">
                    {messages.map((message) => (
                        <li key={message.id}>
                            <SenderHeading
                                message={message}
                                time={formatClockTime(message.date)}
                                size="sm"
                            />
                            {message.kind === 'audio' ||
                            message.kind === 'voice' ? (
                                <AudioClip message={message} />
                            ) : null}
                            {message.text ? (
                                <p className="mt-1.5 text-sm whitespace-pre-wrap text-white/85">
                                    {message.text}
                                </p>
                            ) : null}
                            <div className="mt-2">
                                <ReactionRow
                                    message={message}
                                    onChange={(next) =>
                                        setMessages((currentMessages) =>
                                            currentMessages.map((entry) =>
                                                entry.id === next.id
                                                    ? next
                                                    : entry,
                                            ),
                                        )
                                    }
                                />
                            </div>
                        </li>
                    ))}
                </ul>
                {hasNewer && !nextVideo ? (
                    <div className="pt-4">
                        <Button
                            variant="ghost"
                            size="sm"
                            className="w-full text-white/60 hover:bg-white/10 hover:text-white"
                            disabled={loadingNewer}
                            onClick={() => void loadMore()}
                        >
                            {loadingNewer ? 'Loading…' : 'Load more'}
                        </Button>
                    </div>
                ) : null}
            </div>
        </aside>
    );
}

function mergeMessages(left: ThreadMessage[], right: ThreadMessage[]) {
    const map = new Map<number, ThreadMessage>();
    for (const message of left) map.set(message.id, message);
    for (const message of right) map.set(message.id, message);
    return [...map.values()].sort((a, b) => a.id - b.id);
}

/**
 * The reactions on a message, and the ones this chat will take.
 *
 * The row used to be six emoji typed into this file, which is two bugs at
 * once: a chat that only allows a hand-picked set (or none at all) still got
 * the full six, and the heart was written `❤️` where Telegram's own list says
 * `❤` — a button that answered REACTION_INVALID and, because the failure was
 * swallowed, looked like a heart that simply did nothing.
 *
 * So the list comes from the chat (`loadChatReactions`), the spelling is
 * Telegram's own, and a refusal is now said out loud.
 */
function ReactionRow({
    message,
    onChange,
    explainEmpty = false,
}: {
    message: ThreadMessage;
    onChange: (next: ThreadMessage) => void;
    /** Say why the row is empty, for the one place that has room for a line. */
    explainEmpty?: boolean;
}) {
    const [pending, setPending] = useState<string | null>(null);
    /** Null until the chat has answered — the fallback set stands in. */
    const [allowed, setAllowed] = useState<string[] | null>(null);

    useEffect(() => {
        let live = true;
        setAllowed(null);

        void import('@/lib/telegram/thread')
            .then((mod) => mod.loadChatReactions(message.chatId))
            .then((set) => {
                if (live) setAllowed(set.emojis);
            })
            .catch(() => undefined);

        return () => {
            live = false;
        };
    }, [message.chatId]);

    const row = buildReactionRow(message.reactions, allowed);

    async function toggle(emoji: string) {
        if (pending) return;
        setPending(emoji);

        try {
            const { sendThreadReaction } = await import(
                '@/lib/telegram/thread'
            );
            onChange(await sendThreadReaction(message, emoji));
        } catch (caught) {
            const { describeTelegramError } = await import(
                '@/lib/telegram/errors'
            );
            debug('viewer', 'reaction failed', caught);
            toast.error(describeTelegramError(caught));
        } finally {
            setPending(null);
        }
    }

    if (row.length === 0) {
        return explainEmpty && allowed !== null ? (
            <p className="text-xs text-white/40">
                Reactions are switched off in this chat.
            </p>
        ) : null;
    }

    return (
        <div className="flex flex-wrap gap-1">
            {row.map((item) => (
                <button
                    key={item.emoji}
                    type="button"
                    disabled={pending !== null || !item.sendable}
                    onClick={() => void toggle(item.emoji)}
                    className={
                        item.chosen
                            ? 'inline-flex items-center gap-1 rounded-full bg-white/20 px-2 py-0.5 text-sm text-white disabled:opacity-70'
                            : 'inline-flex items-center gap-1 rounded-full bg-white/10 px-2 py-0.5 text-sm text-white/80 hover:bg-white/15 disabled:hover:bg-white/10'
                    }
                    aria-pressed={item.chosen}
                    aria-label={
                        item.sendable
                            ? `React with ${item.emoji}`
                            : `${item.emoji}, which this chat no longer takes`
                    }
                    title={
                        item.sendable
                            ? undefined
                            : 'This chat no longer takes that reaction.'
                    }
                >
                    <span>{displayReaction(item.emoji)}</span>
                    {item.count > 0 ? (
                        <span className="text-xs text-white/60 tabular-nums">
                            {item.count}
                        </span>
                    ) : null}
                </button>
            ))}
        </div>
    );
}

function SenderHeading({
    message,
    time,
    exactTime,
    size,
}: {
    message: ThreadMessage;
    time: string;
    /** Full timestamp, shown on hover when `time` is a relative age. */
    exactTime?: string;
    size: 'sm' | 'lg';
}) {
    const handle = message.senderUsername ? `@${message.senderUsername}` : null;
    return (
        <div className="flex gap-3">
            <SenderAvatar
                message={message}
                size={size === 'lg' ? 40 : 32}
                className="bg-white/10 text-white/70"
            />
            <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                    <p
                        className={
                            size === 'lg'
                                ? 'min-w-0 truncate text-sm font-medium text-white'
                                : 'min-w-0 truncate text-sm font-medium text-white/90'
                        }
                    >
                        {message.senderName || 'Unknown'}
                    </p>
                    <p
                        className="shrink-0 text-xs text-white/50 tabular-nums"
                        title={exactTime}
                    >
                        {time}
                    </p>
                </div>
                {handle ? (
                    <p className="truncate text-xs text-white/50">{handle}</p>
                ) : null}
            </div>
        </div>
    );
}

function AudioClip({ message }: { message: ThreadMessage }) {
    const audioRef = useRef<HTMLAudioElement>(null);
    const [src, setSrc] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [playing, setPlaying] = useState(false);
    const [failed, setFailed] = useState<string | null>(null);
    const [elapsed, setElapsed] = useState(0);
    const [duration, setDuration] = useState(message.duration ?? 0);

    function syncFromAudio(node: HTMLAudioElement) {
        setElapsed(node.currentTime);
        if (Number.isFinite(node.duration) && node.duration > 0) {
            setDuration(node.duration);
        }
    }

    async function toggle() {
        if (src && audioRef.current) {
            if (playing) audioRef.current.pause();
            else {
                pauseOthers(audioRef.current);
                await audioRef.current.play().catch(() => undefined);
            }
            return;
        }
        setBusy(true);
        setFailed(null);
        try {
            const { downloadThreadAudio } = await import(
                '@/lib/telegram/thread'
            );
            const url = await downloadThreadAudio(
                message.chatId,
                message.id,
                message.mimeType,
            );
            setSrc(url);
            requestAnimationFrame(() => {
                const node = audioRef.current;
                if (!node) return;
                pauseOthers(node);
                void node.play().catch(() => undefined);
            });
        } catch (caught) {
            setFailed(
                caught instanceof Error
                    ? caught.message
                    : 'Could not play this audio.',
            );
        } finally {
            setBusy(false);
        }
    }

    function seek(value: number) {
        const node = audioRef.current;
        if (!node || !Number.isFinite(value)) return;
        node.currentTime = value;
        setElapsed(value);
    }

    const title = message.audioTitle || message.fileName;
    const total = duration > 0 ? duration : (message.duration ?? 0);
    const progress = total > 0 ? Math.min(1, elapsed / total) : 0;

    return (
        <div className="mt-2">
            {title ? (
                <p className="mb-1 truncate text-xs text-white/55">
                    {[title, message.audioPerformer]
                        .filter(Boolean)
                        .join(' · ')}
                </p>
            ) : null}
            <div className="flex items-center gap-2.5">
                <button
                    type="button"
                    onClick={() => void toggle()}
                    className="grid size-8 shrink-0 place-items-center rounded-full bg-white text-black hover:bg-white/90"
                    aria-label={playing ? 'Pause' : 'Play'}
                >
                    {busy ? (
                        <LoaderCircle className="size-3.5 animate-spin" />
                    ) : playing ? (
                        <Pause className="size-3.5 fill-current" />
                    ) : (
                        <Play className="size-3.5 fill-current" />
                    )}
                </button>
                <label className="flex min-w-0 flex-1 items-center">
                    <span className="sr-only">Seek</span>
                    <input
                        type="range"
                        min={0}
                        max={Math.max(total, 0.01)}
                        step={0.1}
                        value={Math.min(elapsed, total)}
                        disabled={!src}
                        onChange={(event) => seek(Number(event.target.value))}
                        className="audio-seek w-full cursor-pointer disabled:cursor-default"
                        style={{
                            background: `linear-gradient(to right, #fff ${progress * 100}%, rgb(255 255 255 / 0.2) ${progress * 100}%)`,
                        }}
                    />
                </label>
                <p className="shrink-0 text-[11px] text-white/55 tabular-nums">
                    {formatDuration(elapsed)}
                    <span className="text-white/30"> / </span>
                    {formatDuration(total)}
                </p>
            </div>
            {failed ? (
                <p className="mt-1 text-xs text-red-300">{failed}</p>
            ) : null}
            {src ? (
                <audio
                    ref={audioRef}
                    src={src}
                    className="sr-only"
                    onPlay={() => setPlaying(true)}
                    onPause={() => setPlaying(false)}
                    onEnded={() => {
                        setPlaying(false);
                        setElapsed(total);
                    }}
                    onTimeUpdate={(event) => syncFromAudio(event.currentTarget)}
                    onLoadedMetadata={(event) =>
                        syncFromAudio(event.currentTarget)
                    }
                    onDurationChange={(event) =>
                        syncFromAudio(event.currentTarget)
                    }
                >
                    <track kind="captions" label="None" srcLang="und" />
                </audio>
            ) : null}
        </div>
    );
}

function pauseOthers(current: HTMLAudioElement) {
    for (const node of document.querySelectorAll('audio')) {
        if (node !== current) node.pause();
    }
}
