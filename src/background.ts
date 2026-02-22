/// <reference types="chrome" />

import { getRootDomain } from './utils/domainParser';
import {
    POPUP_PORT_NAME,
    SUBSCRIBE_TAB_MESSAGE_TYPE,
    TAB_DOMAINS_UPDATE_MESSAGE_TYPE,
    type DomainEntry,
    type SubscribeTabMessage,
    type TabDomainsUpdateMessage
} from './shared/messages';

const UPDATE_THROTTLE_MS = 100;
const tabDomainCounts = new Map<number, Map<string, number>>();
const tabSubscribers = new Map<number, Set<chrome.runtime.Port>>();
const updateTimers = new Map<number, number>();

function isSubscribeTabMessage(message: unknown): message is SubscribeTabMessage {
    if (!message || typeof message !== 'object') return false;

    const candidate = message as Partial<SubscribeTabMessage>;
    return candidate.type === SUBSCRIBE_TAB_MESSAGE_TYPE && typeof candidate.tabId === 'number';
}

function buildSnapshot(tabId: number): DomainEntry[] {
    const domainCounts = tabDomainCounts.get(tabId);
    if (!domainCounts) return [];

    return Array.from(domainCounts.entries()).map(([domain, count]) => ({ domain, count }));
}

function getOrCreateTabDomainCounts(tabId: number): Map<string, number> {
    const existing = tabDomainCounts.get(tabId);
    if (existing) return existing;

    const created = new Map<string, number>();
    tabDomainCounts.set(tabId, created);
    return created;
}

function postSnapshot(tabId: number): void {
    const subscribers = tabSubscribers.get(tabId);
    if (!subscribers || subscribers.size === 0) return;

    const payload: TabDomainsUpdateMessage = {
        type: TAB_DOMAINS_UPDATE_MESSAGE_TYPE,
        tabId,
        domains: buildSnapshot(tabId)
    };

    const stalePorts: chrome.runtime.Port[] = [];
    for (const port of subscribers) {
        try {
            port.postMessage(payload);
        } catch {
            stalePorts.push(port);
        }
    }

    stalePorts.forEach((port) => subscribers.delete(port));
    if (subscribers.size === 0) {
        tabSubscribers.delete(tabId);
    }
}

function scheduleSnapshot(tabId: number): void {
    if (updateTimers.has(tabId)) return;

    const timerId = setTimeout(() => {
        updateTimers.delete(tabId);
        postSnapshot(tabId);
    }, UPDATE_THROTTLE_MS);

    updateTimers.set(tabId, timerId);
}

function clearTabData(tabId: number): void {
    const timerId = updateTimers.get(tabId);
    if (typeof timerId === 'number') {
        clearTimeout(timerId);
        updateTimers.delete(tabId);
    }

    tabDomainCounts.delete(tabId);
}

function addRequest(tabId: number, url: string, isMainFrame: boolean): void {
    if (tabId < 0) return;

    // Новый main_frame = новая навигация вкладки, сбрасываем предыдущий список.
    if (isMainFrame) {
        tabDomainCounts.set(tabId, new Map());
    }

    const rootDomain = getRootDomain(url);
    if (rootDomain === 'unknown') {
        if (isMainFrame) {
            scheduleSnapshot(tabId);
        }
        return;
    }

    const domainCounts = getOrCreateTabDomainCounts(tabId);
    domainCounts.set(rootDomain, (domainCounts.get(rootDomain) ?? 0) + 1);
    scheduleSnapshot(tabId);
}

function subscribePortToTab(port: chrome.runtime.Port, tabId: number): void {
    const subscribers = tabSubscribers.get(tabId) ?? new Set<chrome.runtime.Port>();
    subscribers.add(port);
    tabSubscribers.set(tabId, subscribers);
    postSnapshot(tabId);
}

function unsubscribePortFromTab(port: chrome.runtime.Port, tabId: number): void {
    const subscribers = tabSubscribers.get(tabId);
    if (!subscribers) return;

    subscribers.delete(port);
    if (subscribers.size === 0) {
        tabSubscribers.delete(tabId);
    }
}

chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
        addRequest(details.tabId, details.url, details.type === 'main_frame');
        return undefined;
    },
    { urls: ['<all_urls>'] }
);

chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== POPUP_PORT_NAME) return;

    let subscribedTabId: number | null = null;

    port.onMessage.addListener((message: unknown) => {
        if (!isSubscribeTabMessage(message)) return;

        const { tabId } = message;
        if (subscribedTabId !== null && subscribedTabId !== tabId) {
            unsubscribePortFromTab(port, subscribedTabId);
        }

        subscribedTabId = tabId;
        subscribePortToTab(port, subscribedTabId);
    });

    port.onDisconnect.addListener(() => {
        if (subscribedTabId !== null) {
            unsubscribePortFromTab(port, subscribedTabId);
        }
    });
});

chrome.tabs.onRemoved.addListener((tabId) => {
    clearTabData(tabId);
});

chrome.tabs.onReplaced.addListener((_addedTabId, removedTabId) => {
    clearTabData(removedTabId);
});
