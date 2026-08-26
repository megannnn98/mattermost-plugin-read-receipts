import React from 'react';

const TICK_HEIGHT = 12;

interface StatusTicksProps {
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
export const StatusTicks: React.FC<StatusTicksProps> = ({label}) => (
    <svg
        width={17}
        height={TICK_HEIGHT}
        viewBox='0 0 17 12'
        role='img'
        aria-label={label}
        focusable='false'
        style={{
            display: 'inline-block',
            verticalAlign: 'text-bottom',
            flexShrink: 0,
            color: 'var(--online-indicator, #3db887)',
            opacity: 1,
        }}
    >
        <path
            d='M1.2 6.4 3.5 8.7 7 3.6'
            fill='none'
            stroke='currentColor'
            strokeWidth='1.6'
            strokeLinecap='round'
            strokeLinejoin='round'
        />
        <path
            d='M6.2 6.4 8.5 8.7 15.4 1.6'
            fill='none'
            stroke='currentColor'
            strokeWidth='1.6'
            strokeLinecap='round'
            strokeLinejoin='round'
        />
    </svg>
);

export default StatusTicks;
