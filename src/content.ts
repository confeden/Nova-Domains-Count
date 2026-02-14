/// <reference types="chrome" />

// Увеличиваем лимит буфера ресурсов
performance.setResourceTimingBufferSize(10000);

// Используем массив для накопления ВСЕХ запросов (включая повторные к одним и тем же URL)
const collectedUrls: string[] = [window.location.href];
let pendingUpdate = false;

// Храним активные соединения для отправки обновлений
const activePorts = new Set<chrome.runtime.Port>();

const sendUpdate = () => {
    if (pendingUpdate) return;
    pendingUpdate = true;

    // Дросселирование - отправляем данные не чаще чем раз в 300мс
    setTimeout(() => {
        const data = { urls: collectedUrls };
        activePorts.forEach(port => {
            try {
                port.postMessage(data);
            } catch (e) {
                activePorts.delete(port);
            }
        });
        pendingUpdate = false;
    }, 300);
};

// Глобальный наблюдатель ресурсов (для картинок, скриптов, стилей)
const observer = new PerformanceObserver((list) => {
    list.getEntries().forEach((entry: any) => {
        // Игнорируем fetch и xmlhttprequest, так как мы ловим их проактивно через inject.ts
        if (entry.initiatorType !== 'fetch' && entry.initiatorType !== 'xmlhttprequest') {
            collectedUrls.push(entry.name);
        }
    });
    sendUpdate();
});

// buffered: true позволяет получить ресурсы, загруженные до запуска скрипта
observer.observe({ type: "resource", buffered: true });

// Слушаем события от нашего инъекционного скрипта (мгновенный перехват)
window.addEventListener('domain-analyzer-url', (event: any) => {
    const url = event.detail;
    if (url) {
        collectedUrls.push(url);
        sendUpdate();
    }
});

// Слушаем PING от Popup, чтобы подтвердить готовность
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === "PING") {
        sendResponse({ status: "READY" });
    }
    return true;
});

// Устанавливаем соединение с Popup
chrome.runtime.onConnect.addListener((port: chrome.runtime.Port) => {
    if (port.name !== "domain-analyzer") return;

    activePorts.add(port);

    // Сразу отправляем накопленные данные при подключении
    port.postMessage({ urls: collectedUrls });

    port.onDisconnect.addListener(() => {
        activePorts.delete(port);
    });
});
