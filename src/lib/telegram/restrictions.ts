/**
 * Telegram's own adult-content flag, which is the only one Mediagram acts on.
 *
 * A restricted peer carries `restrictions[]`, each with a reason code — `porno`,
 * `terms`, `copyright` and so on. Only some of those mean adult content, so the
 * list we count is config (`mediagram.restriction_reasons`) shared through
 * Inertia rather than a constant here.
 *
 * This lives under lib/telegram because the flag travels with the peer over
 * MTProto and nothing else ever sees it: Laravel holds no verdict of its own,
 * and there is no scan, score or pool behind this any more.
 */
export function isRestrictedByTelegram(
    reasons: string[],
    configured: string[],
): boolean {
    return reasons.some((reason) => configured.includes(reason.toLowerCase()));
}
