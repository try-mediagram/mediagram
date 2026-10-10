import {
    createContext,
    type ReactNode,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
} from 'react';

import { debug } from '@/lib/debug';
import { createDeferred, type Deferred } from '@/lib/deferred';
import { notifyAppReady } from '@/lib/desktop';
import type { AccountUser, TelegramCredentials } from '@/lib/telegram/types';

export type AuthStatus =
    | 'booting'
    | 'not-configured'
    | 'connecting'
    | 'qr'
    | 'qr-scanned'
    | 'password'
    | 'phone'
    | 'code'
    | 'ready'
    | 'error';

type LoginMode = 'qr' | 'phone';

/**
 * Which sign-in a device should open on.
 *
 * A QR code is a handshake between two devices: it works because the screen
 * showing it and the camera reading it belong to different machines. On a phone
 * they are the same machine, so we would be asking someone to scan a code with
 * the very device displaying it — a dead end that reads as the product being
 * broken rather than as the wrong flow. Phones therefore open on the number
 * form, which they can actually finish; everything else opens on the code,
 * which is faster and asks for less.
 *
 * Narrow AND coarse, so a desktop window dragged small keeps the code. Read
 * once, at mount: rotating a tablet mid-handshake must not restart it, and
 * pressing "Or use your phone number" is a decision that outranks this guess.
 */
function defaultLoginMode(): LoginMode {
    if (typeof window === 'undefined' || !window.matchMedia) return 'qr';

    return window.matchMedia('(max-width: 767px) and (pointer: coarse)').matches
        ? 'phone'
        : 'qr';
}

type TelegramContextValue = {
    status: AuthStatus;
    user: AccountUser | null;
    qrUrl: string | null;
    qrExpires: Date | null;
    passwordHint: string | null;
    error: string | null;
    invalidSecret: boolean;
    submitPassword: (password: string) => void;
    submitPhone: (phone: string) => void;
    submitCode: (code: string) => void;
    usePhoneInstead: () => void;
    useQrInstead: () => void;
    retry: () => void;
    logout: () => Promise<void>;
};

export const TelegramContext = createContext<TelegramContextValue | null>(null);

export function useTelegram() {
    const value = useContext(TelegramContext);
    if (!value) {
        throw new Error('useTelegram must be used inside TelegramProvider');
    }
    return value;
}

