export interface DesktopAppInfo {
    name: string;
    version: string;
}

export interface DesktopAPI {
    getAppInfo?: () => Promise<DesktopAppInfo>;
    isDev?: () => Promise<boolean>;
    onUserActivityUpdate?: (listener: (active: boolean, idleTime: number, isSystemEvent: boolean) => void) => () => void;
}

declare global {
    interface Window {
        desktopAPI?: DesktopAPI;
    }
}

export function isDesktopClient(): boolean {
    const api = window.desktopAPI;
    if (!api || typeof api.getAppInfo !== 'function') {
        return false;
    }
    return true;
}
