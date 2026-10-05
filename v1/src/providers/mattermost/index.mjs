// Mattermost outbound provider (declarative spec channel, T23).
import { specProviders } from '../specs.mjs';

export const id = 'mattermost';
const provider = specProviders[id];
export const capabilities = provider.capabilities;
export const resolve = provider.resolve;
export const validate = provider.validate;
export const send = provider.send;
export default provider;