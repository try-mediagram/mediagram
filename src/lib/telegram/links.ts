/**
 * Telegram's own web links for a chat, and for one message inside it.
 *
 * Pure string work that imports nothing — the same reason `chat-target.ts`
 * stays on its own: it can be unit tested without a session, and anything that
 * only wants a link never pulls mtcute into its chunk.
 */

const BASE = 'https://t.me';

/**
 * The id t.me/c wants: Telegram marks a channel `-100…` and a legacy group
 * with a plain minus, and neither sign belongs in the url.
 */
function internalId(chatId: number): string {
    const marked = String(chatId);
    return marked.startsWith('-100')
        ? marked.slice(4)
        : marked.replace('-', '');
}

/**
 * A public chat is addressed by its @username; anything else falls back to
 * t.me/c/{id}, which opens in a client where the account is already a member.
 */
export function telegramChatLink(
    chatId: number,
    username?: string | null,
): string {
    return username ? `${BASE}/${username}` : `${BASE}/c/${internalId(chatId)}`;
}

/** The same chat, scrolled to one message. */
export function telegramMessageLink(
    chatId: number,
    messageId: number,
    username?: string | null,
): string {
    return `${telegramChatLink(chatId, username)}/${messageId}`;
}
