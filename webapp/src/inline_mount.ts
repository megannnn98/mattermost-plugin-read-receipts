export interface InlineMount {
    target: HTMLElement;
    strategy: 'inline' | 'overlay';
    dispose: () => void;
}

// Mattermost mounts attachment components as a block under the post. A portal
// into the message text is therefore required to avoid changing post height.
export function createInlineMount(sentinel: HTMLElement): InlineMount | null {
    const body = sentinel.closest('.post__body') as HTMLElement | null;
    if (!body) {
        return null;
    }
    const target = document.createElement('span');
    const text = body.querySelector('.post-message__text');
    const strategy = text ? 'inline' : 'overlay';
    if (text) {
        text.appendChild(target);
    } else {
        // The text container is absent for unusual post variants. This overlay
        // is height-neutral and remains the explicit fallback strategy.
        target.style.position = 'absolute';
        target.style.right = '0';
        target.style.bottom = '0';
        body.appendChild(target);
    }
    return {target, strategy, dispose: () => target.remove()};
}
