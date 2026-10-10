import {
    Image as ImageIcon,
    LayoutGrid,
    type LucideIcon,
    Minus,
    Music,
    Plus,
    Search,
    Tag as TagIcon,
    Video,
    X,
} from 'lucide-react';

import { type ReactNode, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { normaliseTagQuery } from '@/lib/tag-filters';
import { cn } from '@/lib/utils';
import type { MediaOrder, MediaTypeFilter } from '@/lib/telegram/types';
import type { ChatTagCount, TagMatch } from '@/types/tags';

/**
 * How many tags a chat's rail holds before it offers a search box.
 *
 * A rail is scanned, not read. Below this the box is one more row between the
 * reader and the tags it is meant to help them reach.
 */
const TAG_SEARCH_FROM = 8;

export type MediaSearchState = {
    type: MediaTypeFilter;
    order: MediaOrder;
    minDur?: number;
    maxDur?: number;
    /**
     * Tag names to filter by. Filtering by them does not go through Telegram's
     * search at all: the tags are ours and Telegram has never heard of them.
     * See MediaGrid.
     *
     * Names, not ids, so links keep working across a tag being recreated.
     */
    tags: string[];
    /**
     * What stacking two of those does: `any` shows what either one is on,
     * `all` only what carries both. Defaults to `any` — it is what stacking
     * meant before the choice existed, and a filter that silently narrowed
     * would empty grids somebody had bookmarked.
     */
    tagMatch: TagMatch;
    /** Free text, searched by Telegram over the chat's own messages. */
    query?: string;
    /**
     * Narrow to what this account has or has not opened yet. Applied to the
     * loaded pages, like the seen mark itself: Telegram has no idea of it.
     */
    seen?: SeenFilter;
};

export type SeenFilter = 'unseen' | 'seen';

const TYPES: {
    value: MediaTypeFilter;
    label: string;
    icon: typeof ImageIcon;
}[] = [
    { value: 'all', label: 'All media', icon: LayoutGrid },
    { value: 'photo', label: 'Photos', icon: ImageIcon },
    // One row each for what a reader thinks of as one thing: video covers
    // animations and round video notes, audio covers voice notes.
    { value: 'video', label: 'Video', icon: Video },
    { value: 'audio', label: 'Audio', icon: Music },
];

const ORDERS: { value: MediaOrder; label: string }[] = [
    { value: 'new', label: 'Newest first' },
    { value: 'old', label: 'Oldest first' },
];

/**
 * The two ways a stack of tags can combine.
 *
 * Titled rather than explained in a legend: two words on a two-button control
 * are ambiguous on their own, and the answer is one hover away.
 */
const TAG_MATCHES: { value: TagMatch; label: string; title: string }[] = [
    {
        value: 'any',
        label: 'Any',
        title: 'Media carrying any one of these tags',
    },
    {
        value: 'all',
        label: 'All',
        title: 'Media carrying every one of these tags',
    },
];

const MINUTE = 60;

/**
 * The stops the length slider moves between, in seconds.
 *
 * Spaced by feel rather than evenly: a clip is told apart from another by
 * seconds, a film by quarter hours, and an even scale would spend the whole
 * track on the long end. The last stop is "no limit".
 */
const LENGTH_STOPS = [
    0,
    10,
    30,
    MINUTE,
    2 * MINUTE,
    5 * MINUTE,
    10 * MINUTE,
    15 * MINUTE,
    20 * MINUTE,
    30 * MINUTE,
    45 * MINUTE,
    60 * MINUTE,
    90 * MINUTE,
    120 * MINUTE,
    Number.POSITIVE_INFINITY,
];

const LAST_STOP = LENGTH_STOPS.length - 1;

/** The stop nearest a bound, for links written before the slider existed. */
function nearestStop(seconds: number | undefined, fallback: number): number {
    if (seconds === undefined) return fallback;
    let best = 0;
    for (let at = 1; at < LAST_STOP; at += 1) {
        if (
            Math.abs(LENGTH_STOPS[at] - seconds) <
            Math.abs(LENGTH_STOPS[best] - seconds)
        ) {
            best = at;
        }
    }
    return best;
}

function formatStop(seconds: number): string {
    if (seconds < MINUTE) return `${seconds}s`;
    if (seconds < 60 * MINUTE) return `${Math.round(seconds / MINUTE)}m`;
    const hours = seconds / (60 * MINUTE);
    return Number.isInteger(hours) ? `${hours}h` : `${hours.toFixed(1)}h`;
}

/** The range as a few characters, for the button and the popover heading. */
function lengthLabel(min?: number, max?: number): string {
    if (min === undefined && max === undefined) return 'Any length';
    if (max === undefined) return `${formatStop(min ?? 0)}+`;
    if (min === undefined) return `Under ${formatStop(max)}`;
    return `${formatStop(min)} – ${formatStop(max)}`;
}

/** Slider stops back to the filter's bounds; an open end is no bound at all. */
function stopsToBounds([low, high]: number[]): {
    minDur?: number;
    maxDur?: number;
} {
    return {
        minDur: low > 0 ? LENGTH_STOPS[low] : undefined,
        maxDur: high < LAST_STOP ? LENGTH_STOPS[high] : undefined,
    };
}

/**
 * What the reader navigates this chat by: the category, and their own tags.
 *
 * Both are destinations — somewhere to go — so both are rows with icons and
 * counts, the same rows the library rail uses for folders. Order and length are
 * settings on what is already on screen rather than places, so they live in
 * MediaToolbar over the grid; keeping them here cost seven rows and pushed the
 * tags under the fold.
 */
export function MediaFilters({
    value,
    tags,
    onChange,
}: {
    value: MediaSearchState;
    /** The tags in use in this chat, with how much each is on. */
    tags: ChatTagCount[];
    onChange: (next: MediaSearchState) => void;
}) {
    const [tagQuery, setTagQuery] = useState('');

    // A rail is scanned, not read, so the search only appears once scanning
    // stops working. Below the threshold the box would be one more row between
    // the reader and the tags it is meant to help them reach.
    const searchable = tags.length > TAG_SEARCH_FROM;
    const needle = normaliseTagQuery(tagQuery);

    const matching = searchable
        ? tags.filter((tag) => tag.name.toLowerCase().includes(needle))
        : tags;

    return (
        <nav
            aria-label="Media filters"
            className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-2"
        >
            <FilterHeading>Type</FilterHeading>
            {TYPES.map((option) => (
                <FilterRow
                    key={option.value}
                    active={option.value === value.type}
                    icon={option.icon}
                    label={option.label}
                    onClick={() =>
                        onChange({
                            ...value,
                            type: option.value,
                            minDur:
                                option.value === 'photo'
                                    ? undefined
                                    : value.minDur,
                            maxDur:
                                option.value === 'photo'
                                    ? undefined
                                    : value.maxDur,
                        })
                    }
                />
            ))}

            {searchable ? (
                <div className="relative px-1 pt-3 pb-1">
                    <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2" />
                    <Input
                        value={tagQuery}
                        onChange={(event) => setTagQuery(event.target.value)}
                        placeholder="Find a tag"
                        aria-label="Find a tag in this chat"
                        className="h-8 pl-8 text-xs"
                    />
                </div>
            ) : null}

            <TagRows
                heading="Tags"
                icon={TagIcon}
                tags={matching}
                value={value}
                onChange={onChange}
            />

            {searchable && matching.length === 0 ? (
                <p className="text-muted-foreground px-2 py-3 text-xs text-pretty">
                    No tag in this chat is called “{tagQuery.trim()}”.
                </p>
            ) : null}
        </nav>
    );
}

/**
 * One group of tag rows in the rail. The filter is by name.
 */
function TagRows({
    heading,
    icon,
    tags,
    value,
    onChange,
}: {
    heading: string;
    icon: LucideIcon;
    tags: ChatTagCount[];
    value: MediaSearchState;
    onChange: (next: MediaSearchState) => void;
}) {
    if (tags.length === 0) return null;

    return (
        <>
            <FilterHeading>{heading}</FilterHeading>
            {tags.map((tag) => {
                const on = value.tags.includes(tag.name);

                return (
                    <FilterRow
                        key={tag.name}
                        active={on}
                        icon={icon}
                        label={tag.name}
                        count={tag.count}
                        // The sign is about the filter, not about the grid: +
                        // puts the tag in it, − takes it back out. Which way
                        // the grid then moves is the Any/All control in the
                        // toolbar, so a fixed sign here would be wrong half
                        // the time.
                        mark={on ? Minus : Plus}
                        onClick={() =>
                            onChange({
                                ...value,
                                tags: on
                                    ? value.tags.filter(
                                          (name) => name !== tag.name,
                                      )
                                    : [...value.tags, tag.name],
                            })
                        }
                    />
                );
            })}
        </>
    );
}

/**
 * Order, length, and the way out — pinned over the grid rather than parked in
 * the rail.
 *
 * These are settings on what is already on screen, not places to go, so they
 * belong with the thing they change and stay in reach as it scrolls. The rail
 * keeps what a reader navigates by: the category and their tags. Clear sits at
 * the far right of the same bar, which is where a control that undoes the rest
 * of the row belongs.
 */
export function MediaToolbar({
    value,
    onChange,
    actions,
}: {
    value: MediaSearchState;
    onChange: (next: MediaSearchState) => void;
    /**
     * Controls over the chat as a whole rather than the media shown in it —
     * the chat-pane toggle and Export. They share the row's right edge with
     * Clear tags.
     */
    actions?: ReactNode;
}) {
    const durationEnabled = value.type !== 'photo';

    return (
        // Opaque and raised, because the grid runs underneath it: without the
        // shadow a thumbnail scrolling past reads as sitting in the bar.
        <div className="border-border bg-background sticky top-0 z-10 flex min-h-14 flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-2 shadow-sm">
            <Labelled label="Order by">
                <Select
                    value={value.order}
                    onValueChange={(order) =>
                        onChange({ ...value, order: order as MediaOrder })
                    }
                >
                    <SelectTrigger
                        size="sm"
                        aria-label="Order by"
                        className="min-w-32"
                    >
                        <SelectValue>
                            {(order) =>
                                ORDERS.find((option) => option.value === order)
                                    ?.label ?? 'Newest first'
                            }
                        </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                        {ORDERS.map((option) => (
                            <SelectItem key={option.value} value={option.value}>
                                {option.label}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            </Labelled>

            {/*
                One switch: hide what has already been opened. "Already seen"
                still works from a link, but it is not a choice worth a slot
                in the bar.
            */}
            <span className="flex items-center gap-2 text-xs">
                <Switch
                    size="sm"
                    checked={value.seen === 'unseen'}
                    onCheckedChange={(checked) =>
                        onChange({
                            ...value,
                            seen: checked ? 'unseen' : undefined,
                        })
                    }
                    aria-label="Unseen only"
                />
                <span className="text-muted-foreground">Unseen only</span>
            </span>

            {durationEnabled ? (
                <Labelled label="Length">
                    <LengthRange
                        min={value.minDur}
                        max={value.maxDur}
                        onChange={(bounds) => onChange({ ...value, ...bounds })}
                    />
                </Labelled>
            ) : null}

            {/*
                The tags doing the filtering, spelled out. The rail says which
                are on, but the rail is a scroll away on a long list and gone
                entirely on a narrow screen — and a grid quietly narrowed by a
                tag you cannot see is the easiest way to think media is missing.
            */}
            {value.tags.length > 0 ? (
                <div className="flex min-w-0 flex-wrap items-center gap-1">
                    <TagIcon
                        className="text-muted-foreground size-3.5 shrink-0"
                        aria-hidden="true"
                    />
                    {/*
                        Only once there are two tags to combine. With one on,
                        Any and All name the same grid, and a control that
                        changes nothing reads as a broken one.
                    */}
                    {value.tags.length > 1 ? (
                        <div
                            role="group"
                            aria-label="Match stacked tags"
                            className="border-border mr-1 flex shrink-0 items-center gap-0.5 rounded-md border p-0.5"
                        >
                            {TAG_MATCHES.map((option) => (
                                <button
                                    key={option.value}
                                    type="button"
                                    aria-pressed={
                                        value.tagMatch === option.value
                                    }
                                    title={option.title}
                                    onClick={() =>
                                        onChange({
                                            ...value,
                                            tagMatch: option.value,
                                        })
                                    }
                                    className={cn(
                                        'rounded px-1.5 py-0.5 text-[11px] font-medium transition-colors duration-150',
                                        'focus-visible:ring-ring/50 outline-none focus-visible:ring-2',
                                        value.tagMatch === option.value
                                            ? 'bg-accent text-accent-foreground'
                                            : 'text-muted-foreground hover:text-foreground',
                                    )}
                                >
                                    {option.label}
                                </button>
                            ))}
                        </div>
                    ) : null}
                    {value.tags.map((name) => (
                        <Badge
                            key={name}
                            variant="secondary"
                            className="gap-1 pr-1 pl-2"
                        >
                            {name}
                            <button
                                type="button"
                                aria-label={`Stop filtering by ${name}`}
                                className="hover:bg-foreground/15 focus-visible:ring-ring/50 grid size-4 place-items-center rounded-full transition-colors outline-none focus-visible:ring-2"
                                onClick={() =>
                                    onChange({
                                        ...value,
                                        tags: value.tags.filter(
                                            (tag) => tag !== name,
                                        ),
                                    })
                                }
                            >
                                <X className="size-3" />
                            </button>
                        </Badge>
                    ))}
                </div>
            ) : null}

            {/*
                Tags only, and named for it. Order and length are one click from
                their own default in the control right there, and the category
                is a row in the rail — but stacked tags are the one filter that
                can pile up out of sight, so they are the one worth a way out.
            */}
            {value.tags.length > 0 || actions ? (
                <div className="ml-auto flex items-center gap-1">
                    {value.tags.length > 0 ? (
                        <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="text-muted-foreground"
                            onClick={() => onChange({ ...value, tags: [] })}
                        >
                            <X data-icon="inline-start" />
                            Clear tags
                        </Button>
                    ) : null}
                    {actions}
                </div>
            ) : null}
        </div>
    );
}

/** Says what the control next to it decides, since a value alone does not. */
/**
 * Clip length as a range: two handles over the length stops, right in the
 * bar, with the range read back beside them.
 *
 * The handles move a local draft and the filter only changes when one is let
 * go — every filter change is a fresh Telegram search, and a drag would
 * otherwise fire one per stop crossed.
 */
function LengthRange({
    min,
    max,
    onChange,
}: {
    min?: number;
    max?: number;
    onChange: (bounds: { minDur?: number; maxDur?: number }) => void;
}) {
    const committed = [nearestStop(min, 0), nearestStop(max, LAST_STOP)];
    const [draft, setDraft] = useState<number[] | null>(null);
    const stops = draft ?? committed;
    const shown = stopsToBounds(stops);
    const active = min !== undefined || max !== undefined;

    return (
        <span className="flex items-center gap-2">
            {/*
                Sized from outside: the slider fills its parent, and in a
                shrink-to-fit row "all of nothing" is zero wide.
            */}
            <span className="block w-28 shrink-0 px-1.5 sm:w-36">
                <Slider
                    min={0}
                    max={LAST_STOP}
                    step={1}
                    minStepsBetweenValues={1}
                    value={stops}
                    onValueChange={(next) =>
                        setDraft(Array.isArray(next) ? [...next] : [next])
                    }
                    onValueCommitted={(next) => {
                        setDraft(null);
                        onChange(
                            stopsToBounds(
                                Array.isArray(next) ? [...next] : [next],
                            ),
                        );
                    }}
                    aria-label="Length range"
                />
            </span>
            <span
                className={cn(
                    'min-w-16 text-xs tabular-nums',
                    active || draft
                        ? 'text-foreground'
                        : 'text-muted-foreground',
                )}
            >
                {lengthLabel(shown.minDur, shown.maxDur)}
            </span>
            {active ? (
                <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label="Any length"
                    title="Any length"
                    className="text-muted-foreground -ml-1"
                    onClick={() => {
                        setDraft(null);
                        onChange({ minDur: undefined, maxDur: undefined });
                    }}
                >
                    <X />
                </Button>
            ) : null}
        </span>
    );
}

function Labelled({ label, children }: { label: string; children: ReactNode }) {
    return (
        <span className="flex items-center gap-1.5">
            <span className="text-muted-foreground hidden text-xs sm:inline">
                {label}
            </span>
            {children}
        </span>
    );
}

function FilterHeading({ children }: { children: string }) {
    return (
        <p className="text-muted-foreground mt-4 mb-1 px-2.5 text-[11px] font-medium tracking-[0.14em] uppercase first:mt-0">
            {children}
        </p>
    );
}

/** One choice in the rail: a category, or one of the account's tags. */
function FilterRow({
    active,
    icon: Icon,
    label,
    count,
    title,
    mark: Mark,
    onClick,
}: {
    active: boolean;
    icon?: typeof ImageIcon;
    label: string;
    count?: number;
    title?: string;
    /** Trailing sign for what a click does, where that is not obvious. */
    mark?: typeof ImageIcon;
    onClick: () => void;
}) {
    return (
        <button
            type="button"
            aria-pressed={active}
            title={title}
            onClick={onClick}
            className={cn(
                'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors duration-150',
                'focus-visible:ring-ring/50 outline-none focus-visible:ring-2',
                active
                    ? 'bg-accent text-accent-foreground font-medium'
                    : 'text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground',
            )}
        >
            {Icon ? <Icon className="size-4 shrink-0" /> : null}
            <span className="min-w-0 flex-1 truncate">{label}</span>
            {typeof count === 'number' ? (
                <span className="text-[11px] tabular-nums opacity-70">
                    {count}
                </span>
            ) : null}
            {Mark ? (
                <Mark
                    className="size-3.5 shrink-0 opacity-60"
                    aria-hidden="true"
                />
            ) : null}
        </button>
    );
}
