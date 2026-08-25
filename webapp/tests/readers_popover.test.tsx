import React from 'react';
import {act} from 'react-dom/test-utils';
import {createRoot} from 'react-dom/client';

import {ReadersPopover, ReadersStatus, POPOVER_MAX_ROWS} from '../src/components/readers_popover';

function makeReaders(count: number) {
    return Array.from({length: count}, (_, i) => ({
        user_id: `u${i}`,
        read_at: new Date('2024-01-01T10:00:00Z').getTime() + (i * 1000),
        exact: true,
    }));
}

describe('ReadersPopover', () => {
    let host: HTMLDivElement;
    let anchor: HTMLButtonElement;
    let root: ReturnType<typeof createRoot>;

    beforeEach(() => {
        document.body.innerHTML = '<button id="anchor">✓✓ 2</button><div id="host"></div>';
        anchor = document.getElementById('anchor') as HTMLButtonElement;
        host = document.getElementById('host') as HTMLDivElement;
        root = createRoot(host);
    });

    afterEach(() => {
        act(() => root.unmount());
        document.body.innerHTML = '';
    });

    function render(
        readers: ReturnType<typeof makeReaders>,
        truncated = false,
        profiles: Record<string, {username?: string; first_name?: string; last_name?: string}> = {},
        status: ReadersStatus = 'ready',
        onLoadMore?: () => void,
    ) {
        act(() => root.render(
            <ReadersPopover
                anchor={anchor}
                readers={readers}
                status={status}
                truncated={truncated}
                nameOf={(userId) => profiles[userId]}
                locale='ru'
                onLoadMore={onLoadMore}
                onClose={onClose}
            />,
        ));
    }

    const onClose = jest.fn();
    beforeEach(() => onClose.mockClear());

    const dialog = () => document.querySelector('[role="dialog"]') as HTMLElement;

    it('escapes the message DOM by rendering into the body', () => {
        render(makeReaders(1));

        // A portal into the post text would inherit the post list's transformed
        // ancestors, and `position: fixed` would then anchor to the wrong box.
        expect(dialog().parentElement).toBe(document.body);
        expect(host.innerHTML).toBe('');
    });

    it('prefers the full name and falls back to the username, then to the id', () => {
        render(makeReaders(3), false, {
            u0: {first_name: 'Ада', last_name: 'Лавлейс', username: 'ada'},
            u1: {username: 'grace'},
        });

        const rows = dialog().textContent!;
        expect(rows).toContain('Ада Лавлейс');
        expect(rows).toContain('grace');
        expect(rows).toContain('u2');
    });

    it('marks an approximate time coming from the watermark', () => {
        render([{user_id: 'u0', read_at: new Date('2024-01-01T10:00:00Z').getTime(), exact: false}]);

        expect(dialog().textContent).toContain('≈');
    });

    it('caps the list and reports the exact remainder', () => {
        render(makeReaders(POPOVER_MAX_ROWS + 4));

        expect(dialog().querySelectorAll('div').length).toBe(POPOVER_MAX_ROWS + 1);
        expect(dialog().textContent).toContain('и ещё 4');
    });

    it('does not invent a remainder of one when the server truncated the list', () => {
        render(makeReaders(POPOVER_MAX_ROWS), true);

        // The server capped the reader list, so the true remainder is unknown —
        // claiming "и ещё 1" would be a made-up number.
        expect(dialog().textContent).not.toContain('и ещё 1');
        expect(dialog().textContent).toContain('и ещё более');
    });

    it('flips above the anchor when there is no room below', () => {
        jest.spyOn(anchor, 'getBoundingClientRect').mockReturnValue({
            top: 700, bottom: 720, left: 40, right: 80, width: 40, height: 20, x: 40, y: 700, toJSON: () => ({}),
        } as DOMRect);
        (window as any).innerHeight = 760;

        render(makeReaders(5));

        expect(parseFloat(dialog().style.top)).toBeLessThan(700);
    });

    it('closes on Escape, on an outside click and on a post list scroll', () => {
        document.body.insertAdjacentHTML('beforeend', '<div class="post-list__dynamic"></div>');
        render(makeReaders(1));

        act(() => {
            document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape'}));
        });
        expect(onClose).toHaveBeenCalled();

        onClose.mockClear();
        act(() => {
            document.body.dispatchEvent(new MouseEvent('mousedown', {bubbles: true}));
        });
        expect(onClose).toHaveBeenCalled();

        onClose.mockClear();
        act(() => {
            document.querySelector('.post-list__dynamic')!.dispatchEvent(new Event('scroll'));
        });
        expect(onClose).toHaveBeenCalled();
    });

    it('keeps itself open when the click lands inside', () => {
        render(makeReaders(1));

        act(() => {
            dialog().dispatchEvent(new MouseEvent('mousedown', {bubbles: true}));
        });

        expect(onClose).not.toHaveBeenCalled();
    });
    it('opens with a loading row so a slow request is visible', () => {
        render([], false, {}, 'loading');

        expect(dialog().textContent).toContain('Загрузка');
    });

    it('stays dismissable when the reader request failed', () => {
        // Rendering only once the data arrives would leave a failed request with
        // an open popover and no close handlers attached — impossible to dismiss.
        render([], false, {}, 'error');
        expect(dialog().textContent).toContain('Не удалось');

        act(() => {
            document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape'}));
        });
        expect(onClose).toHaveBeenCalled();
    });
    it('offers to load the rest of a truncated list rather than stopping at the first page', () => {
        const onLoadMore = jest.fn();
        render(makeReaders(3), true, {}, 'ready', onLoadMore);

        const more = Array.from(dialog().querySelectorAll('button')).find((b) => b.textContent?.includes('Показать ещё'));
        expect(more).toBeDefined();

        act(() => more!.click());
        expect(onLoadMore).toHaveBeenCalledTimes(1);
    });

    it('does not offer more when there is nothing further to load', () => {
        render(makeReaders(3), false, {}, 'ready');
        expect(dialog().textContent).not.toContain('Показать ещё');
    });
});
