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
const STORAGE_WRITE_THROTTLE_MS = 250;
const SESSION_STATE_KEY = 'tracked-tab-state';

type RequestDetails = {
    documentId?: string;
    initiator?: string;
    parentDocumentId?: string;
    tabId: number;
    type: string;
    url: string;
};

type PersistedTabState = {
    domainCounts: Record<string, number>;
    topLevelOrigin?: string;
};

type PersistedSessionState = Record<string, PersistedTabState>;

const tabDomainCounts = new Map<number, Map<string, number>>();
const tabActiveConnections = new Map<number, Map<string, number>>();
const tabSubscribers = new Map<number, Set<chrome.runtime.Port>>();
const documentTabIds = new Map<string, number>();
const tabDocumentIds = new Map<number, Set<string>>();
const tabTopLevelOrigins = new Map<number, string>();
const originTabIds = new Map<string, Set<number>>();
const updateTimers = new Map<number, number>();
let persistTimerId: number | null = null;
const restoredStatePromise = restorePersistedState().catch((error) => {
    console.error('Failed to restore tracked tab state', error);
});

function isSubscribeTabMessage(message: unknown): message is SubscribeTabMessage {
    if (!message || typeof message !== 'object') return false;

    const candidate = message as Partial<SubscribeTabMessage>;
    return candidate.type === SUBSCRIBE_TAB_MESSAGE_TYPE && typeof candidate.tabId === 'number';
}

function buildSnapshot(tabId: number): DomainEntry[] {
    const domainCounts = tabDomainCounts.get(tabId);
    if (!domainCounts) return [];

    const activeMap = tabActiveConnections.get(tabId);

    return Array.from(domainCounts.entries()).map(([domain, count]) => ({
        domain,
        count,
        active: activeMap ? (activeMap.get(domain) ?? 0) > 0 : false
    }));
}

function getOrigin(url: string | undefined): string | null {
    if (!url) return null;

    try {
        const origin = new URL(url).origin;
        return origin === 'null' ? null : origin;
    } catch {
        return null;
    }
}

function rememberDocumentTabLink(tabId: number, documentId: string | undefined): void {
    if (tabId < 0 || !documentId) return;

    documentTabIds.set(documentId, tabId);

    const knownDocumentIds = tabDocumentIds.get(tabId) ?? new Set<string>();
    knownDocumentIds.add(documentId);
    tabDocumentIds.set(tabId, knownDocumentIds);
}

function clearTabDocumentLinks(tabId: number): void {
    const documentIds = tabDocumentIds.get(tabId);
    if (!documentIds) return;

    documentIds.forEach((documentId) => documentTabIds.delete(documentId));
    tabDocumentIds.delete(tabId);
}

function updateOriginTabIndex(tabId: number, nextOrigin: string | null): void {
    const previousOrigin = tabTopLevelOrigins.get(tabId);

    if (previousOrigin) {
        const tabsForOrigin = originTabIds.get(previousOrigin);
        tabsForOrigin?.delete(tabId);
        if (tabsForOrigin && tabsForOrigin.size === 0) {
            originTabIds.delete(previousOrigin);
        }
    }

    if (!nextOrigin) {
        tabTopLevelOrigins.delete(tabId);
        return;
    }

    const tabsForOrigin = originTabIds.get(nextOrigin) ?? new Set<number>();
    tabsForOrigin.add(tabId);
    originTabIds.set(nextOrigin, tabsForOrigin);
    tabTopLevelOrigins.set(tabId, nextOrigin);
}

function resolveTabId(details: RequestDetails): number {
    if (details.tabId >= 0) {
        rememberDocumentTabLink(details.tabId, details.documentId);
        return details.tabId;
    }

    if (details.documentId) {
        const documentTabId = documentTabIds.get(details.documentId);
        if (typeof documentTabId === 'number') return documentTabId;
    }

    if (details.parentDocumentId) {
        const parentDocumentTabId = documentTabIds.get(details.parentDocumentId);
        if (typeof parentDocumentTabId === 'number') return parentDocumentTabId;
    }

    if (details.initiator && details.initiator !== 'null') {
        const tabsForOrigin = originTabIds.get(details.initiator);
        if (tabsForOrigin?.size === 1) {
            return tabsForOrigin.values().next().value ?? -1;
        }
    }

    return -1;
}

function getOrCreateTabDomainCounts(tabId: number): Map<string, number> {
    const existing = tabDomainCounts.get(tabId);
    if (existing) return existing;

    const created = new Map<string, number>();
    tabDomainCounts.set(tabId, created);
    return created;
}

function serializeState(): PersistedSessionState {
    const serializedState: PersistedSessionState = {};

    tabDomainCounts.forEach((domainCounts, tabId) => {
        if (domainCounts.size === 0) return;

        serializedState[String(tabId)] = {
            domainCounts: Object.fromEntries(domainCounts),
            topLevelOrigin: tabTopLevelOrigins.get(tabId)
        };
    });

    return serializedState;
}

async function persistState(): Promise<void> {
    persistTimerId = null;

    const state = serializeState();
    if (Object.keys(state).length === 0) {
        await chrome.storage.session.remove(SESSION_STATE_KEY);
        return;
    }

    await chrome.storage.session.set({ [SESSION_STATE_KEY]: state });
}

