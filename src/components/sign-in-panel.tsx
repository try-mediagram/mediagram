import { Check, KeyRound, ServerOff, UserRoundX } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import {
    type FormEvent,
    type HTMLAttributes,
    type ReactNode,
    useEffect,
    useRef,
    useState,
} from 'react';

import { PhoneInput } from '@/components/phone-input';
import { BrandButton } from '@/components/brand-button';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
    InputOTP,
    InputOTPGroup,
    InputOTPSlot,
} from '@/components/ui/input-otp';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { trackOnce } from '@/lib/analytics';
import { useTelegram } from '@/providers/telegram-provider';

/** Telegram's login codes are five digits. */
const CODE_LENGTH = 5;

/**
 * The ask, at the bottom of the page.
 *
 * Connecting a Telegram account is a much larger decision than a signup form,
 * so this comes after the argument rather than before it — and it carries its
 * own reassurance rather than relying on the visitor having read the privacy
 * section on the way down. The three guarantees sit beside the code, where the
 * hesitation actually happens.
 *
 * Every state of the handshake lands in the same box, and the box keeps its
 * height, so swapping between the code and a one-field form does not move the
 * page under someone who is mid-decision.
 */
export function SignInSection() {
    const { status } = useTelegram();
    const section = useRef<HTMLElement>(null);

    /*
     * `telegram_auth_started` is "the visitor arrived at the decision", not
     * "a code was scanned" — the browser cannot see a scan until Telegram
     * answers. Read it against cta_click: a gap there is the page failing to
     * carry people down, and a gap between here and completed is the Telegram
     * handshake itself. The submit handlers fire the same event for the phone
     * path, and trackOnce keeps it one count either way.
     */
    useEffect(() => {
        const node = section.current;
        if (!node || typeof IntersectionObserver === 'undefined') return;

        const observer = new IntersectionObserver(
            (entries) => {
                if (entries.some((entry) => entry.isIntersecting)) {
                    trackOnce('telegram_auth_started', { surface: 'landing' });
                    observer.disconnect();
                }
            },
            { threshold: 0.4 },
        );

        observer.observe(node);
        return () => observer.disconnect();
    }, []);

    useEffect(() => {
        if (status === 'ready') trackOnce('telegram_auth_completed');
    }, [status]);

    return (
        <section
            ref={section}
            id="connect"
            aria-labelledby="connect-heading"
            className="scroll-mt-8"
        >
            <h2
                id="connect-heading"
                className="font-display text-4xl font-bold tracking-[-0.03em] text-balance sm:text-5xl"
            >
                Ready to find your media?
            </h2>
            <p className="text-foreground/75 mt-3 max-w-[46ch] text-lg text-pretty">
                Connect your Telegram and start looking.
            </p>

            <div className="border-brand-border bg-brand-subtle mt-8 grid gap-8 rounded-2xl border p-6 sm:p-8 lg:grid-cols-[auto_minmax(0,1fr)] lg:items-center lg:gap-12">
                <SignInPanel />

                <div>
                    <dl className="space-y-6">
                        <Guarantee icon={KeyRound} term="No password.">
                            Telegram's own device linking. Mediagram never asks
                            for your cloud password and never has one to lose.
                        </Guarantee>
                        <Guarantee icon={ServerOff} term="No media upload.">
                            Your browser holds the connection. Photos and video
                            go straight from Telegram to you.
                        </Guarantee>
                        <Guarantee
                            icon={UserRoundX}
                            term="No account to create."
                        >
                            You sign in with the Telegram account you already
                            have. There is nothing else to fill in.
                        </Guarantee>
                    </dl>
                </div>
            </div>
        </section>
    );
}

function Guarantee({
    icon: Icon,
    term,
    children,
}: {
    icon: typeof KeyRound;
    term: string;
    children: ReactNode;
}) {
    return (
        <div className="flex gap-3">
            <Icon
                className="text-brand-text mt-1 size-5 shrink-0"
                aria-hidden
            />
            <div>
                <dt className="font-display text-lg font-semibold tracking-tight">
                    {term}
                </dt>
                <dd className="text-brand-subtle-foreground mt-1.5 max-w-[64ch] text-pretty">
                    {children}
                </dd>
            </div>
        </div>
    );
}

