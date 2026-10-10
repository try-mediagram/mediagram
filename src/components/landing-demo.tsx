import { Mic, Play, Search, Tag as TagIcon, X } from 'lucide-react';
import { useMemo, useState } from 'react';

import { Segmented } from '@/components/ui/segmented';
import { cn } from '@/lib/utils';
import type { MediaKind, MediaTypeFilter } from '@/lib/telegram/types';

/**
 * The product, above the sign-in.
 *
 * A visitor has to want this before they will hand over a Telegram session, and
 * nothing argues for a media library like seeing one. So this is not a
 * screenshot: it is the real interaction — type in the search, switch the type,
 * press a tag — running on invented media, at a scale that fits on a landing
 * page.
 *
 * The controls are the app's own. The four type filters are `MediaTypeFilter`
 * exactly (video covers GIFs and video notes, audio covers voice notes), and
 * the tags behave the way tags do in a chat: a chosen tag narrows what is
 * already on screen and never asks Telegram anything. Anything the demo shows
 * has to be a thing the product does, or the sign-in it earns is a sign-up for
 * something else.
 */

type SceneId =
    | 'horizon'
    | 'peaks'
    | 'city'
    | 'portrait'
    | 'table'
    | 'road'
    | 'shore'
    | 'window'
    | 'waveform';

type DemoItem = {
    id: number;
    kind: MediaKind;
    /** The message text Telegram would search, and the tile's label. */
    text: string;
    /** Runtime, for the kinds that have one. */
    length?: string;
    tags: string[];
    scene: SceneId;
};

/**
 * Invented media, but shaped like the real thing: mostly photos, a handful of
 * video, a couple of voice notes, captions that read like messages rather than
 * filenames.
 */
const ITEMS: DemoItem[] = [
    // The twelve the default search finds. Ordered so no two neighbours draw
    // the same scene, and counted so the grid closes on a full row at every
    // breakpoint — a demo that opens on a half-empty last row reads as a chat
    // with nothing in it.
    {
        id: 1,
        kind: 'photo',
        text: 'Road trip, day one',
        tags: ['travel'],
        scene: 'road',
    },
    {
        id: 2,
        kind: 'photo',
        text: 'Trip north — the pass',
        tags: ['travel'],
        scene: 'peaks',
    },
    {
        id: 3,
        kind: 'photo',
        text: 'Trip to the coast',
        tags: ['travel', 'mexico'],
        scene: 'shore',
    },
    {
        id: 4,
        kind: 'voice',
        text: 'Voice note about the trip',
        length: '0:38',
        tags: ['travel'],
        scene: 'waveform',
    },
    {
        id: 5,
        kind: 'photo',
        text: 'Trip into the city',
        tags: ['mexico'],
        scene: 'city',
    },
    {
        id: 6,
        kind: 'photo',
        text: 'Sunset, last night of the trip',
        tags: ['travel'],
        scene: 'horizon',
    },
    {
        id: 7,
        kind: 'photo',
        text: 'Trip out, first morning',
        tags: [],
        scene: 'window',
    },
    {
        id: 8,
        kind: 'photo',
        text: 'Trip food, all of it',
        tags: ['mexico'],
        scene: 'table',
    },
    {
        id: 9,
        kind: 'video',
        text: 'Trip footage from the car',
        length: '2:14',
        tags: ['travel'],
        scene: 'road',
    },
    {
        id: 10,
        kind: 'photo',
        text: 'Her, mid-trip',
        tags: [],
        scene: 'portrait',
    },
    {
        id: 11,
        kind: 'video',
        text: 'Trip out to the ruins',
        length: '4:51',
        tags: ['travel', 'mexico'],
        scene: 'peaks',
    },
    {
        id: 12,
        kind: 'audio',
        text: 'Song from the trip playlist',
        length: '3:26',
        tags: [],
        scene: 'waveform',
    },

    // The rest of the chat, which appears when the search is cleared.
    {
        id: 13,
        kind: 'photo',
        text: 'Golden hour on the roof',
        tags: [],
        scene: 'horizon',
    },
    {
        id: 14,
        kind: 'photo',
        text: 'Breakfast in Oaxaca',
        tags: ['mexico'],
        scene: 'table',
    },
    {
        id: 15,
        kind: 'gif',
        text: 'The dog, unimpressed',
        length: 'GIF',
        tags: [],
        scene: 'portrait',
    },
    {
        id: 16,
        kind: 'photo',
        text: 'Mexico City rooftops',
        tags: ['mexico'],
        scene: 'city',
    },
    {
        id: 17,
        kind: 'photo',
        text: 'The beach at Zipolite',
        tags: ['mexico'],
        scene: 'shore',
    },
    {
        id: 18,
        kind: 'photo',
        text: 'The pass, second time',
        tags: [],
        scene: 'peaks',
    },
    { id: 19, kind: 'photo', text: 'Balcony, late', tags: [], scene: 'window' },
    {
        id: 20,
        kind: 'voice',
        text: 'Voice note, 11pm',
        length: '0:12',
        tags: [],
        scene: 'waveform',
    },
    {
        id: 21,
        kind: 'video',
        text: 'Walking home',
        length: '1:02',
        tags: [],
        scene: 'road',
    },
    {
        id: 22,
        kind: 'photo',
        text: 'Market stalls',
        tags: ['mexico'],
        scene: 'table',
    },
    {
        id: 23,
        kind: 'photo',
        text: 'Storm coming in',
        tags: [],
        scene: 'horizon',
    },
    {
        id: 24,
        kind: 'photo',
        text: 'Him, laughing',
        tags: [],
        scene: 'portrait',
    },
];

