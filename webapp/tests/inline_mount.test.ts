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

        expect(mount!.target.parentElement!.className).toBe('post-message__text');
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
