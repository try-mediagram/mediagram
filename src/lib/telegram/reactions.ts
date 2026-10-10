/**
 * What a message can be reacted with, and what pressing one means.
 *
 * Pure on purpose — no mtcute, no client, no imports — so it reads under
 * `node --test` the way chat-target.ts does. The half that talks to Telegram
 * lives in thread.ts.
 */

/** A reaction as it stands on a message. */
export type ReactionCount = {
    emoji: string;
    count: number;
    chosen: boolean;
};

/** One button in the row: a reaction, and whether it can be pressed. */
export type ReactionChoice = ReactionCount & {
    /** The chat takes this one, so pressing it will not be rejected. */
    sendable: boolean;
};

/**
 * Telegram's opening set, in its own spelling, for the moment before the
 * chat's own list has landed. Note the bare `❤` — see `normalizeReaction`.
 */
export const FALLBACK_REACTIONS = [
    '👍',
    '👎',
    '❤',
    '🔥',
    '🥰',
    '👏',
    '😁',
    '🤔',
];

/** How many buttons the row shows before it stops offering more. */
export const REACTION_ROW_LIMIT = 8;

/**
 * Telegram spells its reactions without the emoji-presentation selector and
 * compares them byte for byte, so `❤️` (U+2764 U+FE0F) is not the `❤` (U+2764)
 * in its list — sending the first is a REACTION_INVALID that looks, on screen,
 * exactly like a heart that does nothing.
 *
 * Everything here compares stripped, and what actually goes over the wire is
 * always the server's own spelling, never one typed into our source.
 */
export function normalizeReaction(emoji: string): string {
    return emoji.replace(/\uFE0F/g, '');
}

/**
 * A reaction as it should be drawn. The server's spelling has no
 * emoji-presentation selector, and a character like `❤` (U+2764) without one
 * renders as a monochrome text glyph — a white outline heart in the chip. The
 * selector goes back on for display only; `normalizeReaction` is still what
 * is compared and sent.
 *
 * It goes back per character, not per string: in a ZWJ sequence like `\u2764\u200D\uD83D\uDD25`
 * the `\uD83D\uDD25` already draws in colour, but the bare `\u2764` before the joiner still
 * needs its selector, or the font cannot match the sequence and draws it as a
 * white text heart beside a separate flame.
 */
export function displayReaction(emoji: string): string {
    const chars = Array.from(normalizeReaction(emoji));
    return chars
        .map((char, index) => {
            if (!/\p{Extended_Pictographic}/u.test(char)) return char;
            if (/\p{Emoji_Presentation}/u.test(char)) return char;
            // A skin tone already makes the base draw as an emoji.
            if (/\p{Emoji_Modifier}/u.test(chars[index + 1] ?? '')) return char;
            return `${char}\uFE0F`;
        })
        .join('');
}

export function sameReaction(left: string, right: string): boolean {
    return normalizeReaction(left) === normalizeReaction(right);
}

/**
 * Whether the chat takes this reaction.
 *
 * `null` is "we have not asked yet"; an empty list is an answer — the chat has
 * reactions switched off.
 */
export function isReactionAllowed(
    emoji: string,
    allowed: readonly string[] | null,
): boolean {
    if (allowed === null) return true;
    return allowed.some((item) => sameReaction(item, emoji));
}

/**
 * The row to draw: what is already on the message, then what else this chat
 * takes, up to `limit`.
 *
 * Reactions already on the message are shown even when the chat no longer
 * takes them — they are a fact about the message, and hiding them would lose a
 * count — but they come back unsendable, so nothing offers a button that
 * Telegram would refuse.
 */
export function buildReactionRow(
    existing: readonly ReactionCount[],
    allowed: readonly string[] | null,
    limit: number = REACTION_ROW_LIMIT,
): ReactionChoice[] {
    const row: ReactionChoice[] = existing.map((item) => ({
        ...item,
        sendable: isReactionAllowed(item.emoji, allowed),
    }));

    for (const emoji of allowed ?? FALLBACK_REACTIONS) {
        if (row.length >= Math.max(limit, existing.length)) break;
        if (row.some((item) => sameReaction(item.emoji, emoji))) continue;
        row.push({ emoji, count: 0, chosen: false, sendable: true });
    }

    return row;
}

/**
 * The reaction as *this chat* writes it.
 *
 * Two chats can spell the same reaction differently — one list holds `❤`, the
 * next `❤️` — and Telegram matches its own list byte for byte. So whatever a
 * button was drawn with, what goes over the wire is the chat's own string
 * whenever the chat has one.
 */
export function spellAsChat(
    emoji: string,
    allowed: readonly string[] | null,
): string {
    return allowed?.find((item) => sameReaction(item, emoji)) ?? emoji;
}

/**
 * The set to send after pressing `emoji`.
 *
 * `sendReaction` replaces this account's whole set rather than adding to it,
 * and Telegram rejects a set bigger than the account is allowed — one reaction
 * for everyone, three with Premium. So pressing a second reaction on a free
 * account must *displace* the first, not stack on it: stacking is the other
 * half of "some reactions don't work", and it fails on the reaction that was
 * pressed rather than the one already there.
 */
export function nextChosenReactions(
    existing: readonly ReactionCount[],
    emoji: string,
    maxChosen: number,
): { chosen: string[]; adding: boolean } {
    const mine = existing
        .filter((item) => item.chosen)
        .map((item) => item.emoji);
    const others = mine.filter((item) => !sameReaction(item, emoji));
    const adding = others.length === mine.length;

    if (!adding) return { chosen: others, adding };

    const chosen = [...others, emoji];
    const room = Math.max(1, maxChosen);

    // Oldest first out: the newest press is the one that was just asked for.
    return { chosen: chosen.slice(Math.max(0, chosen.length - room)), adding };
}

/**
 * The message's counts, as they will read once Telegram has taken `chosen`.
 *
 * Written against the whole chosen set rather than one emoji so a displaced
 * reaction loses its count in the same pass the new one gains it. This is only
 * what to paint while the round-trip is in flight — the answer Telegram sends
 * back replaces it.
 */
export function applyChosenReactions(
    existing: readonly ReactionCount[],
    chosen: readonly string[],
): ReactionCount[] {
    const next: ReactionCount[] = [];

    for (const item of existing) {
        const nowChosen = chosen.some((emoji) =>
            sameReaction(emoji, item.emoji),
        );
        const count = item.count + (nowChosen ? 1 : 0) - (item.chosen ? 1 : 0);
        if (count > 0) next.push({ ...item, count, chosen: nowChosen });
    }

    for (const emoji of chosen) {
        if (next.some((item) => sameReaction(item.emoji, emoji))) continue;
        next.push({ emoji, count: 1, chosen: true });
    }

    return next;
}
