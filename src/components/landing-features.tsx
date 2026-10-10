import { Download, Search, SlidersHorizontal, Tag } from 'lucide-react';
import type { ComponentType } from 'react';

/**
 * What Mediagram does, ordered by what the reader came for.
 *
 * Find, filter, tag, download — the four verbs of actually getting a thing out
 * of a chat, in the order someone does them. The longer list of capabilities
 * underneath is deliberately quieter: those are the details that make the four
 * above believable, and every one of them is something the app really does.
 * Nothing here is aspirational, because the claim the page leads with only
 * holds if the rest of it is checkable too.
 */

const FEATURES: {
    icon: ComponentType<{ className?: string }>;
    name: string;
    detail: string;
    note?: string;
}[] = [
    {
        icon: Search,
        name: 'Find the media.',
        detail: 'Photos, videos, GIFs, music and voice notes from a chat, laid out as thumbnails instead of scrolled past in a conversation.',
    },
    {
        icon: SlidersHorizontal,
        name: 'Narrow thousands of items in seconds.',
        detail: "Filter by media type or clip length, search the chat's own messages, or read it oldest first.",
    },
    {
        icon: Tag,
        name: 'Keep the things worth finding again.',
        detail: 'Make your own tags, put them on anything, and filter a chat down to them later.',
        note: 'Tags are private — nobody else can see them.',
    },
    {
        icon: Download,
        name: 'Take exactly what you need.',
        detail: 'Download what you found without digging back through the conversation it arrived in.',
    },
];

/** The details that make the four above believable. Secondary on purpose. */
const DETAILS: string[] = [
    'Video plays and scrubs as it arrives, so a long recording starts in seconds rather than downloading in full first.',
    'Filters live in the URL, so a filtered view is a link you can send.',
    'Mediagram keeps your read position per chat, on every device you sign in from.',
    "Signing in uses Telegram's own device linking. Mediagram never asks for your password and never has one to lose.",
];

export function LandingFeatures() {
    return (
        <section aria-labelledby="features-heading">
            <h2
                id="features-heading"
                className="font-display mb-12 max-w-[15ch] text-4xl font-bold tracking-[-0.03em] text-balance sm:text-5xl"
            >
                Built for looking, not scrolling.
            </h2>

            <dl className="grid gap-x-16 sm:grid-cols-2">
                {FEATURES.map(({ icon: Icon, name, detail, note }) => (
                    <div
                        key={name}
                        className="border-border border-t py-7 first:border-t-0 sm:[&:nth-child(2)]:border-t-0"
                    >
                        <dt className="flex items-start gap-3">
                            <Icon
                                className="text-brand mt-1 size-5 shrink-0"
                                aria-hidden
                            />
                            <span className="font-display text-xl font-semibold tracking-tight text-balance">
                                {name}
                            </span>
                        </dt>
                        <dd className="mt-3 max-w-[46ch] pl-8">
                            <p className="text-foreground/75 text-pretty">
                                {detail}
                            </p>
                            {note ? (
                                <p className="text-muted-foreground mt-2 text-sm text-pretty">
                                    {note}
                                </p>
                            ) : null}
                        </dd>
                    </div>
                ))}
            </dl>

            <ul className="border-border text-muted-foreground mt-10 grid gap-x-16 gap-y-3 border-t pt-8 text-sm sm:grid-cols-2">
                {DETAILS.map((detail) => (
                    <li key={detail} className="flex gap-2.5">
                        <span
                            aria-hidden
                            className="bg-brand/60 mt-[0.55em] size-1 shrink-0 rounded-full"
                        />
                        <span className="max-w-[52ch] text-pretty">
                            {detail}
                        </span>
                    </li>
                ))}
            </ul>
        </section>
    );
}
