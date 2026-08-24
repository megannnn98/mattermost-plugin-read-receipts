export interface VisibilityState {
    isVisible: boolean;
    isFocused: boolean;
    isIdle: boolean;
}

export type VisibilityCallback = (state: VisibilityState) => void;

export class VisibilityTracker {
    private state: VisibilityState = {
        isVisible: true,
        isFocused: true,
        isIdle: false,
    };

    private listeners: Set<VisibilityCallback> = new Set();
    private unsubscribeDesktop: (() => void) | null = null;

    constructor() {
        if (typeof window === 'undefined' || typeof document === 'undefined') {
            return;
        }

        document.addEventListener('visibilitychange', this.handleVisibilityChange);
        window.addEventListener('focus', this.handleFocus);
        window.addEventListener('blur', this.handleBlur);

        if (window.desktopAPI?.onUserActivityUpdate) {
            this.unsubscribeDesktop = window.desktopAPI.onUserActivityUpdate(
                (active: boolean) => {
                    this.updateState({isIdle: !active});
                },
            );
        }
    }

    private handleVisibilityChange = () => {
        this.updateState({isVisible: document.visibilityState === 'visible'});
    };

    private handleFocus = () => {
        this.updateState({isFocused: true});
    };

    private handleBlur = () => {
        this.updateState({isFocused: false});
    };

    private updateState(partial: Partial<VisibilityState>) {
        const old = this.state;
        this.state = {...this.state, ...partial};

        if (
            old.isVisible !== this.state.isVisible ||
            old.isFocused !== this.state.isFocused ||
            old.isIdle !== this.state.isIdle
        ) {
            this.listeners.forEach((cb) => cb(this.state));
        }
    }

    subscribe(cb: VisibilityCallback): () => void {
        this.listeners.add(cb);
        return () => {
            this.listeners.delete(cb);
        };
    }

    getState(): VisibilityState {
        return this.state;
    }

    isActive(): boolean {
        return this.state.isVisible && this.state.isFocused && !this.state.isIdle;
    }

    destroy() {
        if (typeof window === 'undefined' || typeof document === 'undefined') {
            return;
        }

        document.removeEventListener('visibilitychange', this.handleVisibilityChange);
        window.removeEventListener('focus', this.handleFocus);
        window.removeEventListener('blur', this.handleBlur);

        if (this.unsubscribeDesktop) {
            this.unsubscribeDesktop();
            this.unsubscribeDesktop = null;
        }

        this.listeners.clear();
    }
}

let globalTracker: VisibilityTracker | null = null;

export function getVisibilityTracker(): VisibilityTracker {
    if (!globalTracker) {
        globalTracker = new VisibilityTracker();
    }
    return globalTracker;
}

export function resetVisibilityTracker(): void {
    if (globalTracker) {
        globalTracker.destroy();
        globalTracker = null;
    }
}
