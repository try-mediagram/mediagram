import { getRouteApi } from '@tanstack/react-router';
import { useCallback, useMemo } from 'react';

import type { MediaSearchState } from '@/components/media-filters';
import { normaliseTag } from '@/lib/media-tags';
import type { MediaOrder, MediaTypeFilter } from '@/lib/telegram/types';

/**
 * The chat route's query string, flat and as written, so a link keeps the
 * exact shape the original app gave it: `?type=video&tags=dog,cat&match=all`.
 */
export type MediaSearchParams = {
    type?: string;
    order?: string;
    minDur?: number;
    maxDur?: number;
    tags?: string;
    /** What older links carry instead of `tags`. */
    tag?: string;
    match?: string;
    q?: string;
    seen?: string;
};

const chatRoute = getRouteApi('/c/$chatId');

/**
 * Keeps the media filters in the URL.
 *
 * Filtering is entirely client-side, so each change replaces the history entry
 * rather than pushing one, matching the replace-navigation the original app
 * used. Going through the router (not `history.replaceState`) keeps its idea
 * of the location in step with the address bar.
 */
export function useMediaFilters(): [
    MediaSearchState,
    (next: MediaSearchState) => void,
] {
    const search = chatRoute.useSearch();
    const navigate = chatRoute.useNavigate();

    const filters = useMemo(() => parse(search), [search]);

    const update = useCallback(
        (next: MediaSearchState) => {
            void navigate({ search: serialise(next), replace: true });
        },
        [navigate],
    );

    return [filters, update];
}

/** Accept whatever is in the address bar, keeping only what is meaningful. */
export function validateMediaSearch(
    raw: Record<string, unknown>,
): MediaSearchParams {
    const text = (value: unknown): string | undefined =>
        typeof value === 'string' && value !== '' ? value : undefined;

    return {
        type: text(raw.type),
        order: text(raw.order),
        minDur: parseNumber(raw.minDur),
        maxDur: parseNumber(raw.maxDur),
        tags:
            text(raw.tags) ??
            (Array.isArray(raw.tags) ? raw.tags.join(',') : undefined),
        tag: text(raw.tag),
        match: text(raw.match),
        q:
            text(raw.q) ??
            (typeof raw.q === 'number' ? String(raw.q) : undefined),
        seen: text(raw.seen),
    };
}

function serialise(next: MediaSearchState): MediaSearchParams {
    return {
        type: next.type,
        order: next.order,
        minDur: next.minDur,
        maxDur: next.maxDur,
        tags: next.tags.length > 0 ? next.tags.join(',') : undefined,
        // Written only when it changes what the link means, so a plain union
        // stays the url it has always been.
        match:
            next.tags.length > 0 && next.tagMatch === 'all' ? 'all' : undefined,
        q: next.query || undefined,
        seen: next.seen,
    };
}

function parse(search: MediaSearchParams): MediaSearchState {
    return {
        type: parseType(search.type),
        order: parseOrder(search.order),
        minDur: search.minDur,
        maxDur: search.maxDur,
        tags: parseTags(search),
        // Anything but an explicit `all` is the union, which is what every link
        // written before the mode existed already carries.
        tagMatch: search.match === 'all' ? 'all' : 'any',
        query: search.q?.trim() || undefined,
        seen:
            search.seen === 'unseen' || search.seen === 'seen'
                ? search.seen
                : undefined,
    };
}

/**
 * `tags` is the list; `tag` is what older links carry, and one of them is still
 * a perfectly good filter.
 */
function parseTags(search: MediaSearchParams): string[] {
    const raw = search.tags ?? search.tag ?? '';

    return [
        ...new Set(
            raw
                .split(',')
                .map((name) => normaliseTag(name))
                .filter((name): name is string => name !== null),
        ),
    ];
}

/**
 * Older links carry a kind rather than a category — `gif` and `voice` were
 * their own filters once. They fold into the category that now shows them
 * rather than silently resetting to everything.
 */
function parseType(value: unknown): MediaTypeFilter {
    switch (value) {
        case 'photo':
            return 'photo';
        case 'video':
        case 'gif':
            return 'video';
        case 'audio':
        case 'voice':
            return 'audio';
        default:
            return 'all';
    }
}

function parseOrder(value: unknown): MediaOrder {
    return value === 'old' ? 'old' : 'new';
}

function parseNumber(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value !== '') {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) return parsed;
    }
    return undefined;
}
