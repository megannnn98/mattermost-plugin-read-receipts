export type SupportedLocale = 'en' | 'ru';

const MESSAGES = {
    en: {
        read: 'Read',
        readAt: 'Read at {time}',
    },
    ru: {
        read: 'Прочитано',
        readAt: 'Прочитано в {time}',
    },
} as const;

export type MessageKey = keyof (typeof MESSAGES)['en'];

const LOCALE_TAGS: Record<SupportedLocale, string> = {
    en: 'en-US',
    ru: 'ru-RU',
};

export function resolveLocale(raw?: string | null): SupportedLocale {
    if (!raw) {
        return 'en';
    }
    return raw.toLowerCase().startsWith('ru') ? 'ru' : 'en';
}

export function getLocaleFromState(state: any): SupportedLocale {
    const users = state?.entities?.users;
    const profile = users?.profiles?.[users?.currentUserId];
    return resolveLocale(profile?.locale);
}

export function t(
    locale: SupportedLocale,
    key: MessageKey,
    params: Record<string, string> = {},
): string {
    const template = MESSAGES[locale]?.[key] ?? MESSAGES.en[key];
    return template.replace(/\{(\w+)\}/g, (match, name) => params[name] ?? match);
}

export function formatReadTime(readAt: number, locale: SupportedLocale): string {
    return new Date(readAt).toLocaleTimeString(LOCALE_TAGS[locale], {
        hour: '2-digit',
        minute: '2-digit',
    });
}
