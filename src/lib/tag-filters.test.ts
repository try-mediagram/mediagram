import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    DEFAULT_TAG_FILTER,
    type FilterableTag,
    filterTags,
    matchesTagFilter,
    normaliseTagQuery,
    type TagFilter,
} from './tag-filters.ts';

function tag(over: Partial<FilterableTag> = {}): FilterableTag {
    return { name: 'dog', count: 0, ...over };
}

function filter(over: Partial<TagFilter> = {}): TagFilter {
    return { ...DEFAULT_TAG_FILTER, ...over };
}

describe('normaliseTagQuery', () => {
    it('drops case, padding and a typed hash', () => {
        // `#Dog` is how a tag is written everywhere else, so someone typing it
        // into the search box is not making a mistake.
        assert.equal(normaliseTagQuery('  #Dog '), 'dog');
        assert.equal(normaliseTagQuery('##DOG'), 'dog');
    });

    it('is empty for nothing typed', () => {
        assert.equal(normaliseTagQuery('   '), '');
    });
});

describe('matchesTagFilter', () => {
    it('matches anywhere in the word, not just the start', () => {
        const berlin = tag({ name: 'catsofberlin' });
        assert.equal(
            matchesTagFilter(berlin, filter({ query: 'berlin' })),
            true,
        );
        assert.equal(matchesTagFilter(berlin, filter({ query: 'cats' })), true);
        assert.equal(
            matchesTagFilter(berlin, filter({ query: 'paris' })),
            false,
        );
    });

    it('keeps everything when nothing is typed', () => {
        assert.equal(matchesTagFilter(tag(), filter({ query: '  ' })), true);
    });
});

describe('filterTags', () => {
    const vocabulary: FilterableTag[] = [
        tag({ name: 'dog', count: 5 }),
        tag({ name: 'berlin', count: 40 }),
        tag({ name: 'cat', count: 5 }),
    ];

    it('sorts alphabetically by default', () => {
        assert.deepEqual(
            filterTags(vocabulary, filter()).map((found) => found.name),
            ['berlin', 'cat', 'dog'],
        );
    });

    it('sorts busiest first, breaking ties by name so the order is stable', () => {
        assert.deepEqual(
            filterTags(vocabulary, filter({ sort: 'used' })).map(
                (found) => found.name,
            ),
            ['berlin', 'cat', 'dog'],
        );
    });

    it('never reorders the array it was given', () => {
        // The page holds this same array as state; sorting in place would
        // reorder the source behind React's back.
        const held = [...vocabulary];
        filterTags(held, filter({ sort: 'used' }));
        assert.deepEqual(
            held.map((found) => found.name),
            ['dog', 'berlin', 'cat'],
        );
    });

    it('answers with nothing when a search matches nothing', () => {
        assert.deepEqual(filterTags(vocabulary, filter({ query: 'zzz' })), []);
    });
});
