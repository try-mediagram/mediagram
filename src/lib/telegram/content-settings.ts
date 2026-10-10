import { getClient } from '@/lib/telegram/client';
import { withFloodWait } from '@/lib/telegram/errors';
import { debug } from '@/lib/debug';

/**
 * Telegram's account-level sensitive-content filter.
 *
 * This is the same switch Telegram Desktop and the Android build expose under
 * Privacy and Security → Sensitive content. It lives on the account, not on
 * this app: flipping it here is the same act as flipping it there, and it stays
 * flipped everywhere afterwards.
 *
 * It matters because `restrictions[]` on the peer is only half the story. With
 * the filter on, Telegram withholds the content itself, so a chat we were
 * willing to render would come back empty. Reading the peer's flag tells us a
 * chat is adult; this tells us whether Telegram will actually serve it.
 *
 * `canChange` is Telegram's answer, not ours — it comes back false where the
 * account has not met whatever age or region requirement applies, and no amount
 * of asking will move it. Surface that rather than retrying.
 */
export type ContentSettings = {
    /** Telegram will serve sensitive content to this account. */
    enabled: boolean;
    /** Telegram will let this account change the setting at all. */
    canChange: boolean;
};

export async function getContentSettings(): Promise<ContentSettings> {
    const result = await withFloodWait(() =>
        getClient().call({ _: 'account.getContentSettings' }),
    );

    return {
        enabled: result.sensitiveEnabled ?? false,
        canChange: result.sensitiveCanChange ?? false,
    };
}

/**
 * Turn the filter off if it is on and Telegram allows it.
 *
 * Resolves to the settings as they stand afterwards, so a caller that gets back
 * `{ enabled: false, canChange: false }` knows to explain rather than retry.
 */
export async function ensureSensitiveEnabled(): Promise<ContentSettings> {
    const current = await getContentSettings();
    debug('gate', 'content settings', current);

    if (current.enabled || !current.canChange) return current;

    await withFloodWait(() =>
        getClient().call({
            _: 'account.setContentSettings',
            sensitiveEnabled: true,
        }),
    );
    debug('gate', 'sensitive content enabled on the account');

    return { enabled: true, canChange: true };
}
