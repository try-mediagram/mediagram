/**
 * What sits under every rail: the small print.
 *
 * Pinned rather than scrolled with the filters above it. Both rails render
 * this so the two screens end the same way.
 */
export function RailFooter() {
    return (
        <div className="border-border bg-muted/40 shrink-0 border-t p-2">
            <p className="text-muted-foreground px-2.5 pt-3 pb-1 text-[11px]">
                &copy; {new Date().getFullYear()} Mediagram
            </p>
        </div>
    );
}
