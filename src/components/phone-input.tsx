import { ChevronsUpDown } from 'lucide-react';
import { type FormEvent, useId, useMemo, useState } from 'react';

import { BrandButton } from '@/components/brand-button';
import {
    Command,
    CommandEmpty,
    CommandInput,
    CommandItem,
    CommandList,
} from '@/components/ui/command';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from '@/components/ui/popover';
import { MARK_PATH } from '@/components/wordmark';
import { useVisitorCountry } from '@/hooks/use-entitlement';
import { COUNTRIES, dialFor, flagFor, searchCountries } from '@/lib/dial-codes';

/**
 * A phone number in two parts: the country, and the rest.
 *
 * Telegram wants E.164 and the old field asked for it in words — "International
 * format, like +15551234567" — which puts the burden of remembering a dialling
 * code on someone who is already being asked to trust a new site. The code is
 * something we can look up and they cannot, so we look it up: the edge tells us
 * the country (see App\Support\VisitorCountry), the picker opens on it, and the
 * visitor types the number they would read off their own phone.
 *
 * The guess is only ever a default. It is a header, so it is wrong for anyone
 * on a VPN or roaming, and the select is right there — which is also why the
 * country is a real control and not an invisible prefix.
 */
export function PhoneInput({
    onSubmit,
    invalid,
    error,
}: {
    /** Called with an E.164 number, plus included. */
    onSubmit: (phone: string) => void;
    /** Telegram rejected the last number. */
    invalid: boolean;
    error: string | null;
}) {
    const detected = useVisitorCountry();
    const id = useId();

    const initial = useMemo(() => {
        // Fall back to the US only so the field is never blank; every other
        // country is one keystroke away in an alphabetical native select.
        return dialFor(detected) ? detected!.toUpperCase() : 'US';
    }, [detected]);

    const [iso, setIso] = useState(initial);
    const [national, setNational] = useState('');

    const dial = dialFor(iso) ?? '1';
    const digits = national.replace(/\D/g, '');

    function handleSubmit(event: FormEvent) {
        event.preventDefault();
        if (!digits) return;
        onSubmit(`+${dial}${digits}`);
    }

    return (
        <form className="space-y-4" onSubmit={handleSubmit}>
            <SecureSeal />

            <div className="space-y-2">
                <Label htmlFor={`${id}-number`}>Phone number</Label>

                <div className="flex gap-2">
                    <CountryPicker value={iso} onChange={setIso} />

                    <Input
                        id={`${id}-number`}
                        value={national}
                        onChange={(event) => setNational(event.target.value)}
                        type="tel"
                        inputMode="tel"
                        autoComplete="tel-national"
                        placeholder="555 123 4567"
                        autoFocus
                        required
                    />
                </div>

                {/* What we will actually send, so nobody has to trust that the
                    two halves were joined the way they meant. */}
                <p className="text-muted-foreground text-sm tabular-nums">
                    {digits
                        ? `Telegram will text +${dial}${digits}`
                        : `${countryName(iso)} · +${dial}`}
                </p>
            </div>

            {invalid ? (
                <p className="text-destructive text-sm text-pretty">
                    Telegram did not accept that number. Check the country and
                    try again.
                </p>
            ) : null}
            {error ? <p className="text-destructive text-sm">{error}</p> : null}

            <BrandButton type="submit" className="w-full" disabled={!digits}>
                Continue
            </BrandButton>
        </form>
    );
}

/**
 * The mark, drawing itself into a shield.
 *
 * Handing a phone number to a site you met a minute ago is the most exposed
 * moment on the page, and it is also the moment the product's best fact is
 * true: the number goes into the Telegram client running in this tab and never
 * touches a Mediagram server, because there is no request here that could carry
 * it. So the claim is made where the hesitation is, under a seal rather than in
 * a footnote.
 *
 * The arrow is the wordmark's own path, not a copy of it. The motion runs once
 * and is off for anyone who asked for less — see the seal rules in app.css.
 */
