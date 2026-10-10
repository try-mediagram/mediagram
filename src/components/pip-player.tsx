import { useQuery } from '@tanstack/react-query';
import { GripHorizontal, X } from 'lucide-react';
import {
    type PointerEvent as ReactPointerEvent,
    useCallback,
    useEffect,
    useRef,
    useState,
} from 'react';

import { Lightbox } from '@/components/lightbox';
import { MediaPlayer } from '@/components/media-player';
import { fetchTagsOn } from '@/lib/media-tags';
import { closePip, type PipState, usePip } from '@/lib/pip';
import { cn } from '@/lib/utils';
import type { MediaItemTag } from '@/types/tags';

type Corner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

const CORNER_KEY = 'mediagram:pip-corner';

/** Kept off the window's edges, and clear of the sticky filter bar on top. */
const CORNER_CLASS: Record<Corner, string> = {
    'top-left': 'top-20 left-4',
    'top-right': 'top-20 right-4',
    'bottom-left': 'bottom-4 left-4',
    'bottom-right': 'bottom-4 right-4',
};

function readCorner(): Corner {
    try {
        const saved = window.localStorage.getItem(CORNER_KEY);
        if (saved && saved in CORNER_CLASS) return saved as Corner;
    } catch {
        // Blocked storage: the default corner is fine.
    }
    return 'bottom-right';
}

function saveCorner(corner: Corner) {
    try {
        window.localStorage.setItem(CORNER_KEY, corner);
    } catch {
        // A convenience only.
    }
}

/**
 * The in-app picture in picture: a small player pinned to a corner of the
 * window, above every page, that keeps playing while the app is browsed.
 *
 * Mounted once by the app shell. Drag it by its top bar; let go and it settles
 * into the nearest corner, which is remembered. The video itself still plays
 * and pauses on click, the same as in the viewer.
 */
export function PipPlayer() {
    const pip = usePip();
    const [corner, setCorner] = useState<Corner>(readCorner);
    const [error, setError] = useState<string | null>(null);
    const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
    const start = useRef<{ x: number; y: number } | null>(null);
    const boxRef = useRef<HTMLElement>(null);
    // The full viewer, reopened from the corner. It lives here rather than
    // with the page the video came from, so going back works from anywhere.
    const [viewer, setViewer] = useState<PipState | null>(null);

    const viewerTags = useQuery({
        queryKey: [
            'media-tags',
            viewer?.item.chatId,
            'on',
            [viewer?.item.messageId],
        ],
        enabled: viewer !== null,
        queryFn: () =>
            viewer
                ? fetchTagsOn(viewer.item.chatId, [viewer.item.messageId])
                : Promise.resolve<Record<string, MediaItemTag[]>>({}),
    });

    const viewerNode = viewer ? (
        <Lightbox
            item={viewer.item}
            tags={viewerTags.data?.[String(viewer.item.messageId)] ?? []}
            onTagsChange={() => void viewerTags.refetch()}
            index={0}
            total={1}
            hasMore={false}
            loadingMore={false}
            initial={viewer}
            onClose={() => setViewer(null)}
            onPrev={() => undefined}
            onNext={() => undefined}
        />
    ) : null;

    useEffect(() => {
        if (pip) setError(null);
    }, [pip]);

    useEffect(() => {
        if (!pip) return;
        const onKey = (event: KeyboardEvent) => {
            // Only when nothing else is asking for Escape: a viewer or dialog
            // on top owns it.
            if (event.key !== 'Escape' || event.defaultPrevented) return;
            if (document.querySelector('[role="dialog"]')) return;
            closePip();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [pip]);

    const onPointerDown = useCallback((event: ReactPointerEvent) => {
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        start.current = { x: event.clientX, y: event.clientY };
        setDrag({ x: 0, y: 0 });
    }, []);

    const onPointerMove = useCallback((event: ReactPointerEvent) => {
        if (!start.current) return;
        setDrag({
            x: event.clientX - start.current.x,
            y: event.clientY - start.current.y,
        });
    }, []);

    const onPointerUp = useCallback(() => {
        start.current = null;
        const box = boxRef.current?.getBoundingClientRect();
        setDrag(null);
        if (!box) return;
        const middleX = box.left + box.width / 2;
        const middleY = box.top + box.height / 2;
        const next: Corner = `${middleY < window.innerHeight / 2 ? 'top' : 'bottom'}-${middleX < window.innerWidth / 2 ? 'left' : 'right'}`;
        setCorner(next);
        saveCorner(next);
    }, []);

    if (!pip) return viewerNode;

    return (
        <>
            {viewerNode}
            <section
                ref={boxRef}
                aria-label="Picture in picture"
                className={cn(
                    'group/pip fixed z-[60] aspect-video w-[min(22rem,calc(100vw-2rem))] overflow-hidden rounded-lg bg-black shadow-2xl ring-1 ring-white/10',
                    CORNER_CLASS[corner],
                    drag
                        ? 'cursor-grabbing'
                        : 'transition-[top,right,bottom,left]',
                )}
                style={
                    drag
                        ? { transform: `translate(${drag.x}px, ${drag.y}px)` }
                        : undefined
                }
            >
                <MediaPlayer
                    // A new handoff is a new start: the player only reads its
                    // starting point when it mounts.
                    key={`${pip.item.key}@${pip.startAt}`}
                    item={pip.item}
                    initial={pip}
                    compact
                    onError={setError}
                    onExpand={(handoff) => {
                        setViewer({ item: pip.item, ...handoff });
                        closePip();
                    }}
                />

                {error ? (
                    <p className="absolute inset-x-0 top-1/2 -translate-y-1/2 px-4 text-center text-xs text-red-300">
                        {error}
                    </p>
                ) : null}

                <div
                    className={cn(
                        'absolute inset-x-0 top-0 flex items-center gap-1 bg-gradient-to-b from-black/80 to-transparent px-1.5 pt-1 pb-4 text-white transition-opacity duration-200',
                        drag
                            ? 'opacity-100'
                            : 'opacity-0 group-hover/pip:opacity-100 group-focus-within/pip:opacity-100',
                    )}
                >
                    <div
                        className="flex h-6 flex-1 cursor-grab touch-none items-center justify-center rounded text-white/70 hover:text-white"
                        onPointerDown={onPointerDown}
                        onPointerMove={onPointerMove}
                        onPointerUp={onPointerUp}
                        onPointerCancel={onPointerUp}
                        title="Drag to move"
                    >
                        <GripHorizontal className="size-4" />
                    </div>
                    <button
                        type="button"
                        onClick={closePip}
                        aria-label="Close picture in picture"
                        title="Close"
                        className="grid size-6 place-items-center rounded text-white/80 hover:bg-white/15 hover:text-white"
                    >
                        <X className="size-4" />
                    </button>
                </div>
            </section>
        </>
    );
}
