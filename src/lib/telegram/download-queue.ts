/**
 * A fixed number of download slots shared by urgent work (a player waiting on
 * bytes) and background work (warming a stream nobody has opened yet).
 *
 * Urgent work may use every slot and is always served first. Background work
 * runs only while fewer than `maxBackground` slots are busy, so it can never
 * fill the queue a click lands in. A parked background job that urgent work
 * turns out to need — the same window, by key — is moved to the front.
 */
export function createDownloadQueue(max: number, maxBackground: number) {
    let inFlight = 0;
    const urgentWaiters: Array<() => void> = [];
    const backgroundWaiters: Array<() => void> = [];
    const promoters = new Map<string, () => void>();

    // A slot is counted the moment it is handed over, not when the woken job
    // gets round to running, so one release never wakes more than it frees.
    function next() {
        while (inFlight < max && urgentWaiters.length > 0) {
            inFlight += 1;
            urgentWaiters.shift()?.();
        }
        while (inFlight < maxBackground && backgroundWaiters.length > 0) {
            inFlight += 1;
            backgroundWaiters.shift()?.();
        }
    }

    function park(key: string) {
        return new Promise<void>((resolve) => {
            const go = () => {
                promoters.delete(key);
                resolve();
            };
            backgroundWaiters.push(go);
            promoters.set(key, () => {
                const at = backgroundWaiters.indexOf(go);
                if (at < 0) return;
                backgroundWaiters.splice(at, 1);
                urgentWaiters.push(go);
                next();
            });
        });
    }

    async function run<T>(
        work: () => Promise<T>,
        urgent: boolean,
        key: string,
    ): Promise<T> {
        const limit = urgent ? max : maxBackground;
        if (inFlight < limit) inFlight += 1;
        else if (urgent) {
            await new Promise<void>((resolve) => urgentWaiters.push(resolve));
        } else await park(key);
        try {
            return await work();
        } finally {
            inFlight -= 1;
            next();
        }
    }

    return {
        run,
        /** Urgent work wants this key: a parked background job jumps ahead. */
        promote: (key: string) => promoters.get(key)?.(),
        /** For tests: slots busy right now. */
        busy: () => inFlight,
    };
}
