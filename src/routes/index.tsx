import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';

import { LoginScreen } from '@/components/login-screen';
import { useTelegram } from '@/providers/telegram-provider';

export const Route = createFileRoute('/')({
    head: () => ({
        meta: [{ title: 'Find anything in your Telegram - Mediagram' }],
    }),
    component: Login,
});

function Login() {
    const { status } = useTelegram();
    const navigate = useNavigate();

    useEffect(() => {
        if (status === 'ready') void navigate({ to: '/chats' });
    }, [status, navigate]);

    return <LoginScreen />;
}
