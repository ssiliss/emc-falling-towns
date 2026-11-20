// Bridge between the page script (page.js, runs inside the map page) and the extension background.
window.addEventListener("message", (event) => {
  if (event.source !== window || !event.data || event.data.src !== "emcfall-page") return;
  if (event.data.type === "fetch") {
    chrome.runtime.sendMessage({ type: "fetch-falling" }, (res) => {
      const reply = res || { ok: false, error: chrome.runtime.lastError ? chrome.runtime.lastError.message : "no answer" };
      window.postMessage({ src: "emcfall-content", type: "data", ...reply }, window.location.origin);
    });
  }
});
