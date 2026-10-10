/**
 * Reading whatever a person pasted, without asking Telegram anything.
 *
 * People arrive holding whatever the person who told them about a chat happened
 * to send: a t.me link, a private invite, an @handle, or a bare id copied out of
 * another client. All of them name the same kind of thing, so all of them are
 * accepted, and the difference is settled here before a single request goes out.
 *
 * Kept free of imports on purpose. It is the half of the resolver that is pure
 * string work and the half most likely to be wrong about some form nobody
 * thought of, so it has to be testable without a Telegram session — see
 * chat-target.test.ts.
 */

export type ChatTarget =
    /** A private invite: t.me/+hash or t.me/joinchat/hash. */
    | { kind: 'invite'; hash: string; link: string }
    /** A public @handle. */
    | { kind: 'username'; username: string }
    /** A marked chat id, the way Telegram writes them. */
    | { kind: 'id'; chatId: number };

/** Everything on t.me that is a feature rather than somebody's handle. */
const RESERVED = new Set([
    'joinchat',
    'c',
    's',
    'addstickers',
    'addemoji',
    'addtheme',
    'setlanguage',
    'proxy',
    'socks',
    'share',
    'iv',
    'login',
    'bg',
    'invoice',
    'giftcode',
    'boost',
    'contact',
    'm',
]);

/** Telegram's own rule for a public handle. */
const USERNAME = /^[a-z][a-z0-9_]{3,31}$/i;

/**
 * Read whatever was pasted.
 *
 * Returns null rather than throwing, because "that is not a chat" is an
 * ordinary thing for a text field to be handed and the caller says so in place.
 */
export function parseChatTarget(input: string): ChatTarget | null {
    const trimmed = input.trim();
    if (!trimmed) return null;

    // tg:// deep links, which is what Telegram's own share sheet produces.
    const deepLink = trimmed.match(/^tg:\/\/(join|resolve)\?(.+)$/i);
    if (deepLink) {
        const params = new URLSearchParams(deepLink[2]);
        const invite = params.get('invite');
        if (deepLink[1].toLowerCase() === 'join' && invite) {
            return {
                kind: 'invite',
                hash: invite,
                link: `https://t.me/+${invite}`,
            };
        }
        const domain = params.get('domain');
        if (domain && USERNAME.test(domain)) {
            return { kind: 'username', username: domain.toLowerCase() };
        }
        return null;
    }

    const url = trimmed.match(
        /^(?:https?:\/\/)?(?:www\.)?t(?:elegram)?\.(?:me|dog|org)\/(.+)$/i,
    );

    if (url) {
        const path = url[1].replace(/^\/+/, '').split(/[?#]/)[0];
        const [first, second] = path.split('/');

        // Private invites. The hash is the whole address; there is no id to be
        // had until somebody is a member.
        if (first.startsWith('+')) {
            const hash = first.slice(1);
            return hash
                ? { kind: 'invite', hash, link: `https://t.me/+${hash}` }
                : null;
        }
        if (first.toLowerCase() === 'joinchat' && second) {
            return {
                kind: 'invite',
                hash: second,
                link: `https://t.me/joinchat/${second}`,
            };
        }

        // t.me/c/<internal id>/<message> — the form Telegram uses for a chat
        // with no handle. The internal id needs the -100 mark putting back on.
        if (first.toLowerCase() === 'c' && second && /^\d+$/.test(second)) {
            return { kind: 'id', chatId: -Number(`100${second}`) };
        }

        // t.me/s/<handle> is the web preview of a channel.
        if (first.toLowerCase() === 's' && second && USERNAME.test(second)) {
            return { kind: 'username', username: second.toLowerCase() };
        }

        if (!RESERVED.has(first.toLowerCase()) && USERNAME.test(first)) {
            return { kind: 'username', username: first.toLowerCase() };
        }

        return null;
    }

    if (trimmed.startsWith('@')) {
        const username = trimmed.slice(1);
        return USERNAME.test(username)
            ? { kind: 'username', username: username.toLowerCase() }
            : null;
    }

    // A marked id, the way Telegram writes them: negative for groups and
    // channels, positive for users.
    if (/^-?\d{5,20}$/.test(trimmed)) {
        return { kind: 'id', chatId: Number(trimmed) };
    }

    if (USERNAME.test(trimmed)) {
        return { kind: 'username', username: trimmed.toLowerCase() };
    }

    return null;
}