/** How many items a real chat would hold behind these eighteen. */
const CHAT_TOTAL = 3417;

const TYPES: { value: MediaTypeFilter; label: string; title: string }[] = [
    { value: 'all', label: 'All', title: 'All media' },
    { value: 'photo', label: 'Photos', title: 'Photos' },
    { value: 'video', label: 'Video', title: 'Video, GIFs and video notes' },
    { value: 'audio', label: 'Audio', title: 'Music and voice notes' },
];

const TAGS = ['travel', 'mexico'];

/** The coarse filter the app uses: one row per thing a reader thinks of as one. */
function matchesType(kind: MediaKind, type: MediaTypeFilter): boolean {
    if (type === 'all') return true;
    if (type === 'photo') return kind === 'photo';
    if (type === 'video') return kind === 'video' || kind === 'gif';
    return kind === 'audio' || kind === 'voice';
}

export function LandingDemo() {
    const [query, setQuery] = useState('trip');
    const [type, setType] = useState<MediaTypeFilter>('all');
    const [tags, setTags] = useState<string[]>([]);

    const items = useMemo(() => {
        const needle = query.trim().toLowerCase();

        return ITEMS.filter((item) => {
            if (!matchesType(item.kind, type)) return false;
            if (needle && !item.text.toLowerCase().includes(needle)) {
                return false;
            }
            // Tags are OR, the way the chat grid matches them.
            if (tags.length && !tags.some((tag) => item.tags.includes(tag))) {
                return false;
            }
            return true;
        });
    }, [query, type, tags]);

    const filtered = query.trim() !== '' || type !== 'all' || tags.length > 0;

    function toggleTag(tag: string) {
        setTags((current) =>
            current.includes(tag)
                ? current.filter((entry) => entry !== tag)
                : [...current, tag],
        );
    }

    function reset() {
        setQuery('');
        setType('all');
        setTags([]);
    }

    /*
     * Folded into every tile's key so a filter change replays the entrance.
     * Without it React keeps the tiles that survived the change and only the
     * newcomers move, which reads as a glitch rather than as a result landing.
     */
    const pass = `${query}|${type}|${tags.join(',')}`;

    return (
        <div className="border-border bg-card overflow-hidden rounded-2xl border shadow-[0_1px_2px_rgba(0,0,0,0.04),0_12px_32px_-12px_rgba(0,0,0,0.12)] dark:shadow-[0_1px_2px_rgba(0,0,0,0.4),0_16px_40px_-16px_rgba(0,0,0,0.6)]">
            <div className="border-border flex flex-wrap items-center gap-x-4 gap-y-3 border-b px-4 py-3 sm:px-5">
                <div className="min-w-0">
                    <p className="font-display truncate font-semibold tracking-tight">
                        Family
                    </p>
                    <p className="text-muted-foreground text-xs tabular-nums">
                        {filtered
                            ? `${items.length} of ${CHAT_TOTAL.toLocaleString()} items`
                            : `${CHAT_TOTAL.toLocaleString()} items`}
                    </p>
                </div>

                <label className="border-input focus-within:border-ring focus-within:ring-ring/50 ml-auto flex h-8 w-full min-w-0 items-center gap-2 rounded-lg border px-2.5 transition-colors focus-within:ring-3 sm:w-56">
                    <Search
                        className="text-muted-foreground size-3.5 shrink-0"
                        aria-hidden
                    />
                    <span className="sr-only">Search this chat</span>
                    <input
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder="Search this chat"
                        spellCheck={false}
                        className="placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent text-sm outline-none"
                    />
                    {query ? (
                        <button
                            type="button"
                            onClick={() => setQuery('')}
                            aria-label="Clear the search"
                            className="text-muted-foreground hover:text-foreground focus-visible:ring-ring shrink-0 rounded-sm outline-none focus-visible:ring-2"
                        >
                            <X className="size-3.5" aria-hidden />
                        </button>
                    ) : null}
                </label>
            </div>

            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 pt-3 sm:px-5">
                <Segmented
                    value={type}
                    onChange={setType}
                    options={TYPES}
                    className="text-xs"
                />

                <div className="flex items-center gap-1.5">
                    {TAGS.map((tag) => {
                        const active = tags.includes(tag);
                        return (
                            <button
                                key={tag}
                                type="button"
                                aria-pressed={active}
                                onClick={() => toggleTag(tag)}
                                className={cn(
                                    'focus-visible:ring-ring inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-xs font-medium transition-colors outline-none focus-visible:ring-2',
                                    active
                                        ? 'border-brand-border bg-brand-subtle text-brand-text'
                                        : 'border-border text-muted-foreground hover:text-foreground hover:border-foreground/25',
                                )}
                            >
                                <TagIcon className="size-3" aria-hidden />#{tag}
                            </button>
                        );
                    })}
                </div>
            </div>

            <div className="px-4 pt-3 pb-4 sm:px-5 sm:pb-5">
                {items.length ? (
                    <ul className="grid grid-cols-3 gap-1.5 sm:grid-cols-4 sm:gap-2 lg:grid-cols-6">
                        {items.map((item, index) => (
                            <Tile
                                key={`${pass}-${item.id}`}
                                item={item}
                                index={index}
                            />
                        ))}
                    </ul>
                ) : (
                    <div className="flex flex-col items-start gap-3 py-14">
                        <p className="text-muted-foreground text-sm text-pretty">
                            Nothing in this chat matches that.
                        </p>
                        <button
                            type="button"
                            onClick={reset}
                            className="text-brand-text focus-visible:ring-ring rounded-sm text-sm font-medium underline-offset-4 outline-none hover:underline focus-visible:ring-2"
                        >
                            Clear the filters
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}

function Tile({ item, index }: { item: DemoItem; index: number }) {
    const playable =
        item.kind === 'video' || item.kind === 'gif' || item.kind === 'audio';
    const heard = item.kind === 'voice';

    return (
        <li
            className="animate-in fade-in-0 zoom-in-95 group fill-mode-both relative aspect-square overflow-hidden rounded-md duration-300 ease-out motion-reduce:animate-none"
            style={{ animationDelay: `${Math.min(index, 11) * 22}ms` }}
        >
            <Scene id={item.scene} />

            {/* A caption a reader can actually read, on the scrim that makes it
                legible over any frame. Hidden until hover on a pointer device,
                because eighteen captions at once is a list, not a grid. */}
            <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between gap-1 bg-gradient-to-t from-black/70 to-transparent px-1.5 pt-6 pb-1">
                <span className="truncate text-[10px] leading-tight font-medium text-white/0 transition-colors duration-200 group-hover:text-white/95">
                    {item.text}
                </span>
                {item.length ? (
                    <span className="shrink-0 text-[10px] leading-tight font-medium text-white/85 tabular-nums">
                        {item.length}
                    </span>
                ) : null}
            </div>

            {playable || heard ? (
                <span className="pointer-events-none absolute top-1.5 left-1.5 grid size-5 place-items-center rounded-full bg-black/45 text-white backdrop-blur-[2px]">
                    {heard ? (
                        <Mic className="size-2.5" aria-hidden />
                    ) : (
                        <Play className="size-2.5 fill-current" aria-hidden />
                    )}
                </span>
            ) : null}

            {/* A tagged item is marked in the same chip language as a
                playable one, rather than with a bare coloured dot — at
                thumbnail size a dot is a smudge, and this grid is the only
                place the reader ever sees what a tag looks like on media. */}
            {item.tags.length ? (
                <span className="pointer-events-none absolute top-1.5 right-1.5 grid size-5 place-items-center rounded-full bg-black/45 text-white backdrop-blur-[2px]">
                    <TagIcon className="size-2.5" aria-hidden />
                </span>
            ) : null}

            <span className="sr-only">{item.text}</span>
        </li>
    );
}

/**
 * The frames themselves.
 *
 * Drawn rather than photographed, and drawn as scenes rather than as grey
 * rectangles: at thumbnail size a media grid is read as colour and silhouette,
 * and a wall of identical placeholders would say "nothing here yet" — the exact
 * opposite of the claim. The palettes are fixed rather than themed, because a
 * photograph does not invert when the interface does.
 */
function Scene({ id }: { id: SceneId }) {
    const common = 'absolute inset-0 h-full w-full';

    switch (id) {
        case 'horizon':
            return (
                <svg className={common} viewBox="0 0 100 100" aria-hidden>
                    <rect width="100" height="100" fill="#e8a06a" />
                    <rect y="0" width="100" height="52" fill="#f0bd86" />
                    <circle cx="62" cy="44" r="13" fill="#fbe3bd" />
                    <rect y="62" width="100" height="38" fill="#7a4a3c" />
                    <path d="M0 62 L100 62 L100 70 L0 74 Z" fill="#a8654a" />
                </svg>
            );
        case 'peaks':
            return (
                <svg className={common} viewBox="0 0 100 100" aria-hidden>
                    <rect width="100" height="100" fill="#9fc0cf" />
                    <path d="M0 70 L30 30 L56 70 Z" fill="#3f5f70" />
                    <path d="M22 70 L30 30 L38 45 L30 52 Z" fill="#dceaf0" />
                    <path d="M38 78 L72 36 L100 78 Z" fill="#57798a" />
                    <rect y="78" width="100" height="22" fill="#2c4452" />
                </svg>
            );
        case 'city':
            return (
                <svg className={common} viewBox="0 0 100 100" aria-hidden>
                    <rect width="100" height="100" fill="#f0c9a0" />
                    <rect y="58" width="100" height="42" fill="#8d5f4e" />
                    <rect x="6" y="40" width="20" height="60" fill="#c98d6c" />
                    <rect x="32" y="52" width="16" height="48" fill="#a8705a" />
                    <rect x="54" y="34" width="22" height="66" fill="#b87f63" />
                    <rect x="82" y="48" width="14" height="52" fill="#96634f" />
                    <rect x="60" y="42" width="4" height="6" fill="#f6ddc2" />
                    <rect x="68" y="54" width="4" height="6" fill="#f6ddc2" />
                    <rect x="12" y="50" width="4" height="6" fill="#f6ddc2" />
                </svg>
            );
        case 'portrait':
            return (
                <svg className={common} viewBox="0 0 100 100" aria-hidden>
                    <rect width="100" height="100" fill="#b6a894" />
                    <circle cx="50" cy="40" r="20" fill="#5c4a3f" />
                    <path
                        d="M50 62 C24 62 12 82 12 100 L88 100 C88 82 76 62 50 62 Z"
                        fill="#43352d"
                    />
                    <circle cx="50" cy="38" r="13" fill="#8a6b57" />
                </svg>
            );
        case 'table':
            return (
                <svg className={common} viewBox="0 0 100 100" aria-hidden>
                    <rect width="100" height="100" fill="#6d5a48" />
                    <circle cx="36" cy="42" r="21" fill="#e6ddcd" />
                    <circle cx="36" cy="42" r="12" fill="#c47a4e" />
                    <circle cx="74" cy="66" r="15" fill="#efe7d8" />
                    <circle cx="74" cy="66" r="8" fill="#7d9c6a" />
                    <rect
                        x="6"
                        y="72"
                        width="34"
                        height="6"
                        rx="3"
                        fill="#cbbfa9"
                    />
                </svg>
            );
        case 'road':
            return (
                <svg className={common} viewBox="0 0 100 100" aria-hidden>
                    <rect width="100" height="100" fill="#8fb8cc" />
                    <rect y="46" width="100" height="54" fill="#6b6f6e" />
                    <path d="M42 46 L58 46 L86 100 L14 100 Z" fill="#494d4d" />
                    <path d="M48 52 L52 52 L54 66 L46 66 Z" fill="#e8e2cf" />
                    <path d="M44 74 L56 74 L60 92 L40 92 Z" fill="#e8e2cf" />
                    <rect y="38" width="100" height="8" fill="#c9dbe4" />
                </svg>
            );
        case 'shore':
            return (
                <svg className={common} viewBox="0 0 100 100" aria-hidden>
                    <rect width="100" height="100" fill="#e3d3b4" />
                    <rect width="100" height="44" fill="#7fc0d3" />
                    <rect y="44" width="100" height="20" fill="#2f7f96" />
                    <path
                        d="M0 62 Q25 56 50 62 T100 62 L100 70 L0 70 Z"
                        fill="#e9f2f4"
                    />
                    <circle cx="80" cy="18" r="9" fill="#fdf0cf" />
                </svg>
            );
        case 'window':
            return (
                <svg className={common} viewBox="0 0 100 100" aria-hidden>
                    <rect width="100" height="100" fill="#2f3742" />
                    <rect
                        x="14"
                        y="12"
                        width="72"
                        height="76"
                        fill="#89a6bd"
                        rx="2"
                    />
                    <rect x="14" y="56" width="72" height="32" fill="#5d7f9c" />
                    <rect x="47" y="12" width="6" height="76" fill="#2f3742" />
                    <rect x="14" y="46" width="72" height="5" fill="#2f3742" />
                    <circle cx="30" cy="30" r="7" fill="#f2e6c7" />
                </svg>
            );
        case 'waveform':
            return (
                <svg className={common} viewBox="0 0 100 100" aria-hidden>
                    <rect width="100" height="100" fill="#3d4450" />
                    {[
                        14, 30, 20, 46, 62, 38, 70, 52, 26, 44, 66, 34, 18, 40,
                    ].map((height, index) => (
                        <rect
                            key={index}
                            x={7 + index * 6.4}
                            y={50 - height / 2}
                            width="3.4"
                            height={height}
                            rx="1.7"
                            fill={index % 3 === 0 ? '#8fbfd8' : '#66798c'}
                        />
                    ))}
                </svg>
            );
    }
}
