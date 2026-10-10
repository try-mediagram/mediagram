import { Moon, Sun } from 'lucide-react';
import { useTheme } from 'next-themes';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * Switches between the light and dark themes.
 *
 * `resolvedTheme` rather than `theme`, so the button reports what the viewer is
 * actually looking at even when they are following the system. Choosing from
 * here pins that choice; next-themes writes it to localStorage under `theme`,
 * which the inline script in app.blade.php reads back before first paint.
 *
 * The mounted guard is not ceremony: on the first client render the stored
 * theme is not known yet, and rendering the wrong icon would flip it under the
 * viewer a frame later. The placeholder holds the same box so nothing reflows.
 */
export function ThemeToggle() {
    const { resolvedTheme, setTheme } = useTheme();
    const [mounted, setMounted] = useState(false);

    useEffect(() => setMounted(true), []);

    if (!mounted) {
        return <div className="size-7 shrink-0" aria-hidden />;
    }

    const dark = resolvedTheme === 'dark';
    const label = dark ? 'Switch to light theme' : 'Switch to dark theme';

    return (
        <Button
            variant="ghost"
            size="icon-sm"
            aria-label={label}
            title={label}
            className="text-muted-foreground hover:text-foreground relative shrink-0"
            onClick={() => setTheme(dark ? 'light' : 'dark')}
        >
            {/*
                Both icons stay mounted and cross-fade through one another.
                Swapping one for the other pops; this reads as the same light
                source turning into place.
            */}
            <Sun className={icon(dark)} aria-hidden />
            <Moon className={icon(!dark)} aria-hidden />
        </Button>
    );
}

/** Only the icon for the live theme is shown, scaled and turned into place. */
function icon(hidden: boolean): string {
    return cn(
        'absolute size-4 transition-all duration-300 ease-out motion-reduce:transition-none',
        hidden
            ? 'scale-50 -rotate-90 opacity-0'
            : 'scale-100 rotate-0 opacity-100',
    );
}
