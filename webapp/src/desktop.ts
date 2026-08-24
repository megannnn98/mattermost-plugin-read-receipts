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

let cachedResult: boolean | null = null;

export async function isDesktopClientAsync(): Promise<boolean> {
    if (cachedResult !== null) {
        return cachedResult;
    }

    try {
        const api = window.desktopAPI;
        if (!api || typeof api.getAppInfo !== 'function') {
            cachedResult = false;
            return false;
        }

        const info = await Promise.race<DesktopAppInfo | null>([
            api.getAppInfo(),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 1000)),
        ]);

        if (!info || !info.name) {
            cachedResult = false;
            return false;
        }

        cachedResult = true;
        return true;
    } catch {
        cachedResult = false;
        return false;
    }
}

export function isDesktopClient(): boolean {
    const api = window.desktopAPI;
    if (!api || typeof api.getAppInfo !== 'function') {
        return false;
    }
    return true;
}

export function resetDesktopCache(): void {
    cachedResult = null;
}
