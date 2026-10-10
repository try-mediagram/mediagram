import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { mentionsJoin } from './join-updates.ts';

describe('mentionsJoin', () => {
    it('reads the one update inside an updateShort', () => {
        assert.ok(
            mentionsJoin({
                _: 'updateShort',
                update: { _: 'updateChannel', channelId: 1234 },
                date: 0,
            }),
        );
    });

    it('reads a list of updates', () => {
        assert.ok(
            mentionsJoin({
                _: 'updates',
                updates: [
                    { _: 'updateReadChannelInbox' },
                    { _: 'updateChannelParticipant' },
                ],
            }),
        );
    });

    it('ignores traffic that says nothing about membership', () => {
        assert.ok(
            !mentionsJoin({
                _: 'updates',
                updates: [
                    { _: 'updateUserStatus' },
                    { _: 'updateDraftMessage' },
                ],
            }),
        );
        assert.ok(!mentionsJoin({ _: 'updateShort', update: null }));
        assert.ok(!mentionsJoin(null));
        assert.ok(!mentionsJoin('updateChannel'));
    });
});
