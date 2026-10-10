/**
 * Finding a tag in a vocabulary, and deciding what order to show it in.
 *
 * Pure on purpose — no imports — so it runs under `node --test` the way
 * `upload/plan.ts` and `telegram/can-send.ts` do. It is all decidable from the
 * rows the page already holds, and it is where the fiddly cases live: a search
 * that should ignore a typed `#`, and a "most used" order that still has to
 * break ties predictably or the list reshuffles on every render.
 *
 * Filtering happens in memory, not in SQL, and that is deliberate:
 * `fetchTags()` already answers with the whole vocabulary in one grouped query,
 * so searching it costs nothing extra and needs no second read. Tag reads are
 * shaped to stay bounded by the size of the vocabulary, and this is downstream
 * of that.
 */

/** A tag as this file needs to see it. The page's `Tag` satisfies it. */
export type FilterableTag = {
    name: string;
    /** How much media carries it, across every chat. */
    count: number;
};

export type TagSort =
    /** Alphabetical, which is the order `fetchTags()` already returns. */
    | 'name'
    /** Busiest first, so the words actually in use come to the top. */
    | 'used';

export type TagFilter = {
    /** What was typed in the search box. Blank matches everything. */
    query: string;
    sort: TagSort;
};

export const DEFAULT_TAG_FILTER: TagFilter = {
    query: '',
    sort: 'name',
};

/**
 * Reduce a search box's contents to what should actually be matched.
 *
 * A leading `#` is stripped and the case is dropped, because that is how tags
 * are written everywhere else — someone who types `#Dog` looking for `dog` is
 * not making a mistake, and `normaliseTag()` would refuse the input outright
 * for a partial word.
 */
export function normaliseTagQuery(query: string): string {
    return query.trim().replace(/^#+/, '').trim().toLowerCase();
}

/** Whether one tag survives the current filter. */
export function matchesTagFilter(
    tag: FilterableTag,
    filter: TagFilter,
): boolean {
    const needle = normaliseTagQuery(filter.query);

    // A substring, not a prefix: a vocabulary is a flat list of words, and
    // "berlin" should find "catsofberlin".
    return needle === '' || tag.name.toLowerCase().includes(needle);
}

/**
 * The vocabulary as the screen should show it.
 *
 * Never mutates the array it is given — the page holds that same array as
 * state, and sorting it in place would reorder the source behind React's back.
 */
export function filterTags<T extends FilterableTag>(
    tags: readonly T[],
    filter: TagFilter,
): T[] {
    const matching = tags.filter((tag) => matchesTagFilter(tag, filter));

    return matching.sort((a, b) =>
        filter.sort === 'used'
            ? // Ties fall back to the name so the order is stable: an account
              // whose tags are all unused would otherwise shuffle on every
              // sort, which reads as a bug.
              b.count - a.count || a.name.localeCompare(b.name)
            : a.name.localeCompare(b.name),
    );
}