function schedulePersistState(): void {
    if (persistTimerId !== null) return;

    persistTimerId = setTimeout(() => {
        void persistState().catch((error) => {
            console.error('Failed to persist tracked tab state', error);
        });
    }, STORAGE_WRITE_THROTTLE_MS);
}

async function restorePersistedState(): Promise<void> {
    const [{ [SESSION_STATE_KEY]: rawState }, openTabs] = await Promise.all([
        chrome.storage.session.get(SESSION_STATE_KEY),
        chrome.tabs.query({})
    ]);

    if (!rawState || typeof rawState !== 'object') return;

    const openTabIds = new Set(
        openTabs
            .map((tab) => tab.id)
            .filter((tabId): tabId is number => typeof tabId === 'number')
    );

    Object.entries(rawState as PersistedSessionState).forEach(([rawTabId, persistedState]) => {
        const tabId = Number(rawTabId);
        if (!Number.isInteger(tabId) || tabId < 0 || !openTabIds.has(tabId)) return;

        const restoredCounts = new Map<string, number>();
        Object.entries(persistedState.domainCounts ?? {}).forEach(([domain, count]) => {
            if (!domain || !Number.isFinite(count) || count <= 0) return;
            restoredCounts.set(domain, count);
        });

        if (restoredCounts.size > 0) {
            tabDomainCounts.set(tabId, restoredCounts);
        }

        if (typeof persistedState.topLevelOrigin === 'string') {
            updateOriginTabIndex(tabId, persistedState.topLevelOrigin);
        }
    });
}

function runWithRestoredState(task: () => void): void {
    void restoredStatePromise.then(task);
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
    tabActiveConnections.delete(tabId);
    clearTabDocumentLinks(tabId);
    updateOriginTabIndex(tabId, null);
    schedulePersistState();
}

function addRequest(details: RequestDetails): void {
    const resolvedTabId = resolveTabId(details);
    if (resolvedTabId < 0) return;

    const isMainFrame = details.type === 'main_frame';

    // Новый main_frame = новая навигация вкладки, сбрасываем предыдущий список.
    if (isMainFrame) {
        tabDomainCounts.set(resolvedTabId, new Map());
        tabActiveConnections.set(resolvedTabId, new Map());
        clearTabDocumentLinks(resolvedTabId);
        rememberDocumentTabLink(resolvedTabId, details.documentId);
        updateOriginTabIndex(resolvedTabId, getOrigin(details.url));
    }

    const rootDomain = getRootDomain(details.url);
    if (rootDomain === 'unknown') {
        if (isMainFrame) {
            scheduleSnapshot(resolvedTabId);
        }
        return;
    }

    const domainCounts = getOrCreateTabDomainCounts(resolvedTabId);
    domainCounts.set(rootDomain, (domainCounts.get(rootDomain) ?? 0) + 1);

    const activeConnections = tabActiveConnections.get(resolvedTabId) ?? new Map<string, number>();
    activeConnections.set(rootDomain, (activeConnections.get(rootDomain) ?? 0) + 1);
    tabActiveConnections.set(resolvedTabId, activeConnections);

    scheduleSnapshot(resolvedTabId);
    schedulePersistState();
}

function removeActiveRequest(details: RequestDetails): void {
    const resolvedTabId = resolveTabId(details);
    if (resolvedTabId < 0) return;

    const rootDomain = getRootDomain(details.url);
    if (rootDomain === 'unknown') return;

    const activeConnections = tabActiveConnections.get(resolvedTabId);
    if (!activeConnections) return;

    const current = activeConnections.get(rootDomain) ?? 0;
    if (current > 0) {
        if (current === 1) {
            activeConnections.delete(rootDomain);
        } else {
            activeConnections.set(rootDomain, current - 1);
        }

        scheduleSnapshot(resolvedTabId);
    }
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
        runWithRestoredState(() => {
            addRequest(details);
        });
        return undefined;
    },
    { urls: ['<all_urls>'] }
);

chrome.webRequest.onCompleted.addListener(
    (details) => {
        runWithRestoredState(() => {
            removeActiveRequest(details);
        });
    },
    { urls: ['<all_urls>'] }
);

chrome.webRequest.onErrorOccurred.addListener(
    (details) => {
        runWithRestoredState(() => {
            removeActiveRequest(details);
        });
    },
    { urls: ['<all_urls>'] }
);

chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== POPUP_PORT_NAME) return;

    let subscribedTabId: number | null = null;

    port.onMessage.addListener((message: unknown) => {
        if (!isSubscribeTabMessage(message)) return;

        runWithRestoredState(() => {
            const { tabId } = message;
            if (subscribedTabId !== null && subscribedTabId !== tabId) {
                unsubscribePortFromTab(port, subscribedTabId);
            }

            subscribedTabId = tabId;
            subscribePortToTab(port, subscribedTabId);
        });
    });

    port.onDisconnect.addListener(() => {
        if (subscribedTabId !== null) {
            unsubscribePortFromTab(port, subscribedTabId);
        }
    });
});

chrome.tabs.onRemoved.addListener((tabId) => {
    runWithRestoredState(() => {
        clearTabData(tabId);
    });
});

chrome.tabs.onReplaced.addListener((_addedTabId, removedTabId) => {
    runWithRestoredState(() => {
        clearTabData(removedTabId);
    });
});
