import { useRouter } from '@tanstack/react-router';
import { useEffect } from 'react';

/** `MouseEvent.button` for the thumb buttons on the side of a mouse. */
export const MOUSE_BACK = 3;
export const MOUSE_FORWARD = 4;

/**
 * Maps the mouse's back and forward buttons onto the router's history.
 *
 * A browser tab gets this for free, but the desktop webview does not: there the
 * buttons arrive as plain DOM events and nothing acts on them. Acting on
 * `mouseup` and cancelling both halves of the click keeps a browser tab, which
 * would otherwise navigate on its own, from moving twice.
 *
 * Overlays that want "back" to close them instead listen on `window` in the
 * capture phase and stop propagation, which keeps the event from reaching this
 * bubble-phase listener.
 */
export function useMouseNavigation() {
    const router = useRouter();

    useEffect(() => {
        const isNavButton = (event: MouseEvent) =>
            event.button === MOUSE_BACK || event.button === MOUSE_FORWARD;

        const onDown = (event: MouseEvent) => {
            if (isNavButton(event)) event.preventDefault();
        };
        const onUp = (event: MouseEvent) => {
            if (!isNavButton(event)) return;
            event.preventDefault();
            if (event.button === MOUSE_BACK) router.history.back();
            else router.history.forward();
        };

        window.addEventListener('mousedown', onDown);
        window.addEventListener('mouseup', onUp);
        return () => {
            window.removeEventListener('mousedown', onDown);
            window.removeEventListener('mouseup', onUp);
        };
    }, [router]);
}

/**
 * Lets an overlay claim the mouse's back button, so it closes the overlay
 * rather than navigating the page underneath it.
 */
export function useMouseBackToClose(onClose: () => void, enabled = true) {
    useEffect(() => {
        if (!enabled) return;
        const onUp = (event: MouseEvent) => {
            if (event.button !== MOUSE_BACK) return;
            event.preventDefault();
            event.stopPropagation();
            onClose();
        };
        window.addEventListener('mouseup', onUp, true);
        return () => window.removeEventListener('mouseup', onUp, true);
    }, [onClose, enabled]);
}
