import { QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from 'next-themes';
import { type ReactNode, useMemo } from 'react';

import { ExportWatcher } from '@/components/export-watcher';
import { JoinWatcher } from '@/components/join-watcher';
import { MessageNotifier } from '@/components/message-notifier';
import { PipPlayer } from '@/components/pip-player';
import { UploadWatcher } from '@/components/upload-watcher';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useTelegramSettings } from '@/hooks/use-entitlement';
import { useMouseNavigation } from '@/hooks/use-mouse-navigation';
import { installDebug } from '@/lib/debug';
import type { TelegramCredentials } from '@/lib/telegram/types';
import { TelegramProvider } from '@/providers/telegram-provider';
import { queryClient } from '@/router';

/**
 * The persistent layout every page renders inside.
 *
 * This is load-bearing: `TelegramProvider` owns the live MTProto connection and
 * the media caches built around it, so it has to survive navigation. It is
 * mounted once, by the root route. Remounting it on every navigation would
 * drop the session and re-download every thumbnail.
 */

installDebug();

export function AppShell({ children }: { children: ReactNode }) {
    const settings = useTelegramSettings();
    useMouseNavigation();

    const credentials = useMemo<TelegramCredentials | null>(() => {
        const apiId = Number(settings.apiId);
        if (!Number.isInteger(apiId) || apiId <= 0) return null;
        if (!settings.apiHash || settings.apiHash.length < 8) return null;
        return { apiId, apiHash: settings.apiHash };
    }, [settings.apiId, settings.apiHash]);

    return (
        // Dark is the default because this is a media viewer: photos and video
        // read better against black, and that is the scene the app is used in.
        // `enableSystem` still lets a viewer follow their OS if they pin it.
        // The matching pre-paint script lives in index.html.
        <ThemeProvider
            attribute="class"
            defaultTheme="dark"
            storageKey="theme"
            enableSystem
            disableTransitionOnChange
        >
            <QueryClientProvider client={queryClient}>
                <TooltipProvider>
                    <TelegramProvider credentials={credentials}>
                        {children}
                        <JoinWatcher />
                        <MessageNotifier />
                        <ExportWatcher />
                        <UploadWatcher />
                        <PipPlayer />
                        <Toaster />
                    </TelegramProvider>
                </TooltipProvider>
            </QueryClientProvider>
        </ThemeProvider>
    );
}
