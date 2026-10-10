import { ArrowRight, ShieldCheck } from 'lucide-react';
import { useEffect } from 'react';

import { LandingDemo } from '@/components/landing-demo';
import { LandingFeatures } from '@/components/landing-features';
import { LandingPrivacy } from '@/components/landing-privacy';
import { SignInSection } from '@/components/sign-in-panel';
import { ThemeToggle } from '@/components/theme-toggle';
import { BrandButton } from '@/components/brand-button';
import { Button } from '@/components/ui/button';
import { Wordmark } from '@/components/wordmark';
import { track, trackOnce } from '@/lib/analytics';

/**
 * The landing page, and the only thing anyone sees before they sign in.
 *
 * Its one job is to make a visitor want to press "Find my media" — so the order
 * is want, then trust, then connect. The product is shown before it is
 * explained and long before anything is asked for; the sign-in that used to be
 * the hero is now the last thing on the page, because connecting a Telegram
 * account is a far bigger decision than a signup form and nobody makes it for a
 * product they have not seen.
 *
 * The nav offers one thing to press.
 */
export function LoginScreen() {
    useEffect(() => trackOnce('landing_view'), []);

    return (
        <div className="flex min-h-dvh flex-col">
            <header className="border-border bg-background/85 sticky top-0 z-30 border-b backdrop-blur-sm">
                <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-6 py-3 sm:px-8">
                    <Wordmark size="md" />
                    <nav className="flex items-center gap-1">
                        <Button
                            variant="ghost"
                            size="sm"
                            className="text-muted-foreground hidden sm:inline-flex"
                            render={<a href="#how" />}
                            nativeButton={false}
                        >
                            How it works
                        </Button>
                        <Button
                            variant="ghost"
                            size="sm"
                            className="text-muted-foreground hidden sm:inline-flex"
                            render={<a href="#privacy" />}
                            nativeButton={false}
                        >
                            Privacy
                        </Button>
                        {/* The toggle also lives in AccountBar, but that only
                            exists once you are signed in — and this screen is
                            what everyone sees first, in whatever ambient light
                            they are actually in. */}
                        <ThemeToggle />
                        <BrandButton
                            size="sm"
                            className="ml-1"
                            render={<a href="#connect" />}
                            nativeButton={false}
                            onClick={() => track('cta_click', { at: 'nav' })}
                        >
                            Try it
                            <ArrowRight aria-hidden />
                        </BrandButton>
                    </nav>
                </div>
            </header>

            <main className="flex-1">
                <div className="mx-auto w-full max-w-6xl px-6 sm:px-8">
                    <section className="pt-16 pb-12 sm:pt-24 sm:pb-16">
                        <h1 className="font-display max-w-[19ch] text-5xl leading-[0.98] font-bold tracking-[-0.03em] text-balance sm:text-6xl lg:text-7xl">
                            Find anything you've ever sent on Telegram.
                        </h1>

                        <p className="text-foreground/80 mt-7 max-w-[46ch] text-xl leading-snug text-pretty sm:text-2xl">
                            Mediagram turns your Telegram chats into a
                            searchable media library.
                        </p>
                        <p className="text-muted-foreground mt-4 max-w-[52ch] text-lg text-pretty">
                            Search photos, videos, GIFs, music and voice notes.
                            Filter them. Tag them. Find them again.
                        </p>

                        <div className="mt-9 flex flex-wrap items-center gap-x-5 gap-y-4">
                            <BrandButton
                                size="lg"
                                className="h-12 gap-2 px-6 text-base"
                                render={<a href="#connect" />}
                                nativeButton={false}
                                onClick={() =>
                                    track('cta_click', { at: 'hero' })
                                }
                            >
                                Find my media
                                <ArrowRight className="size-4" aria-hidden />
                            </BrandButton>

                            <ul className="text-muted-foreground flex flex-wrap items-center gap-x-2 text-sm">
                                <li>Free</li>
                                <li aria-hidden>·</li>
                                <li>No account</li>
                                <li aria-hidden>·</li>
                                <li>Sign in with Telegram</li>
                            </ul>
                        </div>

                        <p className="text-foreground/85 mt-8 flex items-center gap-2 text-sm font-medium">
                            <ShieldCheck
                                className="text-brand size-4 shrink-0"
                                aria-hidden
                            />
                            Your Telegram media never leaves your browser.
                        </p>
                    </section>

                    {/* The product, before anything is asked for. */}
                    <section
                        id="how"
                        aria-labelledby="how-heading"
                        className="scroll-mt-20 pb-6"
                    >
                        <h2 id="how-heading" className="sr-only">
                            Mediagram, in one chat
                        </h2>
                        <LandingDemo />
                        <p className="text-muted-foreground mt-3 max-w-[62ch] text-sm text-pretty">
                            One chat's media, all at once. This one is live —
                            search it, filter it, press a tag.
                        </p>
                    </section>

                    <section
                        aria-labelledby="pain-heading"
                        className="py-24 sm:py-32"
                    >
                        <h2
                            id="pain-heading"
                            className="font-display max-w-[20ch] text-4xl font-bold tracking-[-0.03em] text-balance sm:text-5xl"
                        >
                            Telegram keeps everything. Finding it is the hard
                            part.
                        </h2>

                        <div className="mt-8 max-w-[46ch] space-y-2 text-xl leading-relaxed sm:text-2xl">
                            <p className="text-muted-foreground">
                                That photo from three years ago.
                            </p>
                            <p className="text-muted-foreground">
                                That video from a group chat.
                            </p>
                            <p className="text-muted-foreground">
                                That voice note you meant to save.
                            </p>
                        </div>

                        <p className="text-foreground mt-8 max-w-[42ch] text-xl text-pretty sm:text-2xl">
                            You know it's in there.{' '}
                            <span className="font-display font-semibold">
                                Good luck scrolling back to find it.
                            </span>
                        </p>

                        <p className="border-border font-display text-brand-text mt-10 border-t pt-8 text-2xl font-semibold tracking-tight sm:text-3xl">
                            Mediagram lets you look instead.
                        </p>
                    </section>

                    <LandingFeatures />

                    <div className="py-24 sm:py-32">
                        <LandingPrivacy />
                    </div>

                    <div className="pb-24 sm:pb-32">
                        <SignInSection />
                    </div>
                </div>
            </main>

            <footer className="border-border border-t">
                <div className="text-muted-foreground mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-6 py-8 text-sm sm:px-8">
                    <span>© {new Date().getFullYear()} Mediagram</span>
                </div>
            </footer>
        </div>
    );
}
