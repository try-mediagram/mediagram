import { createFileRoute, notFound } from '@tanstack/react-router';

import { AuthGate } from '@/components/auth-gate';
import { MediaGrid } from '@/components/media-grid';
import {
    useMediaFilters,
    validateMediaSearch,
} from '@/hooks/use-media-filters';

/**
 * Chat ids are Telegram's "marked" ids: positive for users, negative for basic
 * groups (-id) and for channels and supergroups (-100…), so the id may carry a
 * leading minus.
 */
export const Route = createFileRoute('/c/$chatId')({
    params: {
        parse: ({ chatId }) => {
            if (!/^-?[0-9]+$/.test(chatId)) throw notFound();
            return { chatId };
        },
    },
    validateSearch: validateMediaSearch,
    head: () => ({ meta: [{ title: 'Media - Mediagram' }] }),
    component: Chat,
});

/**
 * Whether this chat is restricted is Telegram's answer, and only the window
 * ever holds the connection that carries it — so the grid decides, and renders
 * the paywall itself before asking for any media.
 */
function Chat() {
    const { chatId } = Route.useParams();
    const [filters, setFilters] = useMediaFilters();

    return (
        <AuthGate>
            <MediaGrid
                key={chatId}
                chatId={Number(chatId)}
                filters={filters}
                onFiltersChange={setFilters}
            />
        </AuthGate>
    );
}
