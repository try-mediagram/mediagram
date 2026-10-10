export function BootScreen({ label = 'Opening…' }: { label?: string }) {
    return (
        <div className="grid min-h-dvh place-items-center px-6">
            <div className="flex flex-col items-center gap-3 text-center">
                <div className="pulse-mark" aria-hidden="true" />
                <p className="text-muted-foreground text-sm">{label}</p>
            </div>
        </div>
    );
}
