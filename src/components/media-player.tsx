import {
    Maximize,
    Maximize2,
    Minimize,
    Music,
    Pause,
    PictureInPicture2,
    Play,
    Volume2,
    VolumeX,
} from 'lucide-react';
import ReactPlayer from 'react-player';
import {
    type ChangeEvent,
    type ReactNode,
    type RefObject,
    useCallback,
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
} from 'react';

import { DownloadButton } from '@/components/download-button';
import { Button } from '@/components/ui/button';
import { debug } from '@/lib/debug';
import { formatDuration } from '@/lib/format';
import type { PipState } from '@/lib/pip';
import type { MediaItem } from '@/lib/telegram/types';
import { cn } from '@/lib/utils';

const RATES: number[] = [0.5, 1, 1.5, 2];

/** How long the controls linger after the pointer stops moving. */
const IDLE_MS = 2_400;

export type DownloadAction = {
    busy: boolean;
    onDownload: () => void;
};

/** Where a player picks up from: the place another player was handed over at. */
export type PlaybackHandoff = Omit<PipState, 'item'>;

/**
 * The player for everything that has a timeline: video, GIF and audio.
 *
 * Playback comes off the service worker's `/progressive/*` bridge so bytes are
 * pulled over MTProto as the user seeks, never staged on a server. react-player
 * owns the element; the controls below are ours, because native controls have
 * nowhere to put a download.
 *
 * There is nothing to choose about quality: `item.quality` is already the best
 * rendition Telegram published, and it is what plays.
 */
