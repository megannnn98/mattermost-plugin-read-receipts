import {formatReadTime, getLocaleFromState, resolveLocale, t} from '../src/i18n';

describe('i18n', () => {
    it('resolves ru locale variants', () => {
        expect(resolveLocale('ru')).toBe('ru');
        expect(resolveLocale('ru-RU')).toBe('ru');
        expect(resolveLocale('RU')).toBe('ru');
    });

    it('falls back to en for unknown or missing locale', () => {
        expect(resolveLocale('de')).toBe('en');
        expect(resolveLocale('')).toBe('en');
        expect(resolveLocale(null)).toBe('en');
        expect(resolveLocale(undefined)).toBe('en');
    });

    it('reads the locale of the current user from the store state', () => {
        const state = {
            entities: {
                users: {
                    currentUserId: 'user1',
                    profiles: {user1: {locale: 'ru'}, user2: {locale: 'en'}},
                },
            },
        };
        expect(getLocaleFromState(state)).toBe('ru');
        expect(getLocaleFromState({})).toBe('en');
    });

    it('translates messages per locale', () => {
        expect(t('ru', 'read')).toBe('Прочитано');
        expect(t('en', 'read')).toBe('Read');
    });

    it('interpolates parameters', () => {
        expect(t('ru', 'readAt', {time: '17:42'})).toBe('Прочитано в 17:42');
        expect(t('en', 'readAt', {time: '17:42'})).toBe('Read at 17:42');
    });

    it('leaves unknown placeholders untouched', () => {
        expect(t('en', 'readAt', {})).toBe('Read at {time}');
    });

    it('formats the read time for the locale', () => {
        const readAt = Date.UTC(2026, 7, 24, 14, 42);
        expect(formatReadTime(readAt, 'ru')).toMatch(/^\d{2}:\d{2}$/);
        expect(formatReadTime(readAt, 'en')).toMatch(/\d{2}:\d{2}/);
    });
});
