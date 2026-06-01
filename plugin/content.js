// CADENCE Content Script
// Relays execution results back to the background service worker.

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "PING") {
    sendResponse({ ok: true });
    return true;
  }
});