export function MediaPlayer({
    item,
    onError,
    download,
    initial,
    compact = false,
    onPictureInPicture,
    onExpand,
}: {
    item: MediaItem;
    onError: (message: string | null) => void;
    download?: DownloadAction;
    /** Start here rather than at the beginning, with these settings. */
    initial?: PlaybackHandoff;
    /**
     * The corner player: the same element and stream, with only the controls
     * that fit in a few hundred pixels.
     */
    compact?: boolean;
    /**
     * Hand playback to the in-app picture in picture. Without it the button
     * is not offered — the corner player has nowhere further to go.
     */
    onPictureInPicture?: (handoff: PlaybackHandoff) => void;
    /** Hand playback back to the full viewer, from the corner player. */
    onExpand?: (handoff: PlaybackHandoff) => void;
}) {
    // Voice notes are audio with no tags: same player, same title card.
    const isAudio = item.type === 'audio' || item.type === 'voice';
    const isGif = item.type === 'gif';

    const shellRef = useRef<HTMLDivElement>(null);
    const playerRef = useRef<HTMLVideoElement>(null);
    const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    // When this item was asked for, until its first frame is on screen: the
    // number the warming in progressive.ts exists to bring down.
    const openedAt = useRef<number | null>(null);

    const [src, setSrc] = useState<string | null>(null);
    const [poster, setPoster] = useState<string | null>(null);
    const [status, setStatus] = useState('Opening stream…');
    const [playing, setPlaying] = useState(false);
    const [waiting, setWaiting] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(item.duration ?? 0);
    const [buffered, setBuffered] = useState(0);
    const [volume, setVolume] = useState(initial?.volume ?? 1);
    const [muted, setMuted] = useState(initial?.muted ?? isGif);
    const [rate, setRate] = useState<number>(initial?.rate ?? 1);
    // Applied once, when the new element knows its length; seeking any
    // earlier is ignored by the browser.
    const pendingStart = useRef(initial?.startAt ?? 0);
    const [fullscreen, setFullscreen] = useState(false);
    const [controlsShown, setControlsShown] = useState(true);

    // The grid already holds this thumbnail, so it is a free poster instead of
    // a black rectangle while the first range requests are in flight.
    useEffect(() => {
        if (isAudio) return;
        let live = true;
        setPoster(null);
        void import('@/lib/telegram/media')
            .then((mod) => mod.downloadThumb(item))
            .then((url) => {
                if (live) setPoster(url);
            })
            .catch(() => undefined);
        return () => {
            live = false;
        };
    }, [item, isAudio]);

    useEffect(() => {
        let closed = false;
        let opened = false;
        openedAt.current = performance.now();
        onError(null);
        setSrc(null);
        setPlaying(false);
        setWaiting(false);
        setCurrentTime(0);
        setBuffered(0);
        setStatus('Opening stream…');

        void (async () => {
            try {
                const progressive = await import('@/lib/telegram/progressive');
                const url = await progressive.openProgressiveStream(
                    item,
                    item.quality.id,
                );
                opened = true;
                if (closed) {
                    progressive.closeProgressiveStream(item, item.quality.id);
                    return;
                }
                debug('video', 'progressive stream open', {
                    key: item.key,
                    quality: item.quality.label,
                });
                setSrc(url);
                setStatus('');
            } catch (caught) {
                if (closed) return;
                try {
                    debug(
                        'video',
                        'progressive failed, downloading file',
                        caught,
                    );
                    setStatus('Stream unavailable, loading file…');
                    const { downloadQuality } = await import(
                        '@/lib/telegram/media'
                    );
                    const url = await downloadQuality(item, item.quality.id);
                    if (closed) return;
                    setSrc(url);
                    setStatus('');
                } catch {
                    if (closed) return;
                    onError(
                        caught instanceof Error
                            ? caught.message
                            : 'Could not start playback.',
                    );
                }
            }
        })();

        return () => {
            closed = true;
            // Stop now rather than whenever the element is collected, so
            // stepping to the next item or closing the lightbox is silent —
            // and drop the source: a detached video otherwise keeps
            // buffering, and its downloads starved the next item's.
            const element = playerRef.current;
            if (element) {
                element.pause();
                element.removeAttribute('src');
                element.load();
            }
            if (opened) {
                void import('@/lib/telegram/progressive').then((mod) =>
                    mod.closeProgressiveStream(item, item.quality.id),
                );
            }
        };
    }, [item, onError]);

    useEffect(() => {
        const onChange = () =>
            setFullscreen(document.fullscreenElement === shellRef.current);
        document.addEventListener('fullscreenchange', onChange);
        return () => document.removeEventListener('fullscreenchange', onChange);
    }, []);

    const wake = useCallback(() => {
        setControlsShown(true);
        if (idleTimer.current) clearTimeout(idleTimer.current);
        idleTimer.current = setTimeout(() => setControlsShown(false), IDLE_MS);
    }, []);

    // Controls only ever hide over a playing video — never over audio, where
    // they are the entire interface, and never while paused.
    useEffect(() => {
        if (!playing || isAudio) {
            if (idleTimer.current) clearTimeout(idleTimer.current);
            setControlsShown(true);
            return;
        }
        wake();
        return () => {
            if (idleTimer.current) clearTimeout(idleTimer.current);
        };
    }, [playing, isAudio, wake]);

    const togglePlay = useCallback(() => {
        const element = playerRef.current;
        if (!element) return;
        if (element.paused) void element.play().catch(() => undefined);
        else element.pause();
    }, []);

    function seekTo(seconds: number) {
        const element = playerRef.current;
        if (!element) return;
        element.currentTime = seconds;
        setCurrentTime(seconds);
    }

    function onScrub(event: ChangeEvent<HTMLInputElement>) {
        seekTo(Number(event.target.value));
    }

    function onVolume(event: ChangeEvent<HTMLInputElement>) {
        const next = Number(event.target.value);
        setVolume(next);
        setMuted(next === 0);
        if (playerRef.current) playerRef.current.volume = next;
    }

    function cycleRate() {
        const next = RATES[(RATES.indexOf(rate) + 1) % RATES.length];
        setRate(next);
        if (playerRef.current) playerRef.current.playbackRate = next;
    }

    async function toggleFullscreen() {
        if (document.fullscreenElement) {
            await document.exitFullscreen().catch(() => undefined);
            return;
        }
        await shellRef.current?.requestFullscreen().catch(() => undefined);
    }

    /** Where this player is, for the next one to pick up from. */
    function handoff(): PlaybackHandoff {
        const element = playerRef.current;
        return {
            startAt: element?.currentTime ?? currentTime,
            volume,
            muted,
            rate,
            playing: element ? !element.paused : playing,
        };
    }

    const total = duration || item.duration || 0;
    const downloadSize = item.quality.fileSize ?? item.fileSize;

    return (
        <div
            ref={shellRef}
            className={cn(
                'group/player relative flex h-full w-full flex-col overflow-hidden bg-black',
                compact ? 'rounded-lg' : 'rounded-xl',
                fullscreen && 'rounded-none',
            )}
            onPointerMove={playing && !isAudio ? wake : undefined}
        >
            <div
                className="relative flex min-h-0 flex-1 items-center justify-center"
                onClick={isAudio ? undefined : togglePlay}
            >
                {isAudio ? <AudioFace item={item} playing={playing} /> : null}

                {src ? (
                    <ReactPlayer
                        ref={playerRef}
                        src={src}
                        // A handed-over video keeps the state it was left
                        // in: paused stays paused rather than starting up
                        // on its own.
                        autoPlay={initial ? initial.playing : true}
                        playsInline
                        preload="auto"
                        loop={isGif}
                        muted={muted}
                        // react-player writes these onto the element after
                        // every render, falling back to 1 when they are not
                        // given — so each timeupdate undid the volume slider
                        // and the speed button unless they come through here.
                        volume={volume}
                        playbackRate={rate}
                        poster={poster ?? undefined}
                        // react-player defaults width/height to 320x180 and
                        // applies them as inline style, which beats any class
                        // we set — so the size has to come through as props.
                        width={isAudio ? '1px' : '100%'}
                        height={isAudio ? '1px' : '100%'}
                        className={cn('object-contain', isAudio && 'sr-only')}
                        onPlay={() => setPlaying(true)}
                        onPause={() => setPlaying(false)}
                        onEnded={() => setPlaying(false)}
                        onWaiting={() => setWaiting(true)}
                        onPlaying={() => {
                            setWaiting(false);
                            if (openedAt.current === null) return;
                            debug('video', 'first frame', {
                                key: item.key,
                                ms: Math.round(
                                    performance.now() - openedAt.current,
                                ),
                            });
                            openedAt.current = null;
                        }}
                        onCanPlay={() => setWaiting(false)}
                        onLoadedMetadata={(event) => {
                            const start = pendingStart.current;
                            pendingStart.current = 0;
                            if (start > 0 && !isGif) {
                                event.currentTarget.currentTime = start;
                                setCurrentTime(start);
                            }
                        }}
                        onDurationChange={(event) =>
                            setDuration(event.currentTarget.duration || 0)
                        }
                        onTimeUpdate={(event) => {
                            const element = event.currentTarget;
                            setCurrentTime(element.currentTime);
                            const ranges = element.buffered;
                            setBuffered(
                                ranges.length
                                    ? ranges.end(ranges.length - 1)
                                    : 0,
                            );
                        }}
                        onVolumeChange={(event) => {
                            setVolume(event.currentTarget.volume);
                            setMuted(event.currentTarget.muted);
                        }}
                    />
                ) : null}

                {status ? (
                    <p className="absolute text-sm text-white/70">{status}</p>
                ) : null}

                {waiting && !status ? (
                    <span className="pointer-events-none absolute size-10 animate-spin rounded-full border-2 border-white/25 border-t-white/90" />
                ) : null}

                {!playing && !status && !isAudio && !waiting ? (
                    <span
                        className={cn(
                            'pointer-events-none absolute grid place-items-center rounded-full bg-black/55 backdrop-blur-sm',
                            compact ? 'size-11' : 'size-16',
                        )}
                    >
                        <Play
                            className={cn(
                                'translate-x-0.5 fill-white text-white',
                                compact ? 'size-5' : 'size-7',
                            )}
                        />
                    </span>
                ) : null}
            </div>

            <div
                className={cn(
                    'absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/60 to-transparent transition-opacity duration-200',
                    compact ? 'px-2 pt-6 pb-1' : 'px-3 pt-8 pb-2',
                    controlsShown
                        ? 'opacity-100'
                        : 'pointer-events-none opacity-0',
                )}
                onClick={(event) => event.stopPropagation()}
            >
                <Scrubber
                    mediaRef={playerRef}
                    playing={playing}
                    current={currentTime}
                    buffered={buffered}
                    total={total}
                    onSeek={onScrub}
                />

                <div className="mt-1.5 flex items-center gap-1 text-white">
                    <IconButton
                        label={playing ? 'Pause' : 'Play'}
                        onClick={togglePlay}
                    >
                        {playing ? (
                            <Pause className="fill-current" />
                        ) : (
                            <Play className="fill-current" />
                        )}
                    </IconButton>

                    <p className="ml-1 text-xs text-white/75 tabular-nums">
                        {formatDuration(currentTime)}
                        <span className="text-white/40">
                            {' / '}
                            {total ? formatDuration(total) : '--:--'}
                        </span>
                    </p>

                    <div className="group/vol flex items-center gap-1">
                        <IconButton
                            label={muted ? 'Unmute' : 'Mute'}
                            onClick={() => {
                                const next = !muted;
                                setMuted(next);
                                if (playerRef.current) {
                                    playerRef.current.muted = next;
                                }
                            }}
                        >
                            {muted || volume === 0 ? <VolumeX /> : <Volume2 />}
                        </IconButton>
                        <input
                            type="range"
                            min={0}
                            max={1}
                            step={0.05}
                            value={muted ? 0 : volume}
                            onChange={onVolume}
                            aria-label="Volume"
                            hidden={compact}
                            className="accent-primary h-1 w-0 cursor-pointer opacity-0 transition-all duration-200 group-hover/vol:w-16 group-hover/vol:opacity-100 focus-visible:w-16 focus-visible:opacity-100"
                        />
                    </div>

                    <div className="flex-1" />

                    {!isGif && !compact ? (
                        <button
                            type="button"
                            onClick={cycleRate}
                            aria-label="Playback speed"
                            className="rounded-md px-2 py-1 text-xs font-medium text-white/75 tabular-nums transition-colors hover:bg-white/10 hover:text-white"
                        >
                            {rate}×
                        </button>
                    ) : null}

                    {download && !compact ? (
                        <DownloadButton
                            busy={download.busy}
                            fileSize={downloadSize}
                            onDownload={download.onDownload}
                        />
                    ) : null}

                    {!isAudio ? (
                        <>
                            {onPictureInPicture ? (
                                <IconButton
                                    label="Picture in picture"
                                    onClick={() =>
                                        onPictureInPicture(handoff())
                                    }
                                >
                                    <PictureInPicture2 />
                                </IconButton>
                            ) : null}
                            {onExpand ? (
                                <IconButton
                                    label="Back to the viewer"
                                    onClick={() => onExpand(handoff())}
                                >
                                    <Maximize2 />
                                </IconButton>
                            ) : null}
                            <IconButton
                                label={
                                    fullscreen
                                        ? 'Exit full screen'
                                        : 'Full screen'
                                }
                                onClick={() => void toggleFullscreen()}
                            >
                                {fullscreen ? <Minimize /> : <Maximize />}
                            </IconButton>
                        </>
                    ) : null}
                </div>
            </div>
        </div>
    );
}