/**
 * Every state the Telegram handshake can be in, in one box.
 *
 * Width and height are both pinned, to the tallest state — the code. A visitor
 * who switches to the phone form is mid-decision, and a box that shrinks under
 * them takes the guarantees beside it and the whole page below it along for the
 * ride. The short states sit centred in the space the code would have used.
 */
function SignInPanel() {
    const {
        status,
        qrUrl,
        passwordHint,
        error,
        invalidSecret,
        submitPassword,
        submitPhone,
        submitCode,
        usePhoneInstead,
        useQrInstead,
        retry,
    } = useTelegram();

    /*
     * Telegram tells us the moment the code is read, well before it finishes
     * signing in. Holding the plain code on screen through that gap is what
     * made a scan that worked look like one that had not: nothing on the page
     * changed, so the only thing left to do was scan again.
     */
    const scanned = status === 'qr-scanned';

    function started<T>(submit: (value: T) => void) {
        return (value: T) => {
            trackOnce('telegram_auth_started', { surface: 'landing' });
            submit(value);
        };
    }

    return (
        <div className="border-border bg-card flex min-h-[28.5rem] w-full flex-col justify-center rounded-xl border p-5 lg:w-[23rem]">
            {status === 'not-configured' ? (
                <p className="text-destructive text-center text-sm text-pretty">
                    Sign-in is unavailable right now. Please try again shortly.
                </p>
            ) : null}

            {status === 'connecting' || status === 'booting' ? (
                <div className="flex flex-col items-center gap-3">
                    <div className="pulse-mark" />
                    <p className="text-muted-foreground text-sm">
                        Waiting on Telegram…
                    </p>
                </div>
            ) : null}

            {(status === 'qr' || scanned) && qrUrl ? (
                <div className="flex flex-col items-center">
                    {/* Warm paper rather than white: the code has to stay a
                        light plate in both themes for a camera to read it, and
                        cream says "object on the page" where white says
                        "hole". */}
                    <div className="relative rounded-xl bg-[#f4efe6] p-3">
                        <div
                            className={
                                scanned
                                    ? 'opacity-15 transition-opacity'
                                    : 'transition-opacity'
                            }
                        >
                            <QRCodeSVG
                                value={qrUrl}
                                size={208}
                                bgColor="#f4efe6"
                                fgColor="#14110e"
                                level="M"
                            />
                        </div>

                        {scanned ? (
                            <div className="absolute inset-0 grid place-items-center">
                                <div className="bg-brand-solid text-brand-solid-foreground grid size-14 place-items-center rounded-full">
                                    <Check className="size-7" aria-hidden />
                                </div>
                            </div>
                        ) : null}
                    </div>

                    {scanned ? (
                        <>
                            <p className="text-foreground mt-4 text-sm font-medium">
                                Code scanned
                            </p>
                            <p
                                aria-live="polite"
                                className="text-muted-foreground mt-2 flex items-center gap-2 text-xs text-pretty"
                            >
                                <Spinner className="size-3.5" />
                                Finishing sign-in. Confirm on your phone if
                                Telegram asks.
                            </p>
                        </>
                    ) : (
                        <>
                            <p className="text-foreground mt-4 text-sm font-medium">
                                Scan with Telegram
                            </p>
                            <ol className="text-muted-foreground mt-3 w-full space-y-1.5 text-xs">
                                <Step n={1}>
                                    On your phone, open Telegram → Settings →
                                    Devices.
                                </Step>
                                <Step n={2}>Tap “Link desktop device”.</Step>
                                <Step n={3}>Scan the code above.</Step>
                            </ol>
                            <p className="text-muted-foreground mt-3 text-xs">
                                The code refreshes on its own if it expires.
                            </p>
                            <Button
                                variant="ghost"
                                size="sm"
                                className="text-brand-text mt-3"
                                onClick={usePhoneInstead}
                            >
                                Or use your phone number
                            </Button>
                        </>
                    )}
                </div>
            ) : null}

            {status === 'password' ? (
                <SecretForm
                    label="Two-step password"
                    hint={
                        passwordHint
                            ? `Hint: ${passwordHint}`
                            : 'Your Telegram cloud password'
                    }
                    invalid={invalidSecret}
                    error={error}
                    onSubmit={started(submitPassword)}
                    type="password"
                />
            ) : null}

            {status === 'phone' ? (
                <div className="space-y-3">
                    <PhoneInput
                        invalid={invalidSecret}
                        error={error}
                        onSubmit={started(submitPhone)}
                    />
                    <Button
                        variant="ghost"
                        size="sm"
                        className="w-full"
                        onClick={useQrInstead}
                    >
                        Back to the code
                    </Button>
                </div>
            ) : null}

            {status === 'code' ? (
                <CodeForm
                    invalid={invalidSecret}
                    error={error}
                    onSubmit={started(submitCode)}
                />
            ) : null}

            {status === 'error' ? (
                <div className="space-y-3">
                    <p className="text-destructive text-sm text-pretty">
                        {error}
                    </p>
                    <BrandButton className="w-full" onClick={retry}>
                        Try again
                    </BrandButton>
                </div>
            ) : null}
        </div>
    );
}

