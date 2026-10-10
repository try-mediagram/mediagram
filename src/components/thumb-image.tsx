import {
    Bookmark,
    Check,
    Eye,
    Film,
    Heart,
    Image,
    Lock,
    Mic,
    Music,
    Play,
    Tag,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { formatDuration } from '@/lib/format';
import type { MediaItem } from '@/lib/telegram/types';
import { cn } from '@/lib/utils';
import type { MediaItemTag } from '@/types/tags';

export function ThumbImage({
    item,
    onOpen,
    tags = [],
    seen = false,
    blurred = false,
    selecting = false,
    selected = false,
    onToggleSelect,
}: {
    item: MediaItem;
    onOpen: () => void;
    /**
     * The tags on this item, the reader's own and any public ones. A count only
     * — the list is in the viewer.
     */
    tags?: MediaItemTag[];
    /** This account has already opened it in the viewer. */
    seen?: boolean;
    /** Sender-marked spoiler this account may not reveal. */
    blurred?: boolean;
    /** The grid is picking items to act on, so a click chooses rather than opens. */
    selecting?: boolean;
    selected?: boolean;
    /** `shift` is true when the reader held it, asking for a range. */
    onToggleSelect?: (shift: boolean) => void;
}) {
    const isSound = item.type === 'audio' || item.type === 'voice';
    const favorite = tags.some((tag) => tag.name === 'favorite');
    const bookmarked = tags.some((tag) => tag.name === 'bookmark');
    const otherTags = tags.length - Number(favorite) - Number(bookmarked);
    const ref = useRef<HTMLButtonElement>(null);
    const [src, setSrc] = useState<string | null>(null);
    // Telegram's inline preview: blurred, but there before any download.
    const [preview, setPreview] = useState<string | null>(null);
    const [visible, setVisible] = useState(false);
    // What the file said about itself when Telegram would not. Only ever set
    // for a video whose uploader filled in neither a thumbnail nor a duration.
    const [decodedDuration, setDecodedDuration] = useState<number | null>(null);

    useEffect(() => {
        const node = ref.current;
        if (!node) return;
        const observer = new IntersectionObserver(
            // Both ways: a tile that scrolls out before its download starts
            // gives its place in the queue to the ones now on screen.
            ([entry]) => setVisible(entry?.isIntersecting ?? false),
            { rootMargin: '240px' },
        );
        observer.observe(node);
        return () => observer.disconnect();
    }, []);

    useEffect(() => {
        if (!visible || src) return;
        let live = true;
        const abort = new AbortController();

        void (async () => {
            const media = await import('@/lib/telegram/media');
            if (!live) return;
            if (!isSound) setPreview(media.inlinePreview(item));
            // Voice notes carry no thumbnail and much music carries none
            // either; the chat avatar stands in so the tile is not a wall
            // of identical glyphs.
            const published = isSound
                ? await media.downloadSoundArt(item, abort.signal)
                : await media.downloadThumb(item, abort.signal);
            if (!live) return;
            if (published) {
                setSrc(published);
                return;
            }

            // Telegram published no preview for this file, which for a video
            // means the uploader attached none — there is no second copy to
            // ask for. The file itself still knows, so it is decoded off the
            // progressive bridge rather than leaving a blank square.
            if (item.type !== 'video' && item.type !== 'gif') return;
            const { generatePoster } = await import('@/lib/telegram/poster');
            const poster = await generatePoster(item);
            if (!live) return;
            setSrc(poster.url);
            setDecodedDuration(poster.duration);
        })();

        return () => {
            live = false;
            abort.abort();
        };
    }, [isSound, item, visible, src]);

    // A video that stays on screen gets its first megabyte, in the background,
    // so even one never hovered opens onto bytes already here. Only the head:
    // a trailing index waits for a hover, and a scroll past costs nothing.
    useEffect(() => {
        if (!visible || (item.type !== 'video' && item.type !== 'gif')) return;
        const timer = setTimeout(() => {
            void import('@/lib/telegram/progressive').then((mod) =>
                mod.warmProgressiveStream(item, { tail: false }),
            );
        }, VISIBLE_WARM_MS);
        return () => clearTimeout(timer);
    }, [item, visible]);

    // The document's own duration wins; the decoded one only fills a zero.
    const duration = item.duration ?? decodedDuration ?? undefined;

    const warm = useWarmOnDwell(item);

    return (
        <button
            ref={ref}
            type="button"
            // While selecting, the tile is a checkbox rather than a link: the
            // whole thumbnail is the hit area, because a 16px tick in the
            // corner of a grid is a target nobody can hit on a phone.
            aria-pressed={selecting ? selected : undefined}
            onPointerEnter={selecting ? undefined : warm.start}
            onPointerLeave={warm.cancel}
            onPointerDown={selecting ? undefined : warm.now}
            onFocus={selecting ? undefined : warm.start}
            onClick={(event) =>
                selecting ? onToggleSelect?.(event.shiftKey) : onOpen()
            }
            className={cn(
                'group bg-secondary/70 focus-visible:ring-ring/70 relative aspect-square overflow-hidden rounded-lg transition-[transform,box-shadow] duration-150 ease-out outline-none hover:shadow-md focus-visible:ring-2',
                selecting && selected && 'ring-brand ring-2',
            )}
        >
            {/*
                Every kind gets a face when Telegram published no preview for
                it. A video whose uploader never attached a thumbnail used to
                leave a plain grey square, which reads as a tile still loading
                rather than one that has nothing to show.
            */}
            {!src && preview ? (
                <img
                    src={preview}
                    alt=""
                    aria-hidden="true"
                    className={cn(
                        'absolute inset-0 size-full scale-110 object-cover blur-md',
                        blurred && 'blur-xl saturate-50',
                    )}
                />
            ) : null}
            {!src && !preview ? (
                <span className="from-primary/25 to-secondary/60 absolute inset-0 grid place-items-center bg-gradient-to-br">
                    {item.type === 'voice' ? (
                        <Mic className="text-foreground/50 size-8" />
                    ) : item.type === 'audio' ? (
                        <Music className="text-foreground/50 size-8" />
                    ) : item.type === 'photo' ? (
                        <Image className="text-foreground/50 size-8" />
                    ) : (
                        <Film className="text-foreground/50 size-8" />
                    )}
                </span>
            ) : null}
            {src ? (
                <img
                    src={src}
                    alt={blurred ? '' : item.caption || item.type}
                    loading="lazy"
                    decoding="async"
                    className={cn(
                        'size-full object-cover transition-transform duration-200 ease-out group-hover:scale-[1.03]',
                        blurred && 'scale-110 blur-xl saturate-50',
                    )}
                />
            ) : (
                <div className="bg-secondary/50 size-full" />
            )}
            {blurred ? (
                <span className="bg-background/30 absolute inset-0 grid place-items-center">
                    <Lock className="text-foreground/80 size-4" />
                </span>
            ) : null}
            {isSound ? (
                <span className="absolute inset-x-1.5 bottom-1.5 flex items-center justify-between gap-1 rounded-md bg-black/70 px-1.5 py-0.5 text-left text-[11px] font-medium text-white">
                    <span className="truncate">
                        {item.audioTitle ??
                            item.fileName ??
                            (item.type === 'voice' ? 'Voice' : 'Audio')}
                    </span>
                    {duration ? (
                        <span className="shrink-0 tabular-nums">
                            {formatDuration(duration)}
                        </span>
                    ) : null}
                </span>
            ) : null}
            {selecting ? (
                <>
                    {selected ? (
                        <span className="bg-brand/25 absolute inset-0" />
                    ) : null}
                    <span
                        className={cn(
                            'absolute top-2 left-2 grid size-5 place-items-center rounded-full border-2 transition-colors',
                            selected
                                ? 'border-brand bg-brand text-white'
                                : 'border-white/80 bg-black/40',
                        )}
                    >
                        {selected ? <Check className="size-3" /> : null}
                    </span>
                </>
            ) : null}
            {seen && !selecting ? (
                <span
                    className="absolute top-2 left-2 grid size-5 place-items-center rounded-full bg-black/70 text-white"
                    title="Already seen"
                >
                    <Eye className="size-3" />
                    <span className="sr-only">Already seen</span>
                </span>
            ) : null}
            {tags.length > 0 ? (
                <span
                    className="absolute top-2 right-2 inline-flex items-center gap-1 rounded-md bg-black/70 px-1.5 py-0.5 text-[11px] font-medium text-white tabular-nums"
                    title={tags.map((tag) => tag.name).join(', ')}
                >
                    {/* The built-ins show as themselves; the count is the rest. */}
                    {favorite ? (
                        <Heart className="size-3 fill-current text-rose-500" />
                    ) : null}
                    {bookmarked ? (
                        <Bookmark className="size-3 fill-current text-amber-400" />
                    ) : null}
                    {otherTags > 0 ? (
                        <>
                            <Tag className="size-3" />
                            {otherTags}
                        </>
                    ) : null}
                    <span className="sr-only">
                        Tagged {tags.map((tag) => tag.name).join(', ')}
                    </span>
                </span>
            ) : null}
            {item.type !== 'photo' && !isSound ? (
                <span className="absolute bottom-2 left-2 inline-flex items-center gap-1 rounded-md bg-black/70 px-1.5 py-0.5 text-[11px] font-medium text-white tabular-nums">
                    <Play className="size-3 fill-current" />
                    {duration
                        ? formatDuration(duration)
                        : item.type === 'gif'
                          ? 'GIF'
                          : 'Video'}
                </span>
            ) : null}
        </button>
    );
}

/** How long a video tile stays on screen before its head starts loading. */
const VISIBLE_WARM_MS = 600;

/** How long the pointer rests on a tile before its stream starts loading. */
const WARM_DWELL_MS = 120;

/**
 * Start a video's first bytes downloading once the pointer settles on its
 * tile, so the click opens a player that already has them. The short dwell
 * keeps a sweep across the grid from pulling a megabyte per tile passed over.
 */
function useWarmOnDwell(item: MediaItem) {
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(
        () => () => {
            if (timer.current) clearTimeout(timer.current);
        },
        [],
    );

    const cancel = () => {
        if (timer.current) clearTimeout(timer.current);
        timer.current = null;
    };

    const start = () => {
        if (item.type === 'photo' || timer.current) return;
        timer.current = setTimeout(() => {
            timer.current = null;
            void import('@/lib/telegram/progressive').then((mod) =>
                mod.warmProgressiveStream(item),
            );
        }, WARM_DWELL_MS);
    };

    // Pressing is a decision already: the click only fires on release, so
    // starting here wins that much back, and at the player's own priority.
    const now = () => {
        if (item.type === 'photo') return;
        cancel();
        void import('@/lib/telegram/progressive').then((mod) =>
            mod.warmProgressiveStream(item, { urgent: true }),
        );
    };

    return { start, cancel, now };
}
