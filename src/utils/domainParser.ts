const domainCache = new Map<string, string>();
const ipv4Pattern = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const ipv6Pattern = /^[0-9a-f:]+$/i;

function isValidIpv4(hostname: string): boolean {
    if (!ipv4Pattern.test(hostname)) return false;
    return hostname.split('.').every((part) => {
        const value = Number(part);
        return Number.isInteger(value) && value >= 0 && value <= 255;
    });
}

function isIpAddress(hostname: string): boolean {
    if (isValidIpv4(hostname)) return true;
    // Chrome может отдавать IPv6 без скобок в hostname.
    return hostname.includes(':') && ipv6Pattern.test(hostname);
}

export function getRootDomain(url: string): string {
    try {
        const hostname = new URL(url).hostname.toLowerCase();
        if (!hostname || isIpAddress(hostname)) return 'unknown';

        if (domainCache.has(hostname)) return domainCache.get(hostname)!;

        const parts = hostname.split('.');
        let result: string;

        if (parts.length <= 2) {
            result = hostname;
        } else {
            const lastPart = parts[parts.length - 1];
            const secondLastPart = parts[parts.length - 2];

            result = secondLastPart.length <= 3 && lastPart.length <= 3
                ? parts.slice(-3).join('.')
                : parts.slice(-2).join('.');
        }

        // Ограничиваем кеш, чтобы не рос бесконечно на динамических URL.
        if (domainCache.size > 1000) domainCache.clear();
        domainCache.set(hostname, result);
        return result;
    } catch {
        return 'unknown';
    }
}
