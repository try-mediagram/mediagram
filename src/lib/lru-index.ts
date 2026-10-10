/**
 * A most-recently-used list of keys, capped: the bookkeeping for caches whose
 * store has no eviction of its own (Cache Storage keeps everything until told
 * otherwise).
 *
 * Pure and import-free so it can be tested without a browser.
 */
export function touchLru(
    index: readonly string[],
    key: string,
    max: number,
): { index: string[]; evicted: string[] } {
    const next = index.filter((item) => item !== key);
    next.push(key);
    const evicted = next.length > max ? next.splice(0, next.length - max) : [];
    return { index: next, evicted };
}
