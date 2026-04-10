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

type RequestWithIpDetails = RequestDetails & {
    ip?: string;
};

type PersistedTabState = {
    domainCounts: Record<string, number>;
    localAddresses?: Record<string, string[]>;
    topLevelOrigin?: string;
};

type PersistedSessionState = Record<string, PersistedTabState>;

const tabDomainCounts = new Map<number, Map<string, number>>();
const tabDomainLocalAddresses = new Map<number, Map<string, Set<string>>>();
const tabActiveConnections = new Map<number, Map<string, number>>();
const tabSubscribers = new Map<number, Set<chrome.runtime.Port>>();
const documentTabIds = new Map<string, number>();
const tabDocumentIds = new Map<number, Set<string>>();
const tabKnownOrigins = new Map<number, Set<string>>();
const tabTopLevelOrigins = new Map<number, string>();
const originTabIds = new Map<string, Set<number>>();
const updateTimers = new Map<number, number>();
let persistTimerId: number | null = null;
const restoredStatePromise = restorePersistedState().catch((error) => {
    console.error('Failed to restore tracked tab state', error);
});
const ipv4Pattern = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const ipv6Pattern = /^[0-9a-f:]+$/i;
const localIpv6LinkLocalPattern = /^fe[89ab]/i;

function isSubscribeTabMessage(message: unknown): message is SubscribeTabMessage {
    if (!message || typeof message !== 'object') return false;

    const candidate = message as Partial<SubscribeTabMessage>;
    return candidate.type === SUBSCRIBE_TAB_MESSAGE_TYPE && typeof candidate.tabId === 'number';
}

function buildSnapshot(tabId: number): DomainEntry[] {
    const domainCounts = tabDomainCounts.get(tabId);
    if (!domainCounts) return [];

    const activeMap = tabActiveConnections.get(tabId);
    const localAddressMap = tabDomainLocalAddresses.get(tabId);

    return Array.from(domainCounts.entries()).map(([domain, count]) => ({
        domain,
        count,
        active: activeMap ? (activeMap.get(domain) ?? 0) > 0 : false,
        localAddresses: localAddressMap?.has(domain)
            ? Array.from(localAddressMap.get(domain)!).sort((left, right) => left.localeCompare(right))
            : undefined
    }));
}

function normalizeAddress(rawAddress: string): string {
    if (rawAddress.startsWith('[') && rawAddress.endsWith(']')) {
        return rawAddress.slice(1, -1).toLowerCase();
    }

    return rawAddress.toLowerCase();
}

function parseStoredLocalAddress(localAddress: string): { host: string; port: string | null } {
    if (localAddress.startsWith('[')) {
        const closingBracketIndex = localAddress.indexOf(']');
        if (closingBracketIndex > 0) {
            const host = normalizeAddress(localAddress.slice(1, closingBracketIndex));
            const remainder = localAddress.slice(closingBracketIndex + 1);

            return {
                host,
                port: remainder.startsWith(':') ? remainder.slice(1) || null : null
            };
        }
    }

    const hostWithPortMatch = localAddress.match(/^([^:]+):(\d+)$/);
    if (hostWithPortMatch) {
        return {
            host: normalizeAddress(hostWithPortMatch[1]),
            port: hostWithPortMatch[2]
        };
    }

    return {
        host: normalizeAddress(localAddress),
        port: null
    };
}

function isValidIpv4(address: string): boolean {
    if (!ipv4Pattern.test(address)) return false;

    return address.split('.').every((part) => {
        const value = Number(part);
        return Number.isInteger(value) && value >= 0 && value <= 255;
    });
}

function isLocalIpv4(address: string): boolean {
    if (!isValidIpv4(address)) return false;

    const [firstOctet, secondOctet] = address.split('.').map(Number);
    return firstOctet === 10
        || firstOctet === 127
        || (firstOctet === 169 && secondOctet === 254)
        || (firstOctet === 172 && secondOctet >= 16 && secondOctet <= 31)
        || (firstOctet === 192 && secondOctet === 168);
}

function isLocalIpv6(address: string): boolean {
    if (!address.includes(':') || !ipv6Pattern.test(address)) return false;

    return address === '::1'
        || address.startsWith('fc')
        || address.startsWith('fd')
        || localIpv6LinkLocalPattern.test(address);
}

function isLocalHostname(hostname: string): boolean {
    return hostname === 'localhost' || hostname.endsWith('.localhost');
}

function getLocalAddressFromUrl(url: string): string | null {
    try {
        const parsedUrl = new URL(url);
        const hostname = normalizeAddress(parsedUrl.hostname);
        if (!hostname) return null;

        if (isLocalHostname(hostname) || isLocalIpv4(hostname) || isLocalIpv6(hostname)) {
            return hostname;
        }
    } catch {
        return null;
    }

    return null;
}

