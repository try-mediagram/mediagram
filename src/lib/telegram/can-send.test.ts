import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    checkCanSendMedia,
    checkCanWrite,
    combineRights,
    describeSendBlock,
    type SendBlock,
    type SendTarget,
} from './can-send.ts';

function target(over: Partial<SendTarget> = {}): SendTarget {
    return {
        kind: 'group',
        isMember: true,
        isBanned: false,
        isCreator: false,
        isAdmin: false,
        canPostAsAdmin: false,
        memberCanSendMedia: null,
        memberCanSendText: null,
        ...over,
    };
}

describe('checkCanSendMedia — people', () => {
    it('always allows a conversation with a person or a bot', () => {
        // Being blocked is not on the peer, so guessing would hide the button
        // on chats that work.
        const verdict = checkCanSendMedia(
            target({
                kind: 'user',
                isMember: false,
                memberCanSendMedia: false,
            }),
        );
        assert.deepEqual(verdict, { allowed: true });
    });
});

describe('checkCanSendMedia — broadcast channels', () => {
    it('refuses an ordinary subscriber', () => {
        const verdict = checkCanSendMedia(target({ kind: 'broadcast' }));
        assert.deepEqual(verdict, {
            allowed: false,
            reason: 'broadcast-readonly',
        });
    });

    it('allows an admin who may post', () => {
        const verdict = checkCanSendMedia(
            target({ kind: 'broadcast', isAdmin: true, canPostAsAdmin: true }),
        );
        assert.equal(verdict.allowed, true);
    });

    it('refuses an admin without posting rights', () => {
        // An admin who can only ban users is not an admin who can publish.
        const verdict = checkCanSendMedia(
            target({ kind: 'broadcast', isAdmin: true, canPostAsAdmin: false }),
        );
        assert.deepEqual(verdict, {
            allowed: false,
            reason: 'broadcast-readonly',
        });
    });

    it('allows the owner regardless of the rights flags', () => {
        const verdict = checkCanSendMedia(
            target({ kind: 'broadcast', isCreator: true }),
        );
        assert.equal(verdict.allowed, true);
    });
});

describe('checkCanSendMedia — groups', () => {
    it('allows a member when nothing is restricted', () => {
        assert.equal(checkCanSendMedia(target()).allowed, true);
    });

    it('refuses a member when the chat bans media', () => {
        const verdict = checkCanSendMedia(
            target({ memberCanSendMedia: false }),
        );
        assert.deepEqual(verdict, {
            allowed: false,
            reason: 'media-restricted',
        });
    });

    it('lets an admin past a media ban aimed at members', () => {
        const verdict = checkCanSendMedia(
            target({ isAdmin: true, memberCanSendMedia: false }),
        );
        assert.equal(verdict.allowed, true);
    });

    it('treats an unstated permission as permitted, not denied', () => {
        // Telegram not saying is not Telegram refusing. Let it answer.
        assert.equal(
            checkCanSendMedia(target({ memberCanSendMedia: null })).allowed,
            true,
        );
    });
});

describe('checkCanSendMedia — membership', () => {
    it('refuses a public chat that can be read without joining', () => {
        const verdict = checkCanSendMedia(target({ isMember: false }));
        assert.deepEqual(verdict, { allowed: false, reason: 'not-member' });
    });

    it('reports a ban ahead of anything else', () => {
        const verdict = checkCanSendMedia(
            target({ isBanned: true, isMember: false, isCreator: true }),
        );
        assert.deepEqual(verdict, { allowed: false, reason: 'banned' });
    });

    it('refuses a broadcast the account has not joined', () => {
        const verdict = checkCanSendMedia(
            target({ kind: 'broadcast', isMember: false, isCreator: true }),
        );
        assert.deepEqual(verdict, { allowed: false, reason: 'not-member' });
    });
});

describe('describeSendBlock', () => {
    it('has a sentence for every reason', () => {
        const reasons: SendBlock[] = [
            'banned',
            'not-member',
            'broadcast-readonly',
            'media-restricted',
        ];
        for (const reason of reasons) {
            assert.ok(describeSendBlock(reason).length > 0);
        }
    });
});

describe('checkCanWrite', () => {
    it('refuses a muted group to an ordinary member', () => {
        assert.deepEqual(checkCanWrite(target({ memberCanSendText: false })), {
            allowed: false,
            reason: 'text-restricted',
        });
    });

    it('lets an admin write in a muted group', () => {
        assert.deepEqual(
            checkCanWrite(target({ memberCanSendText: false, isAdmin: true })),
            { allowed: true },
        );
    });

    it('keeps the box where only media is banned', () => {
        assert.deepEqual(
            checkCanWrite(
                target({ memberCanSendMedia: false, memberCanSendText: true }),
            ),
            { allowed: true },
        );
    });

    it('refuses a broadcast channel to a non-posting member', () => {
        assert.deepEqual(checkCanWrite(target({ kind: 'broadcast' })), {
            allowed: false,
            reason: 'broadcast-readonly',
        });
    });
});

describe('combineRights', () => {
    it('lets either side say no', () => {
        assert.equal(combineRights(true, false), false);
        assert.equal(combineRights(false, true), false);
        assert.equal(combineRights(null, false), false);
        assert.equal(combineRights(true, true), true);
        assert.equal(combineRights(undefined, true), true);
    });

    it('stays unknown when neither side said', () => {
        assert.equal(combineRights(null, undefined), null);
    });
});
