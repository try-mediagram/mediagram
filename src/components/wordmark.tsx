import { cn } from '@/lib/utils';

/**
 * The mark itself, in its 403x410 box.
 *
 * Exported because the sign-in seal draws the same arrow inside a shield.
 * Two copies of a logo is how a logo starts having two versions.
 */
export const MARK_PATH =
    'M40.787 406.89L386.904 229.954C407.244 219.556 407.27 190.476 386.93 180.078L40.745 3.10634C22.1143 -6.41779 5.99495e-05 7.11357 5.90349e-05 28.0376L5.48167e-05 124.54C5.41481e-05 139.834 10.8224 152.99 25.8295 155.939L239.823 197.993C246.484 199.302 246.19 208.929 239.461 209.828L27.762 238.115C11.8682 240.238 4.91666e-05 253.798 4.84657e-05 269.833L4.35636e-05 381.98C4.2649e-05 402.904 22.1563 416.414 40.787 406.89Z';

/**
 * Mediagram's name and mark, drawn in `currentColor`.
 *
 * The mark is inline rather than `<img src="/logo.svg">` on purpose: brand blue
 * is the weakest thing on a black nav bar, and an <img> cannot follow the
 * theme. Inheriting the text colour makes it white in dark and near-black in
 * light. /logo.svg keeps the blue for the favicon and anywhere off-app.
 */
export function Wordmark({
    size = 'md',
    className,
}: {
    size?: 'sm' | 'md' | 'lg';
    className?: string;
}) {
    return (
        <span
            className={cn(
                'inline-flex items-center',
                size === 'sm' && 'gap-1.5',
                size === 'md' && 'gap-2',
                size === 'lg' && 'gap-2.5',
                className,
            )}
        >
            <svg
                viewBox="0 0 403 410"
                fill="none"
                aria-hidden="true"
                className={cn(
                    'text-brand shrink-0',
                    size === 'sm' && 'size-5',
                    size === 'md' && 'size-6',
                    size === 'lg' && 'size-8',
                )}
            >
                <path d={MARK_PATH} fill="currentColor" />
            </svg>
            <span
                className={cn(
                    'font-display font-bold tracking-tight',
                    size === 'sm' && 'text-base',
                    size === 'md' && 'text-lg',
                    size === 'lg' && 'text-2xl',
                )}
            >
                Mediagram
            </span>
        </span>
    );
}
