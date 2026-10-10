import type { ComponentProps } from 'react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * The one button that is Mediagram's rather than shadcn's.
 *
 * It is a wrapper here and NOT a `brand` variant inside
 * `components/ui/button.tsx`, because `npm run check` regenerates everything in
 * `components/ui` from the registry. A variant added there survives until the
 * next run and then vanishes, quietly taking the page's primary action back to
 * neutral grey — which is a change nobody reviews, because nobody edited it.
 *
 * The fill is the only difference. `cn` runs through tailwind-merge, so these
 * classes displace the stock `default` variant's `bg-primary` rather than
 * racing it in the stylesheet. Both halves of the pair come from the theme and
 * flip together per theme: white on deep blue in light, near-black on bright
 * blue in dark. See the brand tokens in app.css for the measured ratios.
 */
export function BrandButton({
    className,
    ...props
}: Omit<ComponentProps<typeof Button>, 'variant'>) {
    return (
        <Button
            {...props}
            className={cn(
                'bg-brand-solid text-brand-solid-foreground hover:bg-brand-solid-hover',
                className,
            )}
        />
    );
}
