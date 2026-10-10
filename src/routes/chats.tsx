import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';

import { AuthGate } from '@/components/auth-gate';
import { ChatList } from '@/components/chat-list';
import { fetchSources, SOURCES_KEY } from '@/lib/source-visits';
import type { SourceMap } from '@/types/mediagram';

export const Route = createFileRoute('/chats')({
    head: () => ({ meta: [{ title: 'Your chats - Mediagram' }] }),
    component: Chats,
});

const NO_SOURCES: SourceMap = {};

function Chats() {
    // Read markers only colour the "new" badges, so the list never waits on
    // them: it renders straight away and the badges settle in.
    const sources = useQuery({
        queryKey: SOURCES_KEY,
        queryFn: fetchSources,
    });

    return (
        <AuthGate>
            <ChatList sources={sources.data ?? NO_SOURCES} />
        </AuthGate>
    );
}
