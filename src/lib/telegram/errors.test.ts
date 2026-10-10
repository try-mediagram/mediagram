import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { tl } from '@mtcute/web';

import { describeTelegramError, isSessionRevokedError } from './errors.ts';

/*
 * This predicate decides whether an error is reported or acted on: a revoked
 * key ends the Laravel session too, so a false positive signs a working
 * session out and a false negative leaves a killed device signed in.
 */
describe('isSessionRevokedError', () => {
    it('knows the ways Telegram says the key is dead', () => {
        for (const text of [
            'AUTH_KEY_UNREGISTERED',
            'SESSION_REVOKED',
            'SESSION_EXPIRED',
        ] as const) {
            assert.ok(isSessionRevokedError(new tl.RpcError(401, text)), text);
        }
    });

    it('leaves every other failure to be reported', () => {
        assert.ok(
            !isSessionRevokedError(new tl.RpcError(400, 'CHANNEL_PRIVATE')),
        );
        assert.ok(
            !isSessionRevokedError(new tl.RpcError(420, 'FLOOD_WAIT_%d')),
        );
        assert.ok(!isSessionRevokedError(new Error('offline')));
        assert.ok(!isSessionRevokedError(null));
    });

    it('is the same set the sentence on screen is written for', () => {
        assert.equal(
            describeTelegramError(new tl.RpcError(401, 'SESSION_EXPIRED')),
            'This session was revoked. Scan the QR code again.',
        );
    });
});
