import { tl } from '@mtcute/web';

export function isAbortError(error: unknown): boolean {
    return (
        (error instanceof DOMException && error.name === 'AbortError') ||
        (error instanceof Error &&
            (error.name === 'AbortError' ||
                error.message.toLowerCase().includes('aborted')))
    );
}

export function isFileRefError(error: unknown): boolean {
    return (
        tl.RpcError.is(error, 'FILE_REFERENCE_EXPIRED') ||
        tl.RpcError.is(error, 'FILE_REFERENCE_INVALID') ||
        tl.RpcError.is(error, 'FILEREF_UPGRADE_NEEDED')
    );
}

/**
 * Telegram refused a message because this account may not write here — a
 * muted group, a channel only admins post to, a ban. The chat's own flags
 * predict most of these (can-send.ts), but not all, so the message box also
 * believes Telegram's answer once it has been given.
 */
export function isWriteForbiddenError(error: unknown): boolean {
    return [
        'CHAT_WRITE_FORBIDDEN',
        'CHAT_ADMIN_REQUIRED',
        'CHAT_SEND_PLAIN_FORBIDDEN',
        'CHAT_RESTRICTED',
        'CHAT_GUEST_SEND_FORBIDDEN',
        'USER_BANNED_IN_CHANNEL',
    ].some((code) => tl.RpcError.is(error, code));
}

/**
 * Telegram has ended this session from its own side — the device signed out in
 * Settings → Devices, a session that expired, or an account that no longer
 * exists.
 *
 * Worth its own predicate because it is the one error the browser must not
 * simply report: the auth key is gone, so the local session it vouched for
 * has to go with it. See `telegram-provider.tsx`.
 */
export function isSessionRevokedError(error: unknown): boolean {
    return (
        tl.RpcError.is(error, 'AUTH_KEY_UNREGISTERED') ||
        tl.RpcError.is(error, 'SESSION_REVOKED') ||
        tl.RpcError.is(error, 'SESSION_EXPIRED')
    );
}

/**
 * The chat is not coming back: a revoked or expired invite, or one we are not
 * allowed to look at any more. Worth telling apart from a dropped connection,
 * because it is the difference between retrying and giving up.
 */
export function isChatGoneError(error: unknown): boolean {
    return (
        tl.RpcError.is(error, 'INVITE_HASH_EXPIRED') ||
        tl.RpcError.is(error, 'INVITE_HASH_INVALID') ||
        tl.RpcError.is(error, 'CHANNEL_PRIVATE')
    );
}

export function floodWaitSeconds(error: unknown): number | null {
    if (tl.RpcError.is(error, 'FLOOD_WAIT_%d')) return error.seconds;
    return null;
}

export function describeTelegramError(error: unknown): string {
    if (tl.RpcError.is(error, 'API_ID_INVALID')) {
        return 'That api_id / api_hash pair is not valid.';
    }
    if (tl.RpcError.is(error, 'PHONE_NUMBER_INVALID')) {
        return 'That phone number does not look valid. Use international format, like +15551234567.';
    }
    if (
        tl.RpcError.is(error, 'PHONE_CODE_INVALID') ||
        tl.RpcError.is(error, 'PHONE_CODE_EXPIRED')
    ) {
        return 'That login code is wrong or expired.';
    }
    if (tl.RpcError.is(error, 'PASSWORD_HASH_INVALID')) {
        return 'That 2FA password is not correct.';
    }
    if (isSessionRevokedError(error)) {
        return 'This session was revoked. Scan the QR code again.';
    }
    if (
        tl.RpcError.is(error, 'INVITE_HASH_EXPIRED') ||
        tl.RpcError.is(error, 'INVITE_HASH_INVALID')
    ) {
        return 'That invite link is no longer valid. Ask for a fresh one.';
    }
    if (tl.RpcError.is(error, 'USER_ALREADY_PARTICIPANT')) {
        return 'You are already in this chat.';
    }
    if (
        tl.RpcError.is(error, 'USERNAME_NOT_OCCUPIED') ||
        tl.RpcError.is(error, 'USERNAME_INVALID')
    ) {
        return 'No Telegram chat has that handle.';
    }
    if (tl.RpcError.is(error, 'CHANNELS_TOO_MUCH')) {
        return 'Telegram will not let this account join any more channels. Leave one first.';
    }
    if (tl.RpcError.is(error, 'CHANNEL_PRIVATE')) {
        return 'This chat is private. You need an invite link to open it.';
    }
    if (tl.RpcError.is(error, 'REACTION_INVALID')) {
        return 'This chat does not take that reaction.';
    }
    if (
        tl.RpcError.is(error, 'REACTIONS_TOO_MANY') ||
        tl.RpcError.is(error, 'CUSTOM_REACTIONS_TOO_MANY')
    ) {
        return 'Telegram Premium is what lets one account leave more than one reaction.';
    }
    if (tl.RpcError.is(error, 'INVITE_REQUEST_SENT')) {
        return 'Your request to join is waiting for an admin.';
    }
    const wait = floodWaitSeconds(error);
    if (wait !== null) {
        return `Telegram is rate-limiting this account. Try again in ${wait}s.`;
    }
    if (error instanceof Error) return error.message;
    return 'Something went wrong talking to Telegram.';
}

export async function withFloodWait<T>(
    fn: () => Promise<T>,
    onWait?: (seconds: number) => void,
): Promise<T> {
    for (;;) {
        try {
            return await fn();
        } catch (error) {
            const seconds = floodWaitSeconds(error);
            if (seconds === null) throw error;
            onWait?.(seconds);
            await new Promise((resolve) =>
                setTimeout(resolve, (seconds + 1) * 1000),
            );
        }
    }
}
