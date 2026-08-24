import {isDesktopClient, resetDesktopCache} from '../src/desktop';

describe('desktop detection', () => {
    beforeEach(() => {
        resetDesktopCache();
        delete (window as any).desktopAPI;
    });

    it('returns true when desktopAPI.getAppInfo exists', () => {
        (window as any).desktopAPI = {
            getAppInfo: jest.fn().mockResolvedValue({name: 'Mattermost', version: '5.0.0'}),
        };
        expect(isDesktopClient()).toBe(true);
    });

    it('returns false when desktopAPI is missing', () => {
        expect(isDesktopClient()).toBe(false);
    });

    it('returns false when getAppInfo is not a function', () => {
        (window as any).desktopAPI = {};
        expect(isDesktopClient()).toBe(false);
    });

    it('returns false on browser UA even with desktopAPI missing', () => {
        Object.defineProperty(window, 'navigator', {
            value: {userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36'},
            writable: true,
        });
        expect(isDesktopClient()).toBe(false);
    });
});
