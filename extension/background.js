// Fetches the falling-towns data that the CowRadar server publishes online every 30 minutes.
const DATA_URL = "https://gist.githubusercontent.com/ssiliss/b3c45c1c180cb0696439284943466272/raw/falling.json";

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "fetch-falling") {
    fetch(`${DATA_URL}?t=${Date.now()}`, { cache: "no-store" })
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        sendResponse(r.ok ? { ok: true, data: body } : { ok: false, error: body.error || `HTTP ${r.status}` });
      })
      .catch(() => sendResponse({ ok: false, error: "Can't reach the data - check your internet connection" }));
    return true; // keep the channel open for the async answer
  }
});
