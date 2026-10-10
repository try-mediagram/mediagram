import { useEffect, useState } from 'react';

import type { ThreadMessage } from '@/lib/telegram/types';
import { cn } from '@/lib/utils';

/**
 * The face beside a message, wherever a message is shown.
 *
 * Telegram hands the dialog a tiny inline preview, which stands in until the
 * real photo lands — so a row never starts as an empty circle when there is
 * anything at all to draw. The fallback ring is themed by the caller because
 * the same avatar sits on the rail's own background and on the viewer's black.
 */
export function SenderAvatar({
    message,
    size,
    className,
}: {
    message: ThreadMessage;
    size: number;
    className?: string;
}) {
    const [src, setSrc] = useState<string | null>(
        message.senderAvatarPreview ?? null,
    );
    const [broken, setBroken] = useState(false);

    useEffect(() => {
        setSrc(message.senderAvatarPreview ?? null);
        setBroken(false);
        if (!message.senderId) return;
        let live = true;
        void import('@/lib/telegram/dialogs')
            .then((mod) => mod.downloadAvatar(message.senderId as number))
            .then((url) => {
                if (live && url) {
                    setBroken(false);
                    setSrc(url);
                }
            })
            .catch(() => undefined);
        return () => {
            live = false;
        };
    }, [message.senderAvatarPreview, message.senderId]);

    return (
        <div
            className={cn(
                'bg-muted text-muted-foreground grid shrink-0 place-items-center overflow-hidden rounded-full text-[10px] font-semibold',
                className,
            )}
            style={{ width: size, height: size }}
        >
            {src && !broken ? (
                <img
                    src={src}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    className="size-full object-cover"
                    onError={() => setBroken(true)}
                />
            ) : (
                <span>{senderInitials(message.senderName)}</span>
            )}
        </div>
    );
}

export function senderInitials(name: string): string {
    const parts = name.trim().split(/\s+/).slice(0, 2);
    return parts.map((part) => part[0]?.toUpperCase() ?? '').join('') || '·';
}
