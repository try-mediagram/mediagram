import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import {
    Bell,
    LogOut,
    Monitor,
    Moon,
    Sun,
    Tag as TagIcon,
    Volume2,
} from 'lucide-react';
import { useTheme } from 'next-themes';

import { ThemeToggle } from '@/components/theme-toggle';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
    DropdownMenu,
    DropdownMenuCheckboxItem,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Slider } from '@/components/ui/slider';
import {
    playSound,
    setSoundSettings,
    useSoundSettings,
} from '@/lib/notify-sound';
import { useTelegram } from '@/providers/telegram-provider';

import type { AccountUser } from '@/lib/telegram/types';

/**
 * Everything account-shaped in the nav, behind one avatar.
 *
 * The bar used to carry a theme button, a name and a log-out button side by
 * side; that is three controls spent on things done once a session. They live
 * in here now, which leaves the bar for navigation.
 *
 * A guest has no menu to open — they still get the theme control, because
 * choosing dark is not an account action.
 */
export function UserMenu() {
    const { user, logout } = useTelegram();

    if (!user) {
        return <ThemeToggle />;
    }

    return (
        <DropdownMenu>
            <DropdownMenuTrigger
                render={
                    <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label="Account menu"
                        className="shrink-0 rounded-full p-0"
                    />
                }
            >
                <AccountAvatar user={user} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
                {/*
                    A plain div, not DropdownMenuLabel: that renders Base UI's
                    Menu.GroupLabel, which throws unless it is inside a
                    Menu.Group or Menu.RadioGroup. This heading names the
                    account, not a group of items.
                */}
                <div className="flex items-center gap-2 px-1.5 py-1.5">
                    <AccountAvatar user={user} />
                    <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">
                            {user.name}
                        </p>
                        {user.username ? (
                            <p className="text-muted-foreground truncate text-xs">
                                @{user.username}
                            </p>
                        ) : null}
                    </div>
                </div>

                <DropdownMenuSeparator />
                <ThemeChoice />

                <DropdownMenuSeparator />
                <SoundChoice />

                <DropdownMenuSeparator />

                <DropdownMenuItem render={<Link to="/tags" />}>
                    <TagIcon />
                    Your tags
                </DropdownMenuItem>

                <DropdownMenuSeparator />
                <DropdownMenuItem
                    variant="destructive"
                    onClick={() => void logout()}
                >
                    <LogOut />
                    Log out
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

/**
 * Light, dark, or whatever the device says.
 *
 * The menu can offer all three where the bar's toggle could only flip between
 * two, so `theme` is read here rather than `resolvedTheme` — the checked row is
 * the choice, not its outcome.
 *
 * No mounted guard, and `value` is never undefined: the popup is only mounted
 * once it is opened, which is long past hydration, and a group that starts
 * undefined switches from uncontrolled to controlled under Base UI.
 */
function ThemeChoice() {
    const { theme, setTheme } = useTheme();

    return (
        <DropdownMenuRadioGroup
            value={theme ?? 'system'}
            onValueChange={(value) => setTheme(String(value))}
        >
            <DropdownMenuLabel>Theme</DropdownMenuLabel>
            <DropdownMenuRadioItem value="light">
                <Sun />
                Light
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="dark">
                <Moon />
                Dark
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="system">
                <Monitor />
                System
            </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
    );
}

/** Notification sounds on or off, and a way to hear what they sound like. */
function SoundChoice() {
    const sounds = useSoundSettings();

    return (
        <>
            <DropdownMenuCheckboxItem
                checked={sounds.enabled}
                onCheckedChange={(checked) =>
                    setSoundSettings({ enabled: Boolean(checked) })
                }
            >
                <Bell />
                Notification sounds
            </DropdownMenuCheckboxItem>
            <DropdownMenuItem
                closeOnClick={false}
                onClick={() => playSound('background', { force: true })}
            >
                <Volume2 />
                Play test sound
            </DropdownMenuItem>
            {/*
                Not a menu item: the arrow keys belong to the slider here, and
                the cue plays on release so the level can be heard.
            */}
            <div className="flex items-center gap-3 px-2 py-2">
                <span className="text-muted-foreground w-12 text-xs">
                    Volume
                </span>
                <Slider
                    aria-label="Notification volume"
                    disabled={!sounds.enabled}
                    min={0}
                    max={100}
                    value={[Math.round(sounds.volume * 100)]}
                    onValueChange={(value) => {
                        const level = Array.isArray(value) ? value[0] : value;
                        setSoundSettings({ volume: (level ?? 0) / 100 });
                    }}
                    onValueCommitted={() =>
                        playSound('background', { force: true })
                    }
                    className="flex-1"
                />
            </div>
        </>
    );
}

function AccountAvatar({ user }: { user: AccountUser }) {
    const src = useSelfAvatar(user.id);

    return (
        <Avatar className="size-8">
            {src ? <AvatarImage src={src} alt="" /> : null}
            <AvatarFallback className="text-xs font-semibold">
                {initials(user.name)}
            </AvatarFallback>
        </Avatar>
    );
}

/**
 * The account's own photo, downloaded over MTProto like every other avatar —
 * it never passes through Laravel. Cached for the session: a profile photo does
 * not change while someone browses, and the blob url is shared.
 */
function useSelfAvatar(id: number): string | null {
    const avatar = useQuery({
        queryKey: ['self-avatar', id],
        staleTime: Infinity,
        retry: false,
        queryFn: async () => {
            const { downloadSelfAvatar } = await import(
                '@/lib/telegram/dialogs'
            );
            return (await downloadSelfAvatar()) ?? null;
        },
    });

    return avatar.data ?? null;
}

function initials(name: string): string {
    const parts = name.trim().split(/\s+/).slice(0, 2);
    return parts.map((part) => part[0]?.toUpperCase() ?? '').join('') || '·';
}
