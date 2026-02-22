import { useEffect, useMemo, useRef, useState } from 'react';
import {
    POPUP_PORT_NAME,
    SUBSCRIBE_TAB_MESSAGE_TYPE,
    TAB_DOMAINS_UPDATE_MESSAGE_TYPE,
    type DomainEntry,
    type SubscribeTabMessage,
    type TabDomainsUpdateMessage
} from './shared/messages';

const COPY_DEFAULT_LABEL = 'Copy all domains';
const COPY_SUCCESS_LABEL = 'Copied!';
const COPY_ERROR_LABEL = 'Copy failed';
const COPY_RESET_TIMEOUT_MS = 2000;
const LOADING_FALLBACK_MS = 1200;

function mapsAreEqual(left: Map<string, number>, right: Map<string, number>): boolean {
    if (left.size !== right.size) return false;

    for (const [domain, count] of left.entries()) {
        if (right.get(domain) !== count) return false;
    }

    return true;
}

function App() {
    const [domainMap, setDomainMap] = useState<Map<string, number>>(new Map());
    const [loading, setLoading] = useState(true);
    const [copyStatus, setCopyStatus] = useState(COPY_DEFAULT_LABEL);
    const [isDarkMode, setIsDarkMode] = useState(() => localStorage.getItem('theme') === 'dark');
    const copyResetTimerRef = useRef<number | null>(null);

    useEffect(() => {
        if (isDarkMode) {
            document.documentElement.classList.add('dark');
        } else {
            document.documentElement.classList.remove('dark');
        }
    }, [isDarkMode]);

    const toggleDarkMode = () => {
        const newMode = !isDarkMode;
        setIsDarkMode(newMode);
        localStorage.setItem('theme', newMode ? 'dark' : 'light');
    };

    const domains = useMemo(() => {
        return Array.from(domainMap.entries())
            .sort((left, right) => {
                const countDiff = right[1] - left[1];
                if (countDiff !== 0) return countDiff;
                return left[0].localeCompare(right[0]);
            })
            .map(([domain, count]) => ({ domain, count }));
    }, [domainMap]);

    const applyDomainSnapshot = (domainEntries: DomainEntry[]) => {
        const nextMap = new Map<string, number>();

        domainEntries.forEach((entry) => {
            if (!entry?.domain || entry.domain === 'unknown') return;
            nextMap.set(entry.domain, entry.count);
        });

        setDomainMap((currentMap) => mapsAreEqual(currentMap, nextMap) ? currentMap : nextMap);
        setLoading(false);
    };

    useEffect(() => {
        let port: chrome.runtime.Port | null = null;
        let activeTabId: number | null = null;
        let loadingFallbackTimer: number | null = null;

        const clearLoadingFallback = () => {
            if (loadingFallbackTimer !== null) {
                clearTimeout(loadingFallbackTimer);
                loadingFallbackTimer = null;
            }
        };

        const disconnectPort = () => {
            if (!port) return;
            port.disconnect();
            port = null;
        };

        const startLoadingWithFallback = () => {
            setLoading(true);
            clearLoadingFallback();
            loadingFallbackTimer = window.setTimeout(() => {
                setLoading(false);
            }, LOADING_FALLBACK_MS);
        };

        const resetDomains = () => {
            setDomainMap(new Map());
        };

        const subscribeToTab = (tabId: number) => {
            disconnectPort();

            port = chrome.runtime.connect({ name: POPUP_PORT_NAME });

            port.onMessage.addListener((rawMessage: unknown) => {
                if (!rawMessage || typeof rawMessage !== 'object') return;

                const message = rawMessage as Partial<TabDomainsUpdateMessage>;
                if (message.type !== TAB_DOMAINS_UPDATE_MESSAGE_TYPE) return;
                if (message.tabId !== tabId) return;

                const domains = Array.isArray(message.domains) ? message.domains : [];
                applyDomainSnapshot(domains);
            });

            port.onDisconnect.addListener(() => {
                port = null;
            });

            const subscribeMessage: SubscribeTabMessage = {
                type: SUBSCRIBE_TAB_MESSAGE_TYPE,
                tabId
            };
            port.postMessage(subscribeMessage);
            startLoadingWithFallback();
        };

        const connectToActiveTab = () => {
            chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                const activeTab = tabs[0];
                const tabId = activeTab?.id;

                if (typeof tabId !== 'number' || !activeTab?.url?.startsWith('http')) {
                    activeTabId = null;
                    resetDomains();
                    setLoading(false);
                    disconnectPort();
                    return;
                }

                activeTabId = tabId;
                resetDomains();
                subscribeToTab(tabId);
            });
        };

        const handleTabActivated = () => {
            connectToActiveTab();
        };

        const handleTabUpdate = (tabId: number, changeInfo: { status?: string }) => {
            if (tabId === activeTabId && changeInfo.status === 'loading') {
                resetDomains();
                startLoadingWithFallback();
            }
        };

        connectToActiveTab();

        chrome.tabs.onActivated.addListener(handleTabActivated);
        chrome.tabs.onUpdated.addListener(handleTabUpdate);

        return () => {
            clearLoadingFallback();
            disconnectPort();
            chrome.tabs.onActivated.removeListener(handleTabActivated);
            chrome.tabs.onUpdated.removeListener(handleTabUpdate);
        };
    }, []);

    useEffect(() => {
        return () => {
            if (copyResetTimerRef.current !== null) {
                clearTimeout(copyResetTimerRef.current);
            }
        };
    }, []);

    const setCopyStatusWithAutoReset = (status: string) => {
        setCopyStatus(status);

        if (copyResetTimerRef.current !== null) {
            clearTimeout(copyResetTimerRef.current);
        }

        copyResetTimerRef.current = window.setTimeout(() => {
            setCopyStatus(COPY_DEFAULT_LABEL);
        }, COPY_RESET_TIMEOUT_MS);
    };

    const handleCopy = () => {
        const textToCopy = domains.map(d => d.domain).join('\n');
        navigator.clipboard.writeText(textToCopy)
            .then(() => setCopyStatusWithAutoReset(COPY_SUCCESS_LABEL))
            .catch(() => setCopyStatusWithAutoReset(COPY_ERROR_LABEL));
    };

    const copySingleDomain = (domain: string) => {
        navigator.clipboard.writeText(domain);
    };

    const handleReload = () => {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs[0]?.id) {
                setDomainMap(new Map());
                setLoading(true);
                chrome.tabs.reload(tabs[0].id);
            }
        });
    };

    return (
        <div className="flex flex-col h-full dark:bg-gray-900 text-gray-800 dark:text-gray-100 font-sans w-full relative overflow-hidden">
            <main className="flex-1 overflow-y-auto mb-[60px]">
                {loading ? (
                    <div className="flex justify-center items-center h-[200px] text-gray-400 dark:text-gray-500">
                        Загрузка...
                    </div>
                ) : (
                    <table className="w-full border-collapse table-fixed">
                        <thead className="bg-gray-100 dark:bg-gray-800 sticky top-0 z-10 shadow-sm transition-colors">
                            <tr>
                                <th className="p-3 text-left text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider w-[30%] text-nowrap">Domains</th>
                                <th className="p-3 text-center text-[10px] font-medium text-gray-400 dark:text-gray-500 w-[50%]">
                                    <div className="whitespace-nowrap overflow-hidden">
                                        Brent | <a
                                            href="https://t.me/app_nova"
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="text-indigo-500 hover:text-indigo-600 dark:text-indigo-400 dark:hover:text-indigo-300 underline lowercase"
                                        >t.me/app_nova</a>
                                    </div>
                                </th>
                                <th className="p-3 text-right text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider w-[20%] text-nowrap">Count</th>
                            </tr>
                        </thead>
                        <tbody className="bg-white dark:bg-gray-900 divide-y divide-gray-200 dark:divide-gray-800 transition-colors">
                            {domains.length === 0 ? (
                                <tr>
                                    <td colSpan={3} className="p-8 text-center text-gray-400 dark:text-gray-500 text-sm">
                                        Нет данных для отображения
                                    </td>
                                </tr>
                            ) : (
                                domains.map((item) => (
                                    <tr key={item.domain} className="group hover:bg-indigo-50 dark:hover:bg-indigo-900/30 transition-colors relative">
                                        <td className="p-3 relative overflow-hidden" colSpan={2}>
                                            <span className="block font-bold text-lg text-black dark:text-white select-text cursor-text whitespace-nowrap overflow-hidden pr-2" style={{ fontFamily: '"Segoe UI", sans-serif' }}>
                                                {item.domain}
                                            </span>
                                            <button
                                                onClick={() => copySingleDomain(item.domain)}
                                                className="hidden group-hover:block absolute right-2 top-1/2 -translate-y-1/2 bg-green-500 hover:bg-green-600 dark:bg-green-600 dark:hover:bg-green-700 text-white text-xs font-semibold py-1.5 px-3 rounded-lg shadow-xl transition-all active:scale-95 z-20 border border-white dark:border-gray-800"
                                            >
                                                Copy
                                            </button>
                                        </td>
                                        <td className="p-3 text-right align-middle">
                                            <span className="inline-block bg-indigo-100 dark:bg-indigo-900/50 text-indigo-800 dark:text-indigo-300 text-sm font-bold px-2 py-0.5 rounded border border-indigo-200 dark:border-indigo-800 transition-colors">
                                                {item.count}
                                            </span>
                                        </td>
                                    </tr>
                                ))
                            )}
                        </tbody>
                    </table>
                )}
            </main>

            <footer className="absolute bottom-0 left-0 right-0 p-3 bg-white dark:bg-gray-900 border-t border-gray-200 dark:border-gray-800 flex gap-2 z-30">
                <button
                    onClick={handleReload}
                    className="p-2 bg-green-500 hover:bg-green-600 dark:bg-green-600 dark:hover:bg-green-700 text-white rounded-lg flex-shrink-0"
                >
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
                    </svg>
                </button>
                <button
                    onClick={handleCopy}
                    className={`flex-1 py-2 px-4 rounded-lg text-sm font-semibold 
                ${copyStatus === COPY_SUCCESS_LABEL
                            ? "bg-green-500 text-white"
                            : "bg-indigo-600 dark:bg-indigo-700 text-white hover:bg-indigo-700 dark:hover:bg-indigo-600 active:scale-95"
                        }`}
                >
                    {copyStatus}
                </button>
                <button
                    onClick={toggleDarkMode}
                    className="p-2 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-300 rounded-lg flex-shrink-0"
                >
                    {isDarkMode ? (
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5 text-yellow-400">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v2.25m6.364.386l-1.591 1.591M21 12h-2.25m-.386 6.364l-1.591-1.591M12 18.75V21m-4.773-4.227l-1.591 1.591M3 12h2.25m.386-6.364l1.591 1.591M12 18.75V21m-4.773-4.227l-1.591 1.591M15.75 12a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0z" />
                        </svg>
                    ) : (
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5 text-indigo-600">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M21.752 15.002A9.718 9.718 0 0118 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 003 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 009.002-5.998z" />
                        </svg>
                    )}
                </button>
            </footer>
        </div>
    );
}

export default App;