function SecureSeal() {
    return (
        <div className="flex flex-col items-center pb-1 text-center">
            <svg viewBox="0 0 48 54" className="text-brand size-14" aria-hidden>
                <circle
                    cx="24"
                    cy="27"
                    r="14"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    className="seal-ring"
                />
                <path
                    d="M24 3 L43 10.5 V27 C43 39 34.5 47.5 24 51 C13.5 47.5 5 39 5 27 V10.5 Z"
                    className="fill-brand-subtle stroke-brand seal-outline"
                    strokeWidth="2"
                    strokeLinejoin="round"
                    pathLength={1}
                />
                <g transform="translate(15.2 18) scale(0.0439)">
                    <g className="seal-mark">
                        <path d={MARK_PATH} fill="currentColor" />
                    </g>
                </g>
            </svg>

            <p className="font-display mt-2 font-semibold tracking-tight">
                Mediagram
            </p>
            <p className="text-muted-foreground mt-1 max-w-[32ch] text-sm text-pretty">
                Your number goes straight to Telegram. Mediagram never sees it.
            </p>
        </div>
    );
}

/**
 * Choosing a country out of two hundred and forty-four.
 *
 * The native select this replaces listed rows as "MX +52" but sorted them by
 * country name, so the list could only be used by someone who already knew the
 * ISO code — scrolling for Mexico meant scanning for two letters in an order
 * nothing on screen explained. Now every row says the name, and the search
 * matches whichever of the three a person happens to reach for: "mexico", "mx"
 * or "52".
 *
 * The trigger stays narrow because it sits beside the number field and the
 * number is the thing being typed; the flag and the code are enough to confirm
 * a choice already made, and the full name is one press away.
 */
function CountryPicker({
    value,
    onChange,
}: {
    value: string;
    onChange: (iso: string) => void;
}) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');

    const results = useMemo(() => searchCountries(query), [query]);
    const dial = dialFor(value) ?? '1';

    return (
        <Popover
            open={open}
            onOpenChange={(next) => {
                setOpen(next);
                if (!next) setQuery('');
            }}
        >
            <PopoverTrigger
                render={
                    <button
                        type="button"
                        aria-label={`Country: ${countryName(value)}, +${dial}`}
                    />
                }
                className="border-input hover:bg-muted/50 focus-visible:border-ring focus-visible:ring-ring/50 flex h-8 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-sm transition-colors outline-none focus-visible:ring-3"
            >
                <span aria-hidden className="text-base leading-none">
                    {flagFor(value)}
                </span>
                <span className="tabular-nums">+{dial}</span>
                <ChevronsUpDown
                    className="text-muted-foreground size-3.5 shrink-0"
                    aria-hidden
                />
            </PopoverTrigger>

            <PopoverContent align="start" className="w-72 p-0">
                {/* Filtering is ours, not cmdk's: the query has to reach the
                    dialling code as well as the name, and a fuzzy scorer makes
                    "52" match half the world. */}
                <Command shouldFilter={false}>
                    <CommandInput
                        value={query}
                        onValueChange={setQuery}
                        placeholder="Search countries"
                        autoFocus
                    />
                    <CommandList className="max-h-64">
                        <CommandEmpty>No country matches that.</CommandEmpty>
                        {results.map((country) => (
                            <CommandItem
                                key={country.iso}
                                value={country.iso}
                                data-checked={country.iso === value}
                                onSelect={() => {
                                    onChange(country.iso);
                                    setOpen(false);
                                    setQuery('');
                                }}
                            >
                                <span
                                    aria-hidden
                                    className="text-base leading-none"
                                >
                                    {flagFor(country.iso)}
                                </span>
                                <span className="min-w-0 flex-1 truncate">
                                    {country.name}
                                </span>
                                <span className="text-muted-foreground shrink-0 tabular-nums">
                                    +{country.dial}
                                </span>
                            </CommandItem>
                        ))}
                    </CommandList>
                </Command>
            </PopoverContent>
        </Popover>
    );
}

function countryName(iso: string): string {
    return COUNTRIES.find((country) => country.iso === iso)?.name ?? iso;
}
