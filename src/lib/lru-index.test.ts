import assert from 'node:assert/strict';
import { test } from 'node:test';

import { touchLru } from './lru-index.ts';

test('adds a key as the most recent', () => {
    assert.deepEqual(touchLru(['a', 'b'], 'c', 5), {
        index: ['a', 'b', 'c'],
        evicted: [],
    });
});

test('moves a key it already has to the end instead of repeating it', () => {
    assert.deepEqual(touchLru(['a', 'b', 'c'], 'a', 5), {
        index: ['b', 'c', 'a'],
        evicted: [],
    });
});

test('evicts the oldest keys past the cap', () => {
    assert.deepEqual(touchLru(['a', 'b', 'c'], 'd', 2), {
        index: ['c', 'd'],
        evicted: ['a', 'b'],
    });
});