/** Audio has no picture, so it gets a title card instead of a black void. */
function AudioFace({ item, playing }: { item: MediaItem; playing: boolean }) {
    const [cover, setCover] = useState<string | null>(null);

    useEffect(() => {
        let live = true;
        setCover(null);
        void import('@/lib/telegram/media')
            .then((mod) => mod.downloadSoundArt(item))
            .then((url) => {
                if (live) setCover(url);
            })
            .catch(() => undefined);
        return () => {
            live = false;
        };
    }, [item]);

    return (
        <div className="flex w-full max-w-sm flex-col items-center gap-5 px-6 pb-16 text-center">
            <div className="relative grid aspect-square w-56 place-items-center overflow-hidden rounded-2xl bg-gradient-to-br from-white/15 to-white/5 shadow-2xl">
                {cover ? (
                    <img
                        src={cover}
                        alt=""
                        loading="lazy"
                        decoding="async"
                        className="size-full object-cover"
                    />
                ) : (
                    <Music
                        className={cn(
                            'size-16 text-white/45 transition-transform duration-500',
                            playing && 'scale-110',
                        )}
                    />
                )}
            </div>
            <div className="min-w-0">
                <p className="truncate text-base font-medium text-white">
                    {item.audioTitle ??
                        item.fileName ??
                        (item.type === 'voice' ? 'Voice message' : 'Audio')}
                </p>
                {item.audioPerformer ? (
                    <p className="mt-0.5 truncate text-sm text-white/55">
                        {item.audioPerformer}
                    </p>
                ) : null}
            </div>
        </div>
    );
}

