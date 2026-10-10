import { useEffect, useState } from 'react';

import { Skeleton } from '@/components/ui/skeleton';
import { kindLabel } from '@/lib/telegram/select-visible-dialogs';
import type { DialogItem } from '@/lib/telegram/types';

/**
 * The same chat, in one row, for the top of the filter rail.
 *
 * The rail is where the filters are, and a filter is meaningless without
 * knowing what it is filtering — so the chat's face and name sit above them
 * and stay put while the list below scrolls.
 */
export function ChatIdentity({ dialog }: { dialog: DialogItem | null }) {
    const avatar = useDialogAvatar(dialog);

    if (!dialog) {
        return (
            <div className="flex h-14 items-center gap-2.5 px-3">
                <Skeleton className="size-9 rounded-full" />
                <Skeleton className="h-3.5 w-28" />
            </div>
        );
    }

    return (
        // h-14 to the pixel, because the grid's toolbar is the same and the
        // two borders meet at the rail's edge — a row taller than its
        // neighbour turns that seam into a step.
        <div className="flex h-14 min-w-0 items-center gap-2.5 px-3">
            <div className="bg-muted grid size-9 shrink-0 place-items-center overflow-hidden rounded-full text-xs font-semibold">
                {avatar ? (
                    <img
                        src={avatar}
                        alt=""
                        className="size-full object-cover"
                    />
                ) : (
                    <span>{initials(dialog.title)}</span>
                )}
            </div>
            <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{dialog.title}</p>
                <p className="text-muted-foreground truncate text-xs">
                    {dialog.username
                        ? `@${dialog.username}`
                        : kindLabel(dialog.kind)}
                </p>
            </div>
        </div>
    );
}

/**
 * The chat's avatar, at the size this pane shows it. The inline preview that
 * came with the dialog stands in until the download lands.
 */
function useDialogAvatar(dialog: DialogItem | null): string | null {
    const [src, setSrc] = useState<string | null>(null);

    useEffect(() => {
        setSrc(dialog?.avatarPreview ?? null);

        if (!dialog?.hasPhoto) return;

        let live = true;
        void import('@/lib/telegram/dialogs')
            .then((mod) => mod.downloadAvatar(dialog.id))
            .then((url) => {
                if (live && url) setSrc(url);
            })
            .catch(() => undefined);

        return () => {
            live = false;
        };
    }, [dialog?.avatarPreview, dialog?.hasPhoto, dialog?.id]);

    return src;
}

function initials(title: string): string {
    const parts = title.trim().split(/\s+/).slice(0, 2);
    return parts.map((part) => part[0]?.toUpperCase() ?? '').join('') || '·';
}
