export function formatDuration(totalSeconds: number): string {
    const seconds = Math.max(0, Math.round(totalSeconds));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const rest = seconds % 60;
    if (hours > 0) {
        return `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
    }
    return `${minutes}:${String(rest).padStart(2, '0')}`;
}

export function formatUsdCents(cents: number): string {
    return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
        maximumFractionDigits: 2,
    }).format(cents / 100);
}

export function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    const digits = value >= 10 || unit === 0 ? 0 : 1;
    return `${value.toFixed(digits)} ${units[unit]}`;
}

/**
 * Steps from seconds up to years, each holding how many of the previous unit
 * fit into it. Walking them turns an elapsed time into the largest unit that
 * still reads naturally: 14 days becomes "2 weeks ago", not "336 hours ago".
 */
const DIVISIONS: { amount: number; unit: Intl.RelativeTimeFormatUnit }[] = [
    { amount: 60, unit: 'second' },
    { amount: 60, unit: 'minute' },
    { amount: 24, unit: 'hour' },
    { amount: 7, unit: 'day' },
    { amount: 4.34524, unit: 'week' },
    { amount: 12, unit: 'month' },
    { amount: Number.POSITIVE_INFINITY, unit: 'year' },
];

/**
 * A compact, spoken-language age: "2 weeks ago", "3 months ago".
 *
 * Preferred over a full timestamp anywhere the exact minute does not matter —
 * "Aug 29, 2026, 06:14 PM" is precise and unreadable at a glance. Pair it with
 * `formatMediaDateTime` in a `title` when the exact time is still wanted.
 */
export function formatRelativeDateTime(iso: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';

    const elapsed = date.getTime() - Date.now();
    if (Math.abs(elapsed) < 45_000) return 'Just now';

    const formatter = new Intl.RelativeTimeFormat(undefined, {
        numeric: 'always',
    });

    let duration = elapsed / 1000;
    for (const division of DIVISIONS) {
        if (Math.abs(duration) < division.amount) {
            return formatter.format(Math.round(duration), division.unit);
        }
        duration /= division.amount;
    }

    return formatMediaDate(iso);
}

export function formatRelativeTime(iso: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    const diff = Date.now() - date.getTime();
    if (diff < 45_000) return 'Just now';
    const minutes = Math.round(diff / 60_000);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.round(hours / 24);
    if (days < 7) return `${days}d ago`;
    return formatMediaDate(iso);
}

/** Just the clock: the time of day a message landed, in the reader's locale. */
export function formatClockTime(iso: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    return new Intl.DateTimeFormat(undefined, {
        hour: '2-digit',
        minute: '2-digit',
    }).format(date);
}

export function formatMediaDate(iso: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    return new Intl.DateTimeFormat(undefined, {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
    }).format(date);
}

export function formatMediaDateTime(iso: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    return new Intl.DateTimeFormat(undefined, {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    }).format(date);
}

/**
 * "Download · 185 MB" — the size is the one piece of the old metadata bar
 * worth keeping, and the download control is where it actually informs a
 * decision rather than just filling a header.
 */
export function formatDownloadLabel(bytes?: number): string {
    const size = bytes ? formatBytes(bytes) : '';
    return size ? `Download · ${size}` : 'Download';
}

export function bytesToBlob(bytes: Uint8Array, mime: string): Blob {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return new Blob([copy], { type: mime });
}
