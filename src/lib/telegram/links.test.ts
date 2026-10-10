import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { telegramChatLink, telegramMessageLink } from './links.ts';

describe('telegramChatLink', () => {
    it('addresses a public chat by its username', () => {
        assert.equal(
            telegramChatLink(-1001234567890, 'durov'),
            'https://t.me/durov',
        );
    });

    it('strips the -100 marker from a channel id', () => {
        assert.equal(
            telegramChatLink(-1001234567890),
            'https://t.me/c/1234567890',
        );
    });

    it('strips the plain minus from a legacy group id', () => {
        assert.equal(telegramChatLink(-98765, null), 'https://t.me/c/98765');
    });
});

describe('telegramMessageLink', () => {
    it('hangs the message id off the chat link', () => {
        assert.equal(
            telegramMessageLink(-1001234567890, 42, 'durov'),
            'https://t.me/durov/42',
        );
        assert.equal(
            telegramMessageLink(-1001234567890, 42),
            'https://t.me/c/1234567890/42',
        );
    });
});
