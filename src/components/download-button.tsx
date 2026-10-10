import { Download } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { formatDownloadLabel } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * The one download control, for the player bar and the photo bar.
 *
 * Always available: everything in Mediagram is free, and a chat's "restrict
 * saving" switch is not enforced — the media is already on the reader's
 * screen.
 */
export function DownloadButton({
    busy,
    fileSize,
    onDownload,
    className,
}: {
    busy: boolean;
    fileSize?: number;
    onDownload: () => void;
    className?: string;
}) {
    const label = formatDownloadLabel(fileSize);

    return (
        <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={onDownload}
            title={label}
            aria-label={label}
            className={cn(
                'text-white hover:bg-white/15 hover:text-white [&_svg]:size-4',
                className,
            )}
        >
            <Download />
            Download
        </Button>
    );
}
