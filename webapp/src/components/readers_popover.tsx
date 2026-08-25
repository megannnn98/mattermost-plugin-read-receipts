import React, {useEffect, useRef} from 'react';
import {createPortal} from 'react-dom';

import {formatReadTime, SupportedLocale, t} from '../i18n';
import {ReaderRead} from '../types';

export const POPOVER_MAX_ROWS = 20;

export type ReadersStatus = 'loading' | 'ready' | 'error';

interface ReadersPopoverProps {
    anchor: HTMLElement;
    readers: ReaderRead[];
    status: ReadersStatus;
    truncated: boolean;
    profiles: Record<string, {username?: string; first_name?: string; last_name?: string}>;
    locale: SupportedLocale;
    onClose: () => void;
}

function profileName(profile: {username?: string; first_name?: string; last_name?: string} | undefined, userId: string): string {
    const fullName = [profile?.first_name, profile?.last_name].filter(Boolean).join(' ');
    return fullName || profile?.username || userId;
}

export const ReadersPopover: React.FC<ReadersPopoverProps> = ({anchor, readers, status, truncated, profiles, locale, onClose}) => {
    const ref = useRef<HTMLDivElement>(null);
    const rect = anchor.getBoundingClientRect();
    const estimatedHeight = Math.min(readers.length, POPOVER_MAX_ROWS) * 24 + 48;
    const top = rect.bottom + 8 + estimatedHeight > window.innerHeight ? Math.max(8, rect.top - estimatedHeight - 8) : rect.bottom + 8;

    useEffect(() => {
        const closeOutside = (event: MouseEvent) => {
            if (!ref.current?.contains(event.target as Node) && event.target !== anchor) onClose();
        };
        const closeEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
        document.addEventListener('mousedown', closeOutside);
        document.addEventListener('keydown', closeEscape);
        document.querySelector('.post-list__dynamic')?.addEventListener('scroll', onClose, {once: true});
        ref.current?.focus();
        return () => {
            document.removeEventListener('mousedown', closeOutside);
            document.removeEventListener('keydown', closeEscape);
            document.querySelector('.post-list__dynamic')?.removeEventListener('scroll', onClose);
        };
    }, [anchor, onClose]);

    const shown = readers.slice(0, POPOVER_MAX_ROWS);
    const remaining = readers.length - shown.length;
    const content = <div ref={ref} role='dialog' tabIndex={-1} style={{position: 'fixed', top, left: rect.left, zIndex: 1000, background: 'var(--center-channel-bg)', padding: 8, boxShadow: '0 2px 8px #0004'}}>
        <strong>{t(locale, 'readBy')}</strong>
        {status !== 'ready' && <div>{t(locale, status === 'loading' ? 'readLoading' : 'readError')}</div>}
        {shown.map((reader) => <div key={reader.user_id}>{profileName(profiles[reader.user_id], reader.user_id)} · {reader.exact ? formatReadTime(reader.read_at, locale) : t(locale, 'readApprox', {time: formatReadTime(reader.read_at, locale)})}</div>)}
        {remaining > 0 && <div>{t(locale, 'readMore', {count: String(remaining)})}</div>}
        {truncated && <div>{t(locale, 'readMoreTruncated', {count: String(readers.length)})}</div>}
    </div>;
    return createPortal(content, document.body);
};
