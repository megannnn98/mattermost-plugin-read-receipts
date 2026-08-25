import React from 'react';

export type TickStatus = 'delivered' | 'read';

const TICK_HEIGHT = 12;

interface StatusTicksProps {
    status: TickStatus;
    label: string;
}

/**
 * The checkmarks are drawn rather than typed. A text glyph inherits the message
 * font, so its size and weight drift with the theme and it drags its own line
 * metrics into the paragraph; an SVG has an explicit box and takes the colour it
 * is given.
 *
 * The colours come from Mattermost's theme variables, not from fixed hex values,
 * so the indicator stays readable in dark themes and in custom ones.
 */
export const StatusTicks: React.FC<StatusTicksProps> = ({status, label}) => {
    const read = status === 'read';
    return (
        <svg
            width={read ? 17 : 12}
            height={TICK_HEIGHT}
            viewBox={read ? '0 0 17 12' : '0 0 12 12'}
            role='img'
            data-tick={status}
            aria-label={label}
            focusable='false'
            style={{
                display: 'inline-block',
                verticalAlign: 'text-bottom',
                flexShrink: 0,
                color: read ? 'var(--online-indicator, #3db887)' : 'var(--center-channel-color, #3f4350)',
                opacity: read ? 1 : 0.56,
            }}
        >
            {read && (
                <path
                    d='M1.2 6.4 3.5 8.7 7 3.6'
                    fill='none'
                    stroke='currentColor'
                    strokeWidth='1.6'
                    strokeLinecap='round'
                    strokeLinejoin='round'
                />
            )}
            <path
                d={read ? 'M6.2 6.4 8.5 8.7 15.4 1.6' : 'M1.4 6.4 4.1 9.1 10.4 2.6'}
                fill='none'
                stroke='currentColor'
                strokeWidth='1.6'
                strokeLinecap='round'
                strokeLinejoin='round'
            />
        </svg>
    );
};

export default StatusTicks;
