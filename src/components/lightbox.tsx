import {
    ChevronLeft,
    ChevronRight,
    LoaderCircle,
    MessageSquareText,
    X,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { DownloadButton } from '@/components/download-button';
import { MediaPlayer, type PlaybackHandoff } from '@/components/media-player';
import { MediaThread } from '@/components/media-thread';
import { TagBar } from '@/components/tag-bar';
import { Button } from '@/components/ui/button';
import {
    Sheet,
    SheetContent,
    SheetDescription,
    SheetTitle,
} from '@/components/ui/sheet';
import { useMediaQuery } from '@/hooks/use-media-query';
import { useMouseBackToClose } from '@/hooks/use-mouse-navigation';
import { debug } from '@/lib/debug';
import { formatRelativeDateTime } from '@/lib/format';
import { closePip, getPip, openPip } from '@/lib/pip';
import { markMediaSeen } from '@/lib/seen-media';
import type { MediaItem } from '@/lib/telegram/types';
import { cn } from '@/lib/utils';
import type { MediaItemTag } from '@/types/tags';

/** Where the thread stops being a drawer and becomes the pane beside the media. */
const THREAD_PANE_QUERY = '(min-width: 1024px)';

export function Lightbox({
    item,
    tags,
    onTagsChange,
    index,
    total,
    hasMore,
    loadingMore,
    onClose,
    onPrev,
    onNext,
    initial,
}: {
    item: MediaItem;
    /** The account's tags on this item. */
    tags: MediaItemTag[];
    /** A tag was added or removed; the chat's tag map is stale. */
    onTagsChange: () => void;
    index: number;
    /** How many items are loaded — not how many the chat holds. */
    total: number;
    /** Another page can still be fetched, so the end of `total` is not the end. */
    hasMore: boolean;
    /** That page is on its way; Next is waiting on it rather than refusing. */
    loadingMore: boolean;
    onClose: () => void;
    onPrev: () => void;
    onNext: () => void;
    /** Pick the video up where the corner player left it. */
    initial?: PlaybackHandoff;
}) {
    const [src, setSrc] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [downloading, setDownloading] = useState(false);
    const [threadOpen, setThreadOpen] = useState(false);
    const [pickerOpen, setPickerOpen] = useState(false);

    /*
     * From `lg` up the thread is a column beside the media; below it the media
     * gets the whole screen and the thread waits in a drawer. Decided in JS
     * rather than with `lg:hidden` because only one of the two may exist: the
     * pane fetches the thread from Telegram the moment it mounts.
     */
    const threadBesideMedia = useMediaQuery(THREAD_PANE_QUERY);

    const isPhoto = item.type === 'photo';

    // Only the last loaded item can be waiting on a fetch, and Next stays live
    // there as long as another page exists: running out of loaded media is not
    // running out of media.
    const atLoadedEnd = index >= total - 1;
    const waitingForMore = atLoadedEnd && loadingMore;

    /** The drawer belongs to the narrow layout; widening the window ends it. */
    useEffect(() => {
        if (threadBesideMedia) setThreadOpen(false);
    }, [threadBesideMedia]);

    // A video opened here takes over from the corner player: two soundtracks
    // at once is nobody's intent. Photos leave it playing.
    useEffect(() => {
        if (item.type !== 'photo' && getPip()) closePip();
    }, [item]);

    // Opening an item is seeing it, from the grid or from the chat alike.
    useEffect(() => {
        void markMediaSeen(item.chatId, item.messageId);
    }, [item.chatId, item.messageId]);

    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            // The tag picker has the keyboard while it is up: its Escape
            // closes it, and its arrows move through the list.
            if (pickerOpen) return;
            // Escape dismisses the drawer first — the sheet closes itself, and
            // taking the viewer down with it would lose the reader's place.
            if (event.key === 'Escape' && !threadOpen) onClose();
            if (event.key === 'ArrowLeft') onPrev();
            if (event.key === 'ArrowRight') onNext();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose, onNext, onPrev, pickerOpen, threadOpen]);

    // Mouse back steps out one layer at a time, like Escape: the drawer, then
    // the viewer — never the page underneath it.
    const back = useCallback(() => {
        if (pickerOpen) setPickerOpen(false);
        else if (threadOpen) setThreadOpen(false);
        else onClose();
    }, [onClose, pickerOpen, threadOpen]);
    useMouseBackToClose(back);

    // The photo comes in at the size the window can show, not as the original:
    // a 2560px upload in a laptop window is several times the bytes of the
    // 1280px rendition Telegram already stores. The original is still what
    // the download button saves.
    const box = useViewportBox();
    const shown = useRef<{ key: string; qualityId: string } | null>(null);

    useEffect(() => {
        if (!isPhoto) return;
        let live = true;
        const abort = new AbortController();
        void import('@/lib/telegram/media')
            .then((mod) => {
                const quality = mod.photoQualityFor(
                    item,
                    box.width,
                    box.height,
                );
                const current = shown.current;
                if (
                    current?.key === item.key &&
                    current.qualityId === quality.id
                ) {
                    return null;
                }
                // A new photo starts from its preview; a bigger size of the
                // same photo keeps the one on screen until it lands.
                if (current?.key !== item.key) {
                    setSrc(null);
                    setError(null);
                }
                debug('photo', 'size for window', {
                    key: item.key,
                    quality: quality.label,
                    box: `${box.width}x${box.height}`,
                    original: `${item.width}x${item.height}`,
                    bytes: quality.fileSize ?? null,
                    originalBytes:
                        item.quality.fileSize ?? item.fileSize ?? null,
                });
                return mod
                    .downloadQuality(item, quality.id, undefined, abort.signal)
                    .then((url) => ({ url, qualityId: quality.id }));
            })
            .then((loaded) => {
                if (!live || !loaded) return;
                // Marked only once it is here, so a download a resize
                // aborted is asked for again rather than skipped.
                shown.current = { key: item.key, qualityId: loaded.qualityId };
                setSrc(loaded.url);
            })
            .catch((caught: unknown) => {
                if (!live) return;
                shown.current = null;
                setError(
                    caught instanceof Error
                        ? caught.message
                        : 'Could not load this photo.',
                );
            });
        return () => {
            live = false;
            abort.abort();
        };
    }, [item, isPhoto, box.width, box.height]);

    // Always allowed, including from chats that restrict saving.
    const download = useCallback(async () => {
        setDownloading(true);
        try {
            const { downloadQuality } = await import('@/lib/telegram/media');
            const url = await downloadQuality(item, item.quality.id);
            const link = document.createElement('a');
            link.href = url;
            link.download =
                item.fileName ||
                `${item.type}-${item.messageId}-${item.quality.label}`;
            link.click();
        } catch (caught) {
            // A toast rather than the inline error: the media is still on
            // screen and perfectly viewable.
            toast.error(
                caught instanceof Error ? caught.message : 'Download failed.',
            );
        } finally {
            setDownloading(false);
        }
    }, [item]);

    const caption = item.caption?.trim();

    return (
        // From `lg` up the thread runs the full height of the viewer, so the
        // close button sits in the media column's own bar rather than a header
        // spanning both, and the counter lives in the thread under its heading.
        // Below `lg` the media has the screen to itself and that bar becomes a
        // real header: it carries the counter and opens the thread's drawer.
        <div
            className="fixed inset-0 z-50 flex flex-col bg-black/95 lg:flex-row"
            role="dialog"
            aria-modal="true"
        >
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                <div className="flex shrink-0 items-center gap-1 px-2 py-2 lg:px-3">
                    <Button
                        variant="ghost"
                        size="icon"
                        className="shrink-0 text-white hover:bg-white/10"
                        onClick={onClose}
                        aria-label="Close"
                    >
                        <X />
                    </Button>

                    {!threadBesideMedia ? (
                        <>
                            {/*
                                The whole strip opens the drawer, not just the
                                button beside it: the caption is the thread's
                                own opening line, and a reader who taps the
                                words wants the rest of them.
                            */}
                            <button
                                type="button"
                                onClick={() => setThreadOpen(true)}
                                className="flex min-w-0 flex-1 flex-col items-start rounded-md px-2 py-1 text-left hover:bg-white/10"
                            >
                                <span className="w-full truncate text-sm text-white/90">
                                    {caption || 'Open the conversation'}
                                </span>
                                <span className="text-[11px] text-white/50">
                                    <span className="tabular-nums">
                                        {index + 1} / {total}
                                    </span>
                                    <span className="px-1">·</span>
                                    {formatRelativeDateTime(item.date)}
                                </span>
                            </button>

                            <Button
                                variant="ghost"
                                size="sm"
                                className="shrink-0 text-white hover:bg-white/10"
                                onClick={() => setThreadOpen(true)}
                            >
                                <MessageSquareText />
                                Chat
                            </Button>
                        </>
                    ) : null}
                </div>

                <div className="relative flex min-h-0 min-w-0 flex-1 items-center justify-center px-2 pb-4 sm:px-12">
                    <Button
                        variant="ghost"
                        size="icon-lg"
                        className="absolute left-1 z-10 bg-black/40 text-white backdrop-blur-sm hover:bg-white/20 sm:left-2 sm:bg-transparent sm:backdrop-blur-none"
                        onClick={onPrev}
                        disabled={index === 0}
                        aria-label="Previous"
                    >
                        <ChevronLeft />
                    </Button>

                    <div className="flex h-full w-full max-w-5xl items-center justify-center">
                        {error ? (
                            <p className="text-sm text-red-300">{error}</p>
                        ) : null}

                        {isPhoto ? (
                            <PhotoView
                                item={item}
                                src={src}
                                error={error}
                                downloading={downloading}
                                onDownload={() => void download()}
                            />
                        ) : (
                            <MediaPlayer
                                item={item}
                                onError={setError}
                                initial={initial}
                                download={{
                                    busy: downloading,
                                    onDownload: () => void download(),
                                }}
                                onPictureInPicture={(handoff) => {
                                    openPip({ item, ...handoff });
                                    onClose();
                                }}
                            />
                        )}
                    </div>

                    <Button
                        variant="ghost"
                        size="icon-lg"
                        className="absolute right-1 z-10 bg-black/40 text-white backdrop-blur-sm hover:bg-white/20 sm:right-2 sm:bg-transparent sm:backdrop-blur-none"
                        onClick={onNext}
                        disabled={atLoadedEnd && !hasMore}
                        aria-label="Next"
                    >
                        {waitingForMore ? (
                            <LoaderCircle className="animate-spin" />
                        ) : (
                            <ChevronRight />
                        )}
                    </Button>
                </div>

                <TagBar
                    item={item}
                    tags={tags}
                    onChange={onTagsChange}
                    pickerOpen={pickerOpen}
                    onPickerOpenChange={setPickerOpen}
                />
            </div>

            {threadBesideMedia ? (
                <MediaThread
                    item={item}
                    index={index}
                    total={total}
                    hasMore={hasMore}
                    loadingMore={loadingMore}
                    onPrev={onPrev}
                    onNext={onNext}
                    className="h-auto w-80 border-l border-white/10"
                />
            ) : (
                /*
                    Bottom, and black: it reads as the conversation rising over
                    the media it belongs to, and the pane's text is white — a
                    drawer in the app's own `bg-popover` would print white on
                    near-white. The sheet's stock close button is themed for
                    that background too, hence our own in the bar below.
                */
                <Sheet open={threadOpen} onOpenChange={setThreadOpen}>
                    <SheetContent
                        side="bottom"
                        className="h-[80dvh] gap-0 border-white/10 bg-black p-0 text-white"
                        showCloseButton={false}
                    >
                        <div className="flex shrink-0 items-center justify-between border-b border-white/10 px-3 py-2">
                            <SheetTitle className="text-sm text-white">
                                Conversation
                            </SheetTitle>
                            <SheetDescription className="sr-only">
                                The messages around this media, and the
                                reactions on them
                            </SheetDescription>
                            <Button
                                variant="ghost"
                                size="icon-sm"
                                className="text-white hover:bg-white/10"
                                onClick={() => setThreadOpen(false)}
                                aria-label="Close the conversation"
                            >
                                <X />
                            </Button>
                        </div>
                        <MediaThread
                            item={item}
                            index={index}
                            total={total}
                            hasMore={hasMore}
                            loadingMore={loadingMore}
                            onPrev={onPrev}
                            onNext={onNext}
                            className="min-h-0 flex-1"
                        />
                    </SheetContent>
                </Sheet>
            )}
        </div>
    );
}

