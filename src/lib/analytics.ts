import { debug } from '@/lib/debug';

/**
 * The conversion funnel, as events.
 *
 * The landing has one job — get a cold visitor to finish a Telegram sign-in —
 * and "registrations" is too coarse a number to tell us why it is failing.
 * These are the steps between arriving and seeing your own media, so a drop can
 * be read off the shape of the funnel rather than guessed at:
 *
 *   - CTA clicks high, auth starts low   → trust, or the CTA itself
 *   - auth starts high, completions low  → the Telegram handshake
 *   - completions high, media low        → the product, after sign-in
 *
 * There is no analytics vendor in this app and this file does not add one. It
 * writes to whichever sink the page happens to have (a Plausible, gtag or GTM
 * snippet dropped into app.blade.php) and otherwise only to the debug log under
 * the `funnel` scope, so `?debug=1` shows the funnel walking past in the
 * console. Wiring a real destination is a one-line change here.
 */

export type FunnelEvent =
    | 'landing_view'
    | 'cta_click'
    | 'telegram_auth_started'
    | 'telegram_auth_completed'
    | 'media_loaded'
    | 'first_search'
    | 'first_filter'
    | 'first_tag'
    | 'first_download';

type Props = Record<string, string | number | boolean>;

type AnalyticsWindow = Window & {
    plausible?: (event: string, options?: { props?: Props }) => void;
    gtag?: (command: 'event', event: string, props?: Props) => void;
    dataLayer?: { push: (payload: Record<string, unknown>) => void };
};

/**
 * Steps that mean something only the first time.
 *
 * A funnel step is a threshold the visitor crosses, not an action they can
 * repeat — `first_search` fired on every keystroke would make the search step
 * look busier than the view above it and invert the whole shape.
 */
const seen = new Set<FunnelEvent>();

export function track(event: FunnelEvent, props: Props = {}): void {
    if (typeof window === 'undefined') return;

    debug('funnel', event, props);

    const target = window as AnalyticsWindow;

    try {
        target.plausible?.(event, { props });
        target.gtag?.('event', event, props);
        target.dataLayer?.push({ event, ...props });
    } catch (error) {
        // A blocked or half-loaded analytics snippet must never take the page
        // down with it — this is measurement, not function.
        debug('funnel', 'sink failed', error);
    }
}

/** Track a step that is only interesting the first time it happens. */
export function trackOnce(event: FunnelEvent, props: Props = {}): void {
    if (seen.has(event)) return;
    seen.add(event);
    track(event, props);
}
