// src/inject.ts
(function () {
    const seenUrls = new Set<string>();

    // Безопасная отправка события (вне основного потока выполнения)
    const notify = (url: any) => {
        if (!url || typeof url !== 'string' || !url.startsWith('http')) return;
        if (seenUrls.has(url)) return;

        seenUrls.add(url);
        // Очистка памяти время от времени
        if (seenUrls.size > 500) seenUrls.clear();

        // Используем setTimeout, чтобы "оторвать" нашу логику от сетевого стека страницы
        setTimeout(() => {
            window.dispatchEvent(new CustomEvent('domain-analyzer-url', { detail: url }));
        }, 0);
    };

    // Перехват fetch через Proxy
    if (window.fetch) {
        window.fetch = new Proxy(window.fetch, {
            apply(target, thisArg, args) {
                try {
                    const input = args[0];
                    const url = input instanceof Request ? input.url : String(input);
                    notify(url);
                } catch (e) { }
                return Reflect.apply(target, thisArg, args);
            }
        });
    }

    // Перехват XMLHttpRequest
    const originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (_method: string, url: string | URL) {
        try {
            const urlString = url instanceof URL ? url.href : String(url);
            notify(urlString);
        } catch (e) { }
        return originalOpen.apply(this, arguments as any);
    };

    // Перехват Beacon API
    if (navigator.sendBeacon) {
        navigator.sendBeacon = new Proxy(navigator.sendBeacon, {
            apply(target, thisArg, args) {
                try {
                    notify(args[0]);
                } catch (e) { }
                return Reflect.apply(target, thisArg, args);
            }
        });
    }
})();
