/**
 * Whether this account may post media to a chat.
 *
 * Pure on purpose — no imports — so it runs under `node --test` the way
 * chat-target.ts and reactions.ts do. `dialogs.ts` pulls the handful of fields
 * off the peer and this decides; the answer rides on `DialogItem`, so every
 * surface reads the same verdict.
 *
 * Worth having as its own unit because the rule is not one flag. A broadcast
 * channel refuses everyone but its admins, a supergroup can ban media for
 * ordinary members while still letting them talk, and a chat you can *read*
 * without joining is one you cannot post to. Offering Send in all three and
 * letting Telegram reject it is how you get a button that looks broken.
 */

export type SendTargetKind =
    /** A person, a bot, or Saved Messages. */
    | 'user'
    /** A broadcast channel, or a gigagroup, where only admins post. */
    | 'broadcast'
    /** A group or supergroup. */
    | 'group';

export type SendTarget = {
    kind: SendTargetKind;
    isMember: boolean;
    isBanned: boolean;
    isCreator: boolean;
    isAdmin: boolean;
    /** `adminRights.postMessages`. Only meaningful for a broadcast. */
    canPostAsAdmin: boolean;
    /**
     * Whether an ordinary member may send media, from the chat's own
     * permissions. Null when Telegram did not say, which is not the same as
     * "no" — an absent answer is treated as permitted and left to Telegram.
     */
    memberCanSendMedia: boolean | null;
    /**
     * Whether an ordinary member may send text at all. A group can mute its
     * members outright, and then the message box is as useless as Send is.
     * Null when Telegram did not say, treated as permitted like the above.
     */
    memberCanSendText: boolean | null;
};

export type SendBlock =
    | 'banned'
    | 'not-member'
    | 'broadcast-readonly'
    | 'media-restricted'
    | 'text-restricted';

export type SendVerdict =
    | { allowed: true }
    | { allowed: false; reason: SendBlock };

const ALLOWED: SendVerdict = { allowed: true };

function refuse(reason: SendBlock): SendVerdict {
    return { allowed: false, reason };
}

/**
 * The verdict for one chat.
 *
 * A conversation with a person is always allowed: whether they have blocked
 * you is not on the peer, and there is no way to know before sending. Guessing
 * would hide the button on chats that work.
 */
export function checkCanSendMedia(target: SendTarget): SendVerdict {
    if (target.kind === 'user') return ALLOWED;

    if (target.isBanned) return refuse('banned');
    if (!target.isMember) return refuse('not-member');

    // An owner or an admin with posting rights outranks the member defaults,
    // so these are checked before the banned-rights are read.
    if (target.isCreator) return ALLOWED;

    if (target.kind === 'broadcast') {
        return target.canPostAsAdmin ? ALLOWED : refuse('broadcast-readonly');
    }

    if (target.isAdmin) return ALLOWED;

    return target.memberCanSendMedia === false
        ? refuse('media-restricted')
        : ALLOWED;
}

/**
 * Whether this account may write a message here: the same rules as media,
 * except that the member default checked is sending text. A chat that bans
 * media but allows talk keeps its message box; one that mutes its members
 * does not, rather than offering a box Telegram will refuse.
 */
export function checkCanWrite(target: SendTarget): SendVerdict {
    if (target.kind === 'user') return ALLOWED;
    if (target.isBanned) return refuse('banned');
    if (!target.isMember) return refuse('not-member');
    if (target.isCreator) return ALLOWED;
    if (target.kind === 'broadcast') {
        return target.canPostAsAdmin ? ALLOWED : refuse('broadcast-readonly');
    }
    if (target.isAdmin) return ALLOWED;
    return target.memberCanSendText === false
        ? refuse('text-restricted')
        : ALLOWED;
}

/**
 * A member's effective right from their own restrictions and the chat's
 * defaults: Telegram applies both, so either one saying no is a no. Null
 * when neither was sent.
 */
export function combineRights(
    own: boolean | null | undefined,
    defaults: boolean | null | undefined,
): boolean | null {
    if (own == null && defaults == null) return null;
    return own !== false && defaults !== false;
}

/** Why the button is not offered, in the reader's terms. */
export function describeSendBlock(reason: SendBlock): string {
    switch (reason) {
        case 'banned':
            return 'You are banned from this chat.';
        case 'not-member':
            return 'Join this chat to send files to it.';
        case 'broadcast-readonly':
            return 'Only admins can post to this channel.';
        case 'media-restricted':
            return 'This chat does not allow members to send media.';
        case 'text-restricted':
            return 'Only admins can write in this chat.';
    }
}
