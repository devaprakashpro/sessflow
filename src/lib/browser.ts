import browser from 'webextension-polyfill';

/**
 * Single import surface for the WebExtension API so the rest of the codebase
 * is browser-agnostic (Chrome `chrome.*` callbacks are promisified by the
 * polyfill, and Firefox is native-promise already).
 */
export { browser };
export default browser;
