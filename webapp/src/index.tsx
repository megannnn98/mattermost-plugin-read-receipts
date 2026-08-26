import React, {useEffect} from 'react';
import * as ReactDOM from 'react-dom';

import {isDesktopClient} from './desktop';
import {reducer} from './reducer';
import {handleWebSocketEvent, WS_EVENT} from './websocket';
import {PLUGIN_ID} from './client';
import ReadReceiptPortals from './components/read_receipt_portals';
import {setStore} from './store_ref';
import {ChannelWatcher, startChannelWatcher} from './channel_watcher';
import {resetDeduplicator} from './actions';
import {resetVisibilityTracker} from './visibility';
import {PluginRegistry, PluginStore} from './types';

import './styles/read_receipt.css';

declare global {
    interface Window {
        registerPlugin?: (id: string, plugin: unknown) => void;
    }
}

const PluginStyles: React.FC = () => {
    useEffect(() => {
        document.body.classList.add('read-receipt-plugin-active');
        return () => {
            document.body.classList.remove('read-receipt-plugin-active');
        };
    }, []);
    return null;
};

export class ReadReceiptsPlugin {
    private watcher: ChannelWatcher | null = null;
    private rootEl: HTMLDivElement | null = null;

    initialize(registry: PluginRegistry, store: PluginStore): void {
        if (!isDesktopClient()) {
            console.debug(`[${PLUGIN_ID}] not Mattermost Desktop — plugin disabled`);
            return;
        }

        setStore(store);

        registry.registerReducer(reducer);

        registry.registerWebSocketEventHandler(WS_EVENT, (msg) => {
            handleWebSocketEvent(msg, store);
        });

        this.watcher = startChannelWatcher(store);

        if (typeof registry.registerReconnectHandler === 'function') {
            registry.registerReconnectHandler(() => {
                this.watcher?.refresh();
            });
        }

        this.rootEl = document.createElement('div');
        this.rootEl.id = 'read-receipt-root';
        document.body.appendChild(this.rootEl);
        this.render();

        console.debug(`[${PLUGIN_ID}] desktop detected — plugin enabled`);
    }

    private render(): void {
        if (!this.rootEl) {
            return;
        }
        ReactDOM.render(
            <React.Fragment>
                <PluginStyles />
                <ReadReceiptPortals />
            </React.Fragment>,
            this.rootEl,
        );
    }

    uninitialize(): void {
        if (this.rootEl) {
            ReactDOM.unmountComponentAtNode(this.rootEl);
            this.rootEl.remove();
            this.rootEl = null;
        }
        document.body.classList.remove('read-receipt-plugin-active');
        this.watcher?.stop();
        this.watcher = null;
        resetDeduplicator();
        resetVisibilityTracker();
        setStore(null);
    }
}

window.registerPlugin?.(PLUGIN_ID, new ReadReceiptsPlugin());

export default ReadReceiptsPlugin;