/**
 * The seek bar, painted every frame while playing.
 *
 * `timeupdate` only fires about four times a second, so a bar that follows it
 * moves in visible steps. While playing, a frame loop reads the element's own
 * clock and writes straight to the DOM — a `scaleX` on the fill and the
 * range's value for the thumb — without a React render per frame. Paused, the
 * bar simply follows `current`.
 */
function Scrubber({
    mediaRef,
    playing,
    current,
    buffered,
    total,
    onSeek,
}: {
    mediaRef: RefObject<HTMLVideoElement | null>;
    playing: boolean;
    current: number;
    buffered: number;
    total: number;
    onSeek: (event: ChangeEvent<HTMLInputElement>) => void;
}) {
    const fillRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    // Mid-drag the thumb belongs to the pointer, not the clock.
    const dragging = useRef(false);
    const loaded = total > 0 ? Math.min(100, (buffered / total) * 100) : 0;

    const paint = useCallback(
        (seconds: number) => {
            const fraction =
                total > 0 ? Math.min(1, Math.max(0, seconds / total)) : 0;
            if (fillRef.current) {
                fillRef.current.style.transform = `scaleX(${fraction})`;
            }
            if (inputRef.current && !dragging.current) {
                inputRef.current.value = String(Math.min(seconds, total));
            }
        },
        [total],
    );

    useLayoutEffect(() => {
        if (!playing) paint(current);
    }, [current, playing, paint]);

    useEffect(() => {
        if (!playing) return;
        let frame = 0;
        const tick = () => {
            const element = mediaRef.current;
            if (element) paint(element.currentTime);
            frame = requestAnimationFrame(tick);
        };
        frame = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(frame);
    }, [playing, paint, mediaRef]);

    const release = () => {
        dragging.current = false;
    };

    return (
        <div className="relative flex h-4 items-center">
            <div className="pointer-events-none absolute inset-x-0 h-1 overflow-hidden rounded-full bg-white/20">
                <div
                    className="h-full bg-white/25 transition-[width] duration-300 ease-out"
                    style={{ width: `${loaded}%` }}
                />
                <div
                    ref={fillRef}
                    className="bg-primary absolute inset-0 origin-left will-change-transform"
                    style={{ transform: 'scaleX(0)' }}
                />
            </div>
            <input
                ref={inputRef}
                type="range"
                min={0}
                max={total || 0}
                // Any step: a fixed one snaps the thumb, and on a short clip
                // a tenth of a second is several pixels.
                step="any"
                defaultValue={0}
                onChange={onSeek}
                onPointerDown={() => {
                    dragging.current = true;
                }}
                onPointerUp={release}
                onPointerCancel={release}
                disabled={!total}
                aria-label="Seek"
                className="relative h-4 w-full cursor-pointer appearance-none bg-transparent outline-none [&::-webkit-slider-thumb]:size-3 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:shadow"
            />
        </div>
    );
}

function IconButton({
    label,
    onClick,
    disabled,
    children,
}: {
    label: string;
    onClick: () => void;
    disabled?: boolean;
    children: ReactNode;
}) {
    return (
        <Button
            variant="ghost"
            size="icon-sm"
            aria-label={label}
            title={label}
            disabled={disabled}
            onClick={onClick}
            className="text-white hover:bg-white/15 hover:text-white [&_svg]:size-4"
        >
            {children}
        </Button>
    );
}
