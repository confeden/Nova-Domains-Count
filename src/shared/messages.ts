export const POPUP_PORT_NAME = 'domain-analyzer-popup';
export const SUBSCRIBE_TAB_MESSAGE_TYPE = 'SUBSCRIBE_TAB';
export const TAB_DOMAINS_UPDATE_MESSAGE_TYPE = 'TAB_DOMAINS_UPDATE';

export type DomainEntry = {
    domain: string;
    count: number;
};

export type SubscribeTabMessage = {
    type: typeof SUBSCRIBE_TAB_MESSAGE_TYPE;
    tabId: number;
};

export type TabDomainsUpdateMessage = {
    type: typeof TAB_DOMAINS_UPDATE_MESSAGE_TYPE;
    tabId: number;
    domains: DomainEntry[];
};
