import { Link } from '@tanstack/react-router';
import { ChevronLeft, PanelLeft, Search, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { UserMenu } from '@/components/user-menu';
import { Wordmark } from '@/components/wordmark';
import { cn } from '@/lib/utils';

export type NavSearch = {
    value: string;
    onChange: (value: string) => void;
    placeholder: string;
    /** What the field filters, for screen readers. */
    label: string;
};

/**
 * The top nav: mark on the left, search in the middle, account on the right.
 *
 * Everything account-shaped — name, theme, tags, log out — is behind the avatar
 * in `UserMenu`, so the bar itself only carries navigation. Tags used to have a
 * button here; it belongs with the tag list in the library rail, not on every
 * screen.
 */
export function AccountBar({
    title,
    back,
    wide = false,
    search,
    onOpenNav,
}: {
    title: string;
    back?: { label: string };
    wide?: boolean;
    /** Renders the centre field. Owned by the caller: it does the filtering. */
    search?: NavSearch;
    /** Opens the mobile library rail; only the library passes it. */
    onOpenNav?: () => void;
}) {
    return (
        <header className="border-border bg-background sticky top-0 z-20 border-b">
            <div
                className={cn(
                    'mx-auto flex h-14 w-full items-center gap-2 px-3 sm:gap-3 sm:px-4',
                    !wide && 'max-w-6xl',
                )}
            >
                {onOpenNav ? (
                    <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        className="shrink-0 md:hidden"
                        aria-label="Open library filters"
                        onClick={onOpenNav}
                    >
                        <PanelLeft />
                    </Button>
                ) : null}

                {back ? (
                    <Link
                        to="/chats"
                        className="text-muted-foreground hover:text-foreground inline-flex shrink-0 items-center gap-1 text-sm transition-colors"
                    >
                        <ChevronLeft className="size-4" />
                        {back.label}
                    </Link>
                ) : (
                    <Wordmark
                        size="md"
                        className={cn(search && 'shrink-0 max-sm:hidden')}
                    />
                )}

                {search ? (
                    <NavSearchField {...search} />
                ) : (
                    <p className="min-w-0 flex-1 truncate text-sm font-medium">
                        {title}
                    </p>
                )}

                <UserMenu />
            </div>
        </header>
    );
}

/**
 * The round search field, in the nav or wherever a screen centres it. Escape
 * and the cross both empty it.
 */
export function NavSearchField({
    value,
    onChange,
    placeholder,
    label,
    className,
}: NavSearch & { className?: string }) {
    return (
        <div
            className={cn(
                'relative mx-auto max-w-xl min-w-0 flex-1',
                className,
            )}
        >
            <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
            <Input
                type="search"
                value={value}
                onChange={(event) => onChange(event.target.value)}
                onKeyDown={(event) => {
                    if (event.key === 'Escape' && value) {
                        event.preventDefault();
                        onChange('');
                    }
                }}
                placeholder={placeholder}
                aria-label={label}
                className="h-9 rounded-full pr-9 pl-9 [&::-webkit-search-cancel-button]:hidden"
            />
            {value ? (
                <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label="Clear search"
                    className="text-muted-foreground absolute top-1/2 right-1.5 -translate-y-1/2 rounded-full"
                    onClick={() => onChange('')}
                >
                    <X />
                </Button>
            ) : null}
        </div>
    );
}