/**
 * Telegram's login code, one box per digit.
 *
 * Codes arrive in the Telegram app on another device, so this is read off one
 * screen and typed into another — the slots keep your place in a way a single
 * field does not, and a wrong count is visible before you submit rather than
 * after Telegram rejects it.
 *
 * It submits itself on the last digit, because at that point there is nothing
 * left to decide. The button stays for the cases where autofill fills the whole
 * thing at once and for anyone driving this from the keyboard.
 */
function CodeForm({
    invalid,
    error,
    onSubmit,
}: {
    invalid: boolean;
    error: string | null;
    onSubmit: (code: string) => void;
}) {
    const [code, setCode] = useState('');

    function submit(value: string) {
        if (value.length < CODE_LENGTH) return;
        onSubmit(value);
        setCode('');
    }

    return (
        <form
            className="flex flex-col items-center gap-4"
            onSubmit={(event) => {
                event.preventDefault();
                submit(code);
            }}
        >
            <div className="w-full space-y-2 text-center">
                <Label htmlFor="login-code">Login code</Label>
                <p className="text-muted-foreground text-sm text-pretty">
                    Telegram just sent this to your Telegram app.
                </p>
            </div>

            <InputOTP
                id="login-code"
                maxLength={CODE_LENGTH}
                value={code}
                onChange={setCode}
                onComplete={submit}
                autoFocus
                aria-invalid={invalid}
                containerClassName="justify-center"
            >
                <InputOTPGroup>
                    {Array.from({ length: CODE_LENGTH }, (_, index) => (
                        <InputOTPSlot
                            key={index}
                            index={index}
                            className="size-11 text-base tabular-nums"
                        />
                    ))}
                </InputOTPGroup>
            </InputOTP>

            {invalid ? (
                <p className="text-destructive text-sm text-pretty">
                    That code was not accepted. Check the digits and try again.
                </p>
            ) : null}
            {error ? <p className="text-destructive text-sm">{error}</p> : null}

            <BrandButton
                type="submit"
                className="w-full"
                disabled={code.length < CODE_LENGTH}
            >
                Continue
            </BrandButton>
        </form>
    );
}

function Step({ n, children }: { n: number; children: ReactNode }) {
    return (
        <li className="flex gap-2">
            <span className="bg-muted text-foreground mt-px grid size-4 shrink-0 place-items-center rounded-full text-[10px] font-semibold tabular-nums">
                {n}
            </span>
            <span className="text-pretty">{children}</span>
        </li>
    );
}

function SecretForm({
    label,
    hint,
    invalid,
    error,
    onSubmit,
    type = 'text',
    inputMode,
}: {
    label: string;
    hint: string;
    invalid: boolean;
    error: string | null;
    onSubmit: (value: string) => void;
    type?: string;
    inputMode?: HTMLAttributes<HTMLInputElement>['inputMode'];
}) {
    const [value, setValue] = useState('');

    function handleSubmit(event: FormEvent) {
        event.preventDefault();
        if (!value.trim()) return;
        onSubmit(value.trim());
        setValue('');
    }

    return (
        <form className="space-y-4" onSubmit={handleSubmit}>
            <div className="space-y-2">
                <Label htmlFor={label}>{label}</Label>
                <Input
                    id={label}
                    value={value}
                    onChange={(event) => setValue(event.target.value)}
                    type={type}
                    inputMode={inputMode}
                    autoFocus
                    required
                />
                <p className="text-muted-foreground text-sm">{hint}</p>
            </div>
            {invalid ? (
                <p className="text-destructive text-sm">
                    That was not accepted. Try again.
                </p>
            ) : null}
            {error ? <p className="text-destructive text-sm">{error}</p> : null}
            <BrandButton type="submit" className="w-full">
                Continue
            </BrandButton>
        </form>
    );
}
