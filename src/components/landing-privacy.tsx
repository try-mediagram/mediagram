import { ConnectionDiagram } from '@/components/connection-diagram';

/**
 * The privacy claim, in plain English first.
 *
 * The architecture is the proof, not the pitch — so the sentence a visitor can
 * repeat to themselves comes first and the diagram sits underneath it as
 * evidence. Someone deciding whether to connect a Telegram account needs to
 * understand what happens to their media before they can be interested in how.
 */
export function LandingPrivacy() {
    return (
        <section
            id="privacy"
            aria-labelledby="privacy-heading"
            className="scroll-mt-20"
        >
            <h2
                id="privacy-heading"
                className="font-display max-w-[16ch] text-4xl font-bold tracking-[-0.03em] text-balance sm:text-5xl"
            >
                Your Telegram stays yours.
            </h2>

            <div className="mt-6 max-w-[54ch] space-y-4 text-lg">
                <p className="text-foreground/75 text-pretty">
                    Mediagram runs in your browser. Your Telegram chats and
                    media aren't uploaded to our servers — there is no copy on
                    our side to leak, subpoena or lose.
                </p>
                <p className="text-foreground font-medium text-pretty">
                    We only save the tags you create.
                </p>
                <p className="text-muted-foreground text-base text-pretty">
                    Nothing to import. Nothing to migrate.
                </p>
            </div>

            <figure className="mt-10">
                <div className="border-border bg-card/40 rounded-2xl border p-6 sm:p-10">
                    <ConnectionDiagram />
                </div>
                <figcaption className="text-muted-foreground mt-3 max-w-[62ch] text-sm text-pretty">
                    The media path runs straight between Telegram and this app
                    over MTProto. Mediagram's own data — your tags — stays in a
                    local database on your Mac.
                </figcaption>
            </figure>
        </section>
    );
}
