import { TanStackDevtools } from '@tanstack/react-devtools';
import type { QueryClient } from '@tanstack/react-query';
import {
    createRootRouteWithContext,
    HeadContent,
    Outlet,
} from '@tanstack/react-router';
import { TanStackRouterDevtoolsPanel } from '@tanstack/react-router-devtools';

import TanStackQueryDevtools from '@/integrations/tanstack-query/devtools';
import { AppShell } from '@/layouts/app-shell';

interface RouterContext {
    queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
    head: () => ({ meta: [{ title: 'Mediagram' }] }),
    component: Root,
});

/**
 * AppShell sits here, above every route, so the Telegram connection it owns
 * is mounted once for the life of the window — never per screen.
 */
function Root() {
    return (
        <>
            <HeadContent />
            <AppShell>
                <Outlet />
            </AppShell>
            {import.meta.env.DEV ? (
                <TanStackDevtools
                    config={{ position: 'bottom-left' }}
                    plugins={[
                        {
                            name: 'Tanstack Router',
                            render: <TanStackRouterDevtoolsPanel />,
                        },
                        TanStackQueryDevtools,
                    ]}
                />
            ) : null}
        </>
    );
}
