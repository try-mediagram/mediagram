import { cn } from '@/lib/utils';

/**
 * One option in a small stack of them, with room for the reason to pick it.
 *
 * A plain radio gives a label and nowhere to say what the choice does, and
 * both the export and upload dialogs need that second line — "every message,
 * back to the beginning" is the part that makes the option legible. Rendered
 * as a pressed button rather than an input because that is what the rest of
 * the app's dialogs use.
 */
export function ChoiceRow({
    active,
    label,
    hint,
    onSelect,
    className,
}: {
    active: boolean;
    label: string;
    hint?: string;
    onSelect: () => void;
    className?: string;
}) {
    return (
        <button
            type="button"
            aria-pressed={active}
            onClick={onSelect}
            className={cn(
                'rounded-xl border px-3 py-2 text-left text-sm transition',
                active
                    ? 'border-brand-border bg-brand-subtle text-brand-subtle-foreground'
                    : 'border-border hover:bg-muted/50',
                className,
            )}
        >
            <span className="block font-medium">{label}</span>
            {hint ? (
                <span className="text-muted-foreground block text-xs">
                    {hint}
                </span>
            ) : null}
        </button>
    );
}
