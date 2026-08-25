import {createInlineMount} from '../src/inline_mount';

describe('createInlineMount', () => {
    afterEach(() => {
        document.body.innerHTML = '';
    });

    function buildPost(withText: boolean): HTMLElement {
        document.body.innerHTML = `
            <div class="post">
                <div class="post__body">
                    ${withText ? '<div class="post-message__text">hello</div>' : ''}
                    <span id="sentinel"></span>
                </div>
            </div>`;
        return document.getElementById('sentinel') as HTMLElement;
    }

    it('mounts the target inside the message text when the text container exists', () => {
        const sentinel = buildPost(true);

        const mount = createInlineMount(sentinel);

        expect(mount).not.toBeNull();
        expect(mount!.strategy).toBe('inline');
        // Last child of the text: the indicator must read as part of the message,
        // which is exactly what removes the extra line the customer complained about.
        const text = document.querySelector('.post-message__text')!;
        expect(text.lastElementChild).toBe(mount!.target);
    });

    it('falls back to a height-neutral overlay when there is no message text', () => {
        const sentinel = buildPost(false);

        const mount = createInlineMount(sentinel);

        expect(mount).not.toBeNull();
        expect(mount!.strategy).toBe('overlay');
        expect(mount!.target.parentElement).toBe(document.querySelector('.post__body'));
        expect(mount!.target.style.position).toBe('absolute');
    });

    it('removes its node on dispose so nothing is left in the Mattermost DOM', () => {
        const sentinel = buildPost(true);
        const mount = createInlineMount(sentinel)!;

        mount.dispose();

        expect(document.querySelector('.post-message__text')!.childElementCount).toBe(0);
    });

    it('returns null outside a post body instead of mounting somewhere arbitrary', () => {
        document.body.innerHTML = '<span id="sentinel"></span>';

        expect(createInlineMount(document.getElementById('sentinel') as HTMLElement)).toBeNull();
    });
});
