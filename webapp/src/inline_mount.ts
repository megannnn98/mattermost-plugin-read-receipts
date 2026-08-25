export interface InlineMount {
    target: HTMLElement;
    strategy: 'inline' | 'overlay';
    dispose: () => void;
}

/**
 * Resolves the node the indicator must be appended to so that it lands on the
 * same line as the end of the message.
 *
 * `.post-message__text` renders the message as block children — a normal message
 * is a single `<p>`. Appending to the container itself puts the indicator *after*
 * that block, and an inline box after a block starts a new anonymous line: the
 * post grows by exactly one line, which is the extra height this whole change
 * exists to remove. Appending inside the last paragraph makes it flow with the
 * trailing text instead.
 *
 * Anything else as the last block (a code block, a quote, a table) is left alone:
 * putting a checkmark inside those would be worse than a line below them.
 */
function resolveTextTarget(body: HTMLElement): HTMLElement | null {
    const text = body.querySelector('.post-message__text');
    if (!text) {
        return null;
    }
    const last = text.lastElementChild;
    if (last && last.tagName === 'P') {
        return last as HTMLElement;
    }
    return text as HTMLElement;
}

// Mattermost mounts attachment components as a block under the post. A portal
// into the message text is therefore required to avoid changing post height.
export function createInlineMount(sentinel: HTMLElement): InlineMount | null {
    const body = sentinel.closest('.post__body') as HTMLElement | null;
    if (!body) {
        return null;
    }
    const target = document.createElement('span');
    const text = resolveTextTarget(body);
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
