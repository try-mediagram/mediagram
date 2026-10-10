import { Check, Tag as TagIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';

/**
 * What is picked, and the way out of picking.
 *
 * It takes the toolbar's place while selecting rather than stacking under it:
 * both are `sticky top-0`, so two at once overlap on scroll, and a strip that
 * both filters the grid and acts on a selection is two modes in one row.
 *
 * Tagging is not here. It lives in `TagPanel`, in the pane the conversation
 * usually occupies — a mode deserves the room it needs, and the popover this
 * replaced could show a word or a field but never both. Below lg that pane has
 * nowhere to sit beside the grid, so this offers the button that brings it in
 * as a sheet.
 */
export function SelectionBar({
    count,
    loaded,
    onSelectAll,
    onClear,
    onOpenTags,
    onDone,
}: {
    /** How many message ids are picked. */
    count: number;
    /** How many items the grid is holding, for "select all". */
    loaded: number;
    onSelectAll: () => void;
    onClear: () => void;
    /** Bring the tag panel in as a sheet, below lg. */
    onOpenTags: () => void;
    onDone: () => void;
}) {
    return (
        <div className="border-border bg-background sticky top-0 z-10 flex min-h-14 flex-wrap items-center gap-2 border-b px-4 py-2 shadow-sm">
            <span className="text-sm font-medium tabular-nums">
                {count.toLocaleString()} selected
            </span>

            <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={onSelectAll}
                disabled={count >= loaded}
            >
                Select all {loaded.toLocaleString()}
            </Button>

            <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={onClear}
                disabled={count === 0}
            >
                Clear
            </Button>

            <Button
                type="button"
                variant="outline"
                size="xs"
                className="ml-auto lg:hidden"
                onClick={onOpenTags}
            >
                <TagIcon data-icon="inline-start" />
                Tags
            </Button>

            <Button
                type="button"
                variant="ghost"
                size="xs"
                className="max-lg:ml-0 lg:ml-auto"
                onClick={onDone}
            >
                <Check data-icon="inline-start" />
                Done
            </Button>
        </div>
    );
}
