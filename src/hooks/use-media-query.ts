import { useEffect, useState } from 'react';

/**
 * Whether a CSS media query matches right now.
 *
 * For the places where a breakpoint has to decide *what is mounted*, not just
 * what is painted. Rendering both halves and hiding one with `lg:hidden` is
 * cheaper and usually right, but it is wrong when the hidden half does work:
 * the viewer's thread pane fetches messages from Telegram on mount, so a
 * `hidden` copy of it would ask for every thread the reader never opened.
 *
 * The first value is read synchronously so there is no frame in the wrong
 * layout, and `undefined` on the server falls back to `false`.
 */
export function useMediaQuery(query: string): boolean {
    const [matches, setMatches] = useState(() =>
        typeof window === 'undefined'
            ? false
            : window.matchMedia(query).matches,
    );

    useEffect(() => {
        const list = window.matchMedia(query);
        const onChange = () => setMatches(list.matches);
        onChange();
        list.addEventListener('change', onChange);
        return () => list.removeEventListener('change', onChange);
    }, [query]);

    return matches;
}