export function TelegramProvider({
    children,
    credentials: serverCredentials = null,
}: {
    children: ReactNode;
    /** Credentials shipped by the backend, so users never see the api_id form. */
    credentials?: TelegramCredentials | null;
}) {
    const [status, setStatus] = useState<AuthStatus>('booting');
    const [user, setUser] = useState<AccountUser | null>(null);
    const [qrUrl, setQrUrl] = useState<string | null>(null);
    const [qrExpires, setQrExpires] = useState<Date | null>(null);
    const [passwordHint, setPasswordHint] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [invalidSecret, setInvalidSecret] = useState(false);
    const [creds, setCreds] = useState<TelegramCredentials | null>(null);
    const [mode, setMode] = useState<LoginMode>(defaultLoginMode);
    const [bootId, setBootId] = useState(0);

    const abortRef = useRef<AbortController | null>(null);
    const passwordRef = useRef<Deferred<string> | null>(null);
    const phoneRef = useRef<Deferred<string> | null>(null);
    const codeRef = useRef<Deferred<string> | null>(null);
    const statusRef = useRef(status);
    statusRef.current = status;

    // The desktop splash stays up through booting and connecting, so the
    // main window opens straight onto the library or the sign-in screen.
    useEffect(() => {
        if (status !== 'booting' && status !== 'connecting') notifyAppReady();
    }, [status]);

    /** Stops listening for the session dying under a tab that is still open. */
    const unwatchRevokeRef = useRef<(() => void) | null>(null);

    /**
     * Telegram ended this session from its own side.
     *
     * Signing the browser out in Telegram → Settings → Devices kills the auth
     * key, and nothing else finds out: this window is the only place that
     * talks to Telegram. It hears AUTH_KEY_UNREGISTERED either at boot or on
     * the next call it makes, and has to drop the dead session.
     *
     * Same teardown as `logout()`, minus telling Telegram: Telegram is the side
     * that ended it. It also stays on the page rather than reloading, because
     * unlike a sign-out the user did not ask for this and the message is the
     * only thing that explains why the app just emptied.
     */
    const endRevokedSession = useCallback(async (caught: unknown) => {
        debug('auth', 'session revoked by Telegram', caught);

        unwatchRevokeRef.current?.();
        unwatchRevokeRef.current = null;
        abortRef.current?.abort();

        const [session, { describeTelegramError }] = await Promise.all([
            import('@/lib/telegram/session'),
            import('@/lib/telegram/errors'),
        ]);
        await session.logout({ tellTelegram: false });

        setUser(null);
        setError(describeTelegramError(caught));
        setStatus('error');
    }, []);

    useEffect(() => {
        if (serverCredentials) setCreds(serverCredentials);
        else setStatus('not-configured');
    }, [serverCredentials]);

    useEffect(() => {
        if (!creds) return;
        void bootId;

        const abort = new AbortController();
        abortRef.current = abort;
        let cancelled = false;

        /**
         * Everything a live session needs once it is signed in, whichever
         * way it got there.
         */
        const watchSession = async () => {
            // The revocation can also land on a tab that is already open,
            // long after this boot succeeded. mtcute surfaces it on the
            // client rather than in any one call we make.
            const { getClient } = await import('@/lib/telegram/client');
            const tg = getClient();
            const onClientError = (caught: Error) => {
                void import('@/lib/telegram/errors').then(
                    ({ isSessionRevokedError }) => {
                        if (isSessionRevokedError(caught)) {
                            void endRevokedSession(caught);
                        }
                    },
                );
            };
            tg.onError.add(onClientError);
            unwatchRevokeRef.current = () => tg.onError.remove(onClientError);
            void import('@/lib/telegram/progressive').then((mod) =>
                mod.ensureProgressiveBridge().catch(() => undefined),
            );
        };

        const run = async () => {
            setError(null);
            setInvalidSecret(false);
            setStatus('connecting');
            try {
                const session = await import('@/lib/telegram/session');

                // A browser that is already signed in opens straight into the
                // app off the session on disk. Telegram's confirmation follows
                // in the background; only a revoked session undoes this.
                const restored = await session.restoreSession(creds);
                if (cancelled) return;
                if (restored) {
                    debug('auth', 'restored', { id: restored.id });
                    setUser(restored);
                    setStatus('ready');
                    await watchSession();
                    session
                        .verifySession()
                        .then((account) => {
                            if (!cancelled) setUser(account);
                        })
                        .catch(async (caught: unknown) => {
                            const { isSessionRevokedError } = await import(
                                '@/lib/telegram/errors'
                            );
                            if (cancelled) return;
                            if (isSessionRevokedError(caught)) {
                                await endRevokedSession(caught);
                                return;
                            }
                            // Offline, or Telegram slow to answer. The session
                            // is still good; the next call reconnects.
                            debug('auth', 'verify deferred', caught);
                        });
                    return;
                }

                const hooks = {
                    onQr: (url: string, expires: Date) => {
                        if (cancelled) return;
                        setQrUrl(url);
                        setQrExpires(expires);
                        setStatus('qr');
                    },
                    onQrScanned: () => {
                        // Telegram has the code; the rest is its business and
                        // can take a moment. Saying so is the difference
                        // between waiting and assuming it failed.
                        if (cancelled) return;
                        setStatus('qr-scanned');
                    },
                    onPassword: async (hint: string | null) => {
                        setPasswordHint(hint);
                        setStatus('password');
                        passwordRef.current = createDeferred<string>();
                        return passwordRef.current.promise;
                    },
                    onInvalidPassword: () => {
                        setInvalidSecret(true);
                    },
                    onInvalidCode: () => {
                        setInvalidSecret(true);
                    },
                    onPhone: async () => {
                        setStatus('phone');
                        phoneRef.current = createDeferred<string>();
                        return phoneRef.current.promise;
                    },
                    onCode: async () => {
                        setStatus('code');
                        codeRef.current = createDeferred<string>();
                        return codeRef.current.promise;
                    },
                    onCodeSent: () => {
                        setStatus('code');
                    },
                };

                const account =
                    mode === 'phone'
                        ? await session.loginWithPhone(
                              creds,
                              hooks,
                              abort.signal,
                          )
                        : await session.loginWithQr(creds, hooks, abort.signal);

                if (cancelled) return;
                debug('auth', 'signed in', {
                    id: account.id,
                    username: account.username,
                });
                setUser(account);
                setStatus('ready');
                await watchSession();
            } catch (caught) {
                const {
                    isAbortError,
                    isSessionRevokedError,
                    describeTelegramError,
                } = await import('@/lib/telegram/errors');
                if (cancelled || isAbortError(caught)) return;
                debug('auth', 'login failed', caught);

                if (isSessionRevokedError(caught)) {
                    await endRevokedSession(caught);
                    return;
                }

                const { resetClient } = await import('@/lib/telegram/client');
                await resetClient();
                setError(describeTelegramError(caught));
                setStatus('error');
            }
        };

        void run();

        return () => {
            cancelled = true;
            unwatchRevokeRef.current?.();
            unwatchRevokeRef.current = null;
            if (statusRef.current !== 'ready') abort.abort();
        };
    }, [creds, mode, bootId, endRevokedSession]);

    const submitPassword = useCallback((password: string) => {
        setInvalidSecret(false);
        passwordRef.current?.resolve(password);
    }, []);

    const submitPhone = useCallback((phone: string) => {
        setInvalidSecret(false);
        phoneRef.current?.resolve(phone);
    }, []);

    const submitCode = useCallback((code: string) => {
        setInvalidSecret(false);
        codeRef.current?.resolve(code);
    }, []);

    const usePhoneInstead = useCallback(() => {
        abortRef.current?.abort();
        setQrUrl(null);
        setMode('phone');
        setBootId((value) => value + 1);
    }, []);

    const useQrInstead = useCallback(() => {
        abortRef.current?.abort();
        setMode('qr');
        setStatus('connecting');
        setBootId((value) => value + 1);
    }, []);

    const retry = useCallback(() => {
        abortRef.current?.abort();
        setError(null);
        setStatus('connecting');
        setBootId((value) => value + 1);
    }, []);

    /** Sign this window out of Telegram. */
    const logout = useCallback(async () => {
        abortRef.current?.abort();
        unwatchRevokeRef.current?.();
        unwatchRevokeRef.current = null;

        try {
            const session = await import('@/lib/telegram/session');
            await session.logout();
        } finally {
            // A full load, not an Inertia visit. It is the only teardown that
            // cannot leave this provider's state, the module-level caches or a
            // stale shared prop behind, and it removes the race where the boot
            // effect restarted a session that was still being torn down.
            window.location.assign('/');
        }
    }, []);

    const value = useMemo<TelegramContextValue>(
        () => ({
            status,
            user,
            qrUrl,
            qrExpires,
            passwordHint,
            error,
            invalidSecret,
            submitPassword,
            submitPhone,
            submitCode,
            usePhoneInstead,
            useQrInstead,
            retry,
            logout,
        }),
        [
            status,
            user,
            qrUrl,
            qrExpires,
            passwordHint,
            error,
            invalidSecret,
            submitPassword,
            submitPhone,
            submitCode,
            usePhoneInstead,
            useQrInstead,
            retry,
            logout,
        ],
    );

    return (
        <TelegramContext.Provider value={value}>
            {children}
        </TelegramContext.Provider>
    );
}
