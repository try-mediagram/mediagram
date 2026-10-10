import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseChatTarget } from './chat-target.ts';

describe('parseChatTarget', () => {
    it('reads a private invite in every shape Telegram writes one', () => {
        for (const input of [
            'https://t.me/+J4KzxzcvMbRjN2Ix',
            'http://t.me/+J4KzxzcvMbRjN2Ix',
            't.me/+J4KzxzcvMbRjN2Ix',
            'https://www.t.me/+J4KzxzcvMbRjN2Ix',
            'https://telegram.me/+J4KzxzcvMbRjN2Ix',
            '  https://t.me/+J4KzxzcvMbRjN2Ix  ',
        ]) {
            assert.deepEqual(
                parseChatTarget(input),
                {
                    kind: 'invite',
                    hash: 'J4KzxzcvMbRjN2Ix',
                    link: 'https://t.me/+J4KzxzcvMbRjN2Ix',
                },
                input,
            );
        }
    });

    it('reads the older joinchat form and tg:// deep links', () => {
        assert.deepEqual(
            parseChatTarget('https://t.me/joinchat/AAAAAE0aBBBB'),
            {
                kind: 'invite',
                hash: 'AAAAAE0aBBBB',
                link: 'https://t.me/joinchat/AAAAAE0aBBBB',
            },
        );
        assert.deepEqual(parseChatTarget('tg://join?invite=J4KzxzcvMbRjN2Ix'), {
            kind: 'invite',
            hash: 'J4KzxzcvMbRjN2Ix',
            link: 'https://t.me/+J4KzxzcvMbRjN2Ix',
        });
        assert.deepEqual(parseChatTarget('tg://resolve?domain=durov'), {
            kind: 'username',
            username: 'durov',
        });
    });

    it('reads a handle with or without the @, and lowercases it', () => {
        for (const input of ['@durov', 'durov', 'Durov', '@Durov']) {
            assert.deepEqual(
                parseChatTarget(input),
                { kind: 'username', username: 'durov' },
                input,
            );
        }
    });

    it('reads a public link, ignoring the message and any query', () => {
        for (const input of [
            'https://t.me/durov',
            'https://t.me/durov/123',
            'https://t.me/durov?single',
            'https://t.me/s/durov',
            't.me/durov/',
        ]) {
            assert.deepEqual(
                parseChatTarget(input),
                { kind: 'username', username: 'durov' },
                input,
            );
        }
    });

    it('puts the -100 mark back on a t.me/c link', () => {
        // t.me/c strips the mark Telegram's own ids carry, and /c/{chatId}
        // needs it back or the route matches a completely different peer.
        assert.deepEqual(parseChatTarget('https://t.me/c/1234567890/45'), {
            kind: 'id',
            chatId: -1001234567890,
        });
        assert.deepEqual(parseChatTarget('t.me/c/1234567890'), {
            kind: 'id',
            chatId: -1001234567890,
        });
    });

    it('reads a marked id pasted on its own', () => {
        assert.deepEqual(parseChatTarget('-1001234567890'), {
            kind: 'id',
            chatId: -1001234567890,
        });
        assert.deepEqual(parseChatTarget('123456789'), {
            kind: 'id',
            chatId: 123456789,
        });
    });

    it('refuses t.me paths that are features rather than handles', () => {
        // These resolve to a real page on t.me and to nothing at all here;
        // treating "addstickers" as somebody's handle would send a request for
        // a peer that cannot exist.
        for (const input of [
            'https://t.me/addstickers/somepack',
            'https://t.me/proxy?server=1',
            'https://t.me/socks?server=1',
            'https://t.me/login/12345',
            'https://t.me/iv?url=x',
        ]) {
            assert.equal(parseChatTarget(input), null, input);
        }
    });

    it('refuses anything that is not a chat', () => {
        for (const input of [
            '',
            '   ',
            'ab',
            '@ab',
            'https://example.com/durov',
            'https://t.me/',
            'hello world',
            '1234',
            'tg://something?else=1',
        ]) {
            assert.equal(parseChatTarget(input), null, JSON.stringify(input));
        }
    });
});