/**
 * A photo has no player to hang the controls off, so the download sits in a
 * small bar that floats over the top right corner of the image.
 *
 * Top right rather than bottom centre: the bottom of the media column is where
 * TagBar sits, and a floating pill centred over it landed on top of the tags —
 * two controls in one place, one of them half covered.
 */
function PhotoView({
    item,
    src,
    error,
    downloading,
    onDownload,
}: {
    item: MediaItem;
    src: string | null;
    error: string | null;
    downloading: boolean;
    onDownload: () => void;
}) {
    // The grid's tile for this photo, almost always already in memory or on
    // disk, held up at full size while the original downloads. The original
    // can be several MB; this is what stops the viewer opening on a spinner.
    const [preview, setPreview] = useState<string | null>(null);
    useEffect(() => {
        let live = true;
        setPreview(null);
        void import('@/lib/telegram/media')
            .then((mod) => mod.downloadThumb(item))
            .then((url) => {
                if (live && url) setPreview(url);
            })
            .catch(() => undefined);
        return () => {
            live = false;
        };
    }, [item]);

    return (
        <div className="group/photo relative flex h-full w-full items-center justify-center">
            {src ? (
                <img
                    src={src}
                    alt={item.caption || 'Photo'}
                    decoding="async"
                    className="max-h-full max-w-full object-contain"
                />
            ) : null}
            {!src && preview ? (
                <img
                    src={preview}
                    alt=""
                    aria-hidden="true"
                    width={item.width || undefined}
                    height={item.height || undefined}
                    className="max-h-full max-w-full object-contain blur-[2px]"
                />
            ) : null}
            {!src && !error ? (
                <span
                    className={cn(
                        'size-10 animate-spin rounded-full border-2 border-white/25 border-t-white/90',
                        preview && 'absolute',
                    )}
                />
            ) : null}

            {src ? (
                <div className="absolute top-3 right-3 rounded-full bg-black/70 px-1 py-0.5 backdrop-blur-sm">
                    <DownloadButton
                        busy={downloading}
                        fileSize={item.fileSize}
                        onDownload={onDownload}
                    />
                </div>
            ) : null}
        </div>
    );
}

function measureViewport() {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    return {
        width: Math.round(window.innerWidth * ratio),
        height: Math.round(window.innerHeight * ratio),
    };
}

/**
 * The window in device pixels, for choosing a photo's size. Follows resizes,
 * settled for a moment so a drag does not ask for every size on the way.
 * The pixel ratio is capped at 2: past that the extra detail is not visible
 * at viewing distance, and the bytes are.
 */
function useViewportBox() {
    const [box, setBox] = useState(measureViewport);

    useEffect(() => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const onResize = () => {
            clearTimeout(timer);
            timer = setTimeout(() => setBox(measureViewport()), 250);
        };
        window.addEventListener('resize', onResize);
        return () => {
            clearTimeout(timer);
            window.removeEventListener('resize', onResize);
        };
    }, []);

    return box;
}