function getLocalAddressFromIp(ip: string | undefined): string | null {
    if (!ip) return null;

    const normalizedIp = normalizeAddress(ip);
    if (isLocalIpv4(normalizedIp) || isLocalIpv6(normalizedIp)) {
        return normalizedIp;
    }

    return null;
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

function getTrackableTabUrl(tab: chrome.tabs.Tab): string | null {
    const candidateUrl = tab.pendingUrl ?? tab.url;
    if (!candidateUrl?.startsWith('http')) return null;
    return candidateUrl;
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

function rememberKnownOrigin(tabId: number, origin: string | null): void {
    if (tabId < 0 || !origin) return;

    const knownOrigins = tabKnownOrigins.get(tabId) ?? new Set<string>();
    if (knownOrigins.has(origin)) return;

    knownOrigins.add(origin);
    tabKnownOrigins.set(tabId, knownOrigins);

    const tabsForOrigin = originTabIds.get(origin) ?? new Set<number>();
    tabsForOrigin.add(tabId);
    originTabIds.set(origin, tabsForOrigin);
}

function clearKnownOrigins(tabId: number): void {
    const knownOrigins = tabKnownOrigins.get(tabId);
    if (!knownOrigins) return;

    for (const origin of knownOrigins) {
        const tabsForOrigin = originTabIds.get(origin);
        tabsForOrigin?.delete(tabId);
        if (tabsForOrigin && tabsForOrigin.size === 0) {
            originTabIds.delete(origin);
        }
    }

    tabKnownOrigins.delete(tabId);
}

function updateOriginTabIndex(tabId: number, nextOrigin: string | null): void {
    if (!nextOrigin) {
        tabTopLevelOrigins.delete(tabId);
        return;
    }

    tabTopLevelOrigins.set(tabId, nextOrigin);
    rememberKnownOrigin(tabId, nextOrigin);
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

    const requestOrigin = getOrigin(details.url);
    if (requestOrigin) {
        const tabsForOrigin = originTabIds.get(requestOrigin);
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

function getOrCreateTabDomainLocalAddresses(tabId: number): Map<string, Set<string>> {
    const existing = tabDomainLocalAddresses.get(tabId);
    if (existing) return existing;

    const created = new Map<string, Set<string>>();
    tabDomainLocalAddresses.set(tabId, created);
    return created;
}

function recordLocalAddress(tabId: number, domain: string, localAddress: string): void {
    if (!domain || !localAddress) return;

    const domainLocalAddresses = getOrCreateTabDomainLocalAddresses(tabId);
    const knownAddresses = domainLocalAddresses.get(domain) ?? new Set<string>();
    const nextAddress = parseStoredLocalAddress(localAddress);

    for (const existingAddress of Array.from(knownAddresses)) {
        const parsedExistingAddress = parseStoredLocalAddress(existingAddress);
        if (parsedExistingAddress.host !== nextAddress.host) continue;
        knownAddresses.delete(existingAddress);
    }

    const previousSize = knownAddresses.size;
    knownAddresses.add(nextAddress.host);
    domainLocalAddresses.set(domain, knownAddresses);

    if (knownAddresses.size !== previousSize) {
        scheduleSnapshot(tabId);
        schedulePersistState();
    }
}

function ensureTabDomainFromUrl(tabId: number, url: string, defaultCount = 1): void {
    const rootDomain = getRootDomain(url);
    if (rootDomain === 'unknown') return;

    const domainCounts = getOrCreateTabDomainCounts(tabId);
    if (!domainCounts.has(rootDomain)) {
        domainCounts.set(rootDomain, defaultCount);
    }

    updateOriginTabIndex(tabId, getOrigin(url));
    rememberKnownOrigin(tabId, getOrigin(url));
    const directLocalAddress = getLocalAddressFromUrl(url);
    if (directLocalAddress) {
        recordLocalAddress(tabId, rootDomain, directLocalAddress);
    }

    scheduleSnapshot(tabId);
    schedulePersistState();
}

function serializeState(): PersistedSessionState {
    const serializedState: PersistedSessionState = {};

    tabDomainCounts.forEach((domainCounts, tabId) => {
        if (domainCounts.size === 0) return;

        serializedState[String(tabId)] = {
            domainCounts: Object.fromEntries(domainCounts),
            localAddresses: tabDomainLocalAddresses.has(tabId)
                ? Object.fromEntries(
                    Array.from(tabDomainLocalAddresses.get(tabId)!.entries()).map(([domain, addresses]) => [
                        domain,
                        Array.from(addresses).sort((left, right) => left.localeCompare(right))
                    ])
                )
                : undefined,
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

        const restoredLocalAddresses = new Map<string, Set<string>>();
        Object.entries(persistedState.localAddresses ?? {}).forEach(([domain, addresses]) => {
            const normalizedAddresses = (Array.isArray(addresses) ? addresses : [])
                .map((address) => typeof address === 'string' ? parseStoredLocalAddress(address).host : '')
                .filter(Boolean);

            if (domain && normalizedAddresses.length > 0) {
                restoredLocalAddresses.set(domain, new Set(normalizedAddresses));
            }
        });

        if (restoredLocalAddresses.size > 0) {
            tabDomainLocalAddresses.set(tabId, restoredLocalAddresses);
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
    tabDomainLocalAddresses.delete(tabId);
    tabActiveConnections.delete(tabId);
    clearTabDocumentLinks(tabId);
    clearKnownOrigins(tabId);
    updateOriginTabIndex(tabId, null);
    schedulePersistState();
}

function resetTabTracking(tabId: number): void {
    tabDomainCounts.set(tabId, new Map());
    tabDomainLocalAddresses.set(tabId, new Map());
    tabActiveConnections.set(tabId, new Map());
    clearTabDocumentLinks(tabId);
    clearKnownOrigins(tabId);
}

function seedTopLevelNavigation(tabId: number, url: string): void {
    if (tabId < 0 || !url.startsWith('http')) return;

    resetTabTracking(tabId);
    updateOriginTabIndex(tabId, getOrigin(url));
    ensureTabDomainFromUrl(tabId, url);
}

function addRequest(details: RequestDetails): void {
    const resolvedTabId = resolveTabId(details);
    if (resolvedTabId < 0) return;

    const isMainFrame = details.type === 'main_frame';

    // Новый main_frame = новая навигация вкладки, сбрасываем предыдущий список.
    if (isMainFrame) {
        resetTabTracking(resolvedTabId);
        rememberDocumentTabLink(resolvedTabId, details.documentId);
        updateOriginTabIndex(resolvedTabId, getOrigin(details.url));
    }

    rememberKnownOrigin(resolvedTabId, getOrigin(details.url));
    rememberKnownOrigin(
        resolvedTabId,
        details.initiator && details.initiator !== 'null' ? details.initiator : null
    );

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

function trackLocalAddress(details: RequestWithIpDetails): void {
    const resolvedTabId = resolveTabId(details);
    if (resolvedTabId < 0) return;

    rememberKnownOrigin(resolvedTabId, getOrigin(details.url));
    rememberKnownOrigin(
        resolvedTabId,
        details.initiator && details.initiator !== 'null' ? details.initiator : null
    );

    const rootDomain = getRootDomain(details.url);
    if (rootDomain === 'unknown') return;

    const localAddress = getLocalAddressFromUrl(details.url) ?? getLocalAddressFromIp(details.ip);
    if (!localAddress) return;

    recordLocalAddress(resolvedTabId, rootDomain, localAddress);
}

async function primeTabFromCurrentUrl(tabId: number): Promise<void> {
    try {
        const tab = await chrome.tabs.get(tabId);
        const candidateUrl = getTrackableTabUrl(tab);
        if (!candidateUrl) return;

        ensureTabDomainFromUrl(tabId, candidateUrl);
    } catch {
        // Tab could disappear between subscribe and lookup.
    }
}

async function subscribePortToTab(port: chrome.runtime.Port, tabId: number): Promise<void> {
    const subscribers = tabSubscribers.get(tabId) ?? new Set<chrome.runtime.Port>();
    subscribers.add(port);
    tabSubscribers.set(tabId, subscribers);

    await primeTabFromCurrentUrl(tabId);
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
            trackLocalAddress(details);
            removeActiveRequest(details);
        });
    },
    { urls: ['<all_urls>'] }
);

chrome.webRequest.onResponseStarted.addListener(
    (details) => {
        runWithRestoredState(() => {
            trackLocalAddress(details);
        });
    },
    { urls: ['<all_urls>'] }
);

chrome.webRequest.onErrorOccurred.addListener(
    (details) => {
        runWithRestoredState(() => {
            trackLocalAddress(details);
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
            void subscribePortToTab(port, subscribedTabId);
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

chrome.webNavigation.onBeforeNavigate.addListener((details) => {
    runWithRestoredState(() => {
        if (details.frameId !== 0) return;
        seedTopLevelNavigation(details.tabId, details.url);
    });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    runWithRestoredState(() => {
        const candidateUrl = tab.pendingUrl ?? changeInfo.url ?? tab.url;
        if (!candidateUrl) return;

        if (!candidateUrl.startsWith('http')) {
            clearTabData(tabId);
            return;
        }

        if (changeInfo.url || changeInfo.status === 'loading') {
            ensureTabDomainFromUrl(tabId, candidateUrl);
        }
    });
});

chrome.tabs.onReplaced.addListener((_addedTabId, removedTabId) => {
    runWithRestoredState(() => {
        clearTabData(removedTabId);
    });
});
