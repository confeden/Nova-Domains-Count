const domainCache = new Map<string, string>();

export function getRootDomain(url: string): string {
    if (domainCache.has(url)) return domainCache.get(url)!;

    try {
        const hostname = new URL(url).hostname;
        const parts = hostname.split('.');

        let result: string;
        if (parts.length <= 2) {
            result = hostname;
        } else {
            const lastPart = parts[parts.length - 1];
            const secondLastPart = parts[parts.length - 2];

            if (secondLastPart.length <= 3 && lastPart.length <= 3) {
                result = parts.slice(-3).join('.');
            } else {
                result = parts.slice(-2).join('.');
            }
        }

        // Ограничиваем размер кеша, чтобы не потреблять память бесконечно
        if (domainCache.size > 1000) domainCache.clear();
        domainCache.set(url, result);
        return result;
    } catch (e) {
        return 'unknown';
    }
}
