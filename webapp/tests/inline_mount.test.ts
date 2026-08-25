import {createInlineMount} from '../src/inline_mount';

describe('createInlineMount', () => {
    afterEach(() => {
        document.body.innerHTML = '';
    });

    function buildPost(message: string | null): HTMLElement {
        document.body.innerHTML = `
            <div class="post">
                <div class="post__body">
                    ${message === null ? '' : `<div class="post-message__text">${message}</div>`}
                    <span id="sentinel"></span>
                </div>
            </div>`;
        return document.getElementById('sentinel') as HTMLElement;
    }

    it('mounts inside the last paragraph so the indicator shares its line', () => {
        const sentinel = buildPost('<p>hello</p>');

        const mount = createInlineMount(sentinel);

        expect(mount).not.toBeNull();
        expect(mount!.strategy).toBe('inline');
        // Appending to the container instead would place an inline box after a
        // block, which starts a new anonymous line and grows the post by exactly
        // the line this change exists to remove.
        expect(mount!.target.parentElement!.tagName).toBe('P');
    });

    it('mounts inside the last paragraph of a multi-paragraph message', () => {
        const sentinel = buildPost('<p>first</p><p id="last">second</p>');

        const mount = createInlineMount(sentinel);

        expect(mount!.target.parentElement!.id).toBe('last');
    });

    it('stays outside a trailing code block instead of writing into it', () => {
        const sentinel = buildPost('<p>look</p><pre><code>x = 1</code></pre>');

        const mount = createInlineMount(sentinel);

        // An inline span after a block (pre/quote/table) would start a new
        // anonymous line and grow the post by exactly the height this removes.
        // Falling back to the overlay keeps it height-neutral instead.
        expect(mount!.strategy).toBe('overlay');
        expect(mount!.target.parentElement).toBe(document.querySelector('.post__body'));
        expect(mount!.target.style.position).toBe('absolute');
    });

    it('does not grow a trailing code block post', () => {
        const sentinel = buildPost('<p>look</p><pre><code>x = 1</code></pre>');

        const body = document.querySelector('.post__body') as HTMLElement;
        const before = body.getBoundingClientRect().height;
        createInlineMount(sentinel);
        const after = body.getBoundingClientRect().height;

        // The overlay is absolutely positioned, so it leaves the post's layout
        // height untouched.
        expect(after).toBe(before);
    });

    it('falls back to a height-neutral overlay when there is no message text', () => {
        const sentinel = buildPost(null);

        const mount = createInlineMount(sentinel);

        expect(mount).not.toBeNull();
        expect(mount!.strategy).toBe('overlay');
        expect(mount!.target.parentElement).toBe(document.querySelector('.post__body'));
        expect(mount!.target.style.position).toBe('absolute');
    });

    it('removes its node on dispose so nothing is left in the Mattermost DOM', () => {
        const sentinel = buildPost('<p>hello</p>');
        const mount = createInlineMount(sentinel)!;

        mount.dispose();

        expect(document.querySelector('.post-message__text p')!.childElementCount).toBe(0);
    });

    it('returns null outside a post body instead of mounting somewhere arbitrary', () => {
        document.body.innerHTML = '<span id="sentinel"></span>';

        expect(createInlineMount(document.getElementById('sentinel') as HTMLElement)).toBeNull();
    });
});
