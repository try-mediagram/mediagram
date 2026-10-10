import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    applyChosenReactions,
    buildReactionRow,
    displayReaction,
    isReactionAllowed,
    nextChosenReactions,
    normalizeReaction,
    sameReaction,
    spellAsChat,
} from './reactions.ts';

describe('normalizeReaction', () => {
    it('drops the emoji-presentation selector Telegram does not use', () => {
        assert.equal(normalizeReaction('❤️'), '❤');
        assert.equal(normalizeReaction('❤'), '❤');
    });

    it('matches the two spellings of the same reaction', () => {
        assert.ok(sameReaction('❤️', '❤'));
        assert.ok(!sameReaction('❤', '🔥'));
    });
});

describe('isReactionAllowed', () => {
    it('allows anything while the chat has not answered', () => {
        assert.ok(isReactionAllowed('🔥', null));
    });

    it('allows nothing when the chat has reactions switched off', () => {
        assert.ok(!isReactionAllowed('🔥', []));
    });

    it('ignores the selector when checking the chat list', () => {
        assert.ok(isReactionAllowed('❤️', ['❤', '🔥']));
        assert.ok(!isReactionAllowed('👏', ['❤', '🔥']));
    });
});

describe('buildReactionRow', () => {
    it('offers only what the chat takes', () => {
        const row = buildReactionRow([], ['❤', '🔥']);

        assert.deepEqual(
            row.map((item) => item.emoji),
            ['❤', '🔥'],
        );
        assert.ok(row.every((item) => item.sendable));
    });

    it('keeps a reaction the chat no longer takes, but not as a button', () => {
        const row = buildReactionRow(
            [{ emoji: '👏', count: 3, chosen: false }],
            ['❤'],
        );

        assert.deepEqual(
            row.map((item) => [item.emoji, item.sendable]),
            [
                ['👏', false],
                ['❤', true],
            ],
        );
    });

    it('offers nothing at all when reactions are off', () => {
        const row = buildReactionRow([], []);
        assert.deepEqual(row, []);
    });

    it('falls back to Telegram’s own set before the chat has answered', () => {
        const row = buildReactionRow([], null);
        assert.ok(row.length > 0);
        assert.ok(row.every((item) => item.sendable));
    });

    it('stops at the limit without dropping what is already there', () => {
        const existing = [
            { emoji: '👏', count: 1, chosen: false },
            { emoji: '😁', count: 2, chosen: false },
        ];

        assert.equal(buildReactionRow(existing, ['🔥', '❤'], 3).length, 3);
        assert.equal(buildReactionRow(existing, ['🔥', '❤'], 1).length, 2);
    });
});

describe('spellAsChat', () => {
    it('sends the chat’s own spelling of the reaction', () => {
        assert.equal(spellAsChat('❤', ['❤️', '🔥']), '❤️');
        assert.equal(spellAsChat('❤️', ['❤', '🔥']), '❤');
    });

    it('leaves a reaction the chat does not list alone', () => {
        assert.equal(spellAsChat('👏', ['❤']), '👏');
        assert.equal(spellAsChat('👏', null), '👏');
    });
});

describe('nextChosenReactions', () => {
    it('sends one reaction on an account that may only leave one', () => {
        const { chosen, adding } = nextChosenReactions(
            [{ emoji: '❤', count: 4, chosen: true }],
            '🔥',
            1,
        );

        assert.deepEqual(chosen, ['🔥']);
        assert.ok(adding);
    });

    it('keeps the older ones up to the account’s limit', () => {
        const { chosen } = nextChosenReactions(
            [
                { emoji: '❤', count: 4, chosen: true },
                { emoji: '👏', count: 2, chosen: true },
            ],
            '🔥',
            3,
        );

        assert.deepEqual(chosen, ['❤', '👏', '🔥']);
    });

    it('drops the oldest once the limit is reached', () => {
        const { chosen } = nextChosenReactions(
            [
                { emoji: '❤', count: 4, chosen: true },
                { emoji: '👏', count: 2, chosen: true },
            ],
            '🔥',
            2,
        );

        assert.deepEqual(chosen, ['👏', '🔥']);
    });

    it('takes a reaction back, spelled either way', () => {
        const { chosen, adding } = nextChosenReactions(
            [{ emoji: '❤', count: 4, chosen: true }],
            '❤️',
            3,
        );

        assert.deepEqual(chosen, []);
        assert.ok(!adding);
    });
});

describe('applyChosenReactions', () => {
    it('moves the count from the displaced reaction to the new one', () => {
        const next = applyChosenReactions(
            [
                { emoji: '❤', count: 4, chosen: true },
                { emoji: '🔥', count: 2, chosen: false },
            ],
            ['🔥'],
        );

        assert.deepEqual(next, [
            { emoji: '❤', count: 3, chosen: false },
            { emoji: '🔥', count: 3, chosen: true },
        ]);
    });

    it('drops a reaction that was only ours', () => {
        const next = applyChosenReactions(
            [{ emoji: '❤', count: 1, chosen: true }],
            [],
        );

        assert.deepEqual(next, []);
    });

    it('adds one the message did not have yet', () => {
        const next = applyChosenReactions([], ['🔥']);

        assert.deepEqual(next, [{ emoji: '🔥', count: 1, chosen: true }]);
    });
});

describe('displayReaction', () => {
    it('draws the bare server heart as the red emoji', () => {
        assert.equal(displayReaction('❤'), '❤️');
    });

    it('leaves emoji that already draw in colour alone', () => {
        assert.equal(displayReaction('👍'), '👍');
        assert.equal(displayReaction('🔥'), '🔥');
    });

    it('does not double the selector', () => {
        assert.equal(displayReaction('❤️'), '❤️');
    });

    it('restores the selector inside a ZWJ sequence', () => {
        assert.equal(displayReaction('❤‍🔥'), '❤️‍🔥');
        assert.equal(displayReaction('❤️‍🔥'), '❤️‍🔥');
    });

    it('leaves a skin-toned base without a selector', () => {
        assert.equal(displayReaction('☝🏻'), '☝🏻');
    });
});
