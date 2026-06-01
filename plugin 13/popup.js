const messagesEl = document.getElementById("messages");
const queryInput = document.getElementById("queryInput");
const btnSend = document.getElementById("btnSend");
const btnImport = document.getElementById("btnImport");
const fileInput = document.getElementById("fileInput");
const dagInfo = document.getElementById("dagInfo");
const pageCtx = document.getElementById("pageCtx");
const btnGear = document.getElementById("btnGear");
const settingsPanel = document.getElementById("settingsPanel");
const apiKeyInput = document.getElementById("apiKeyInput");
const btnSaveKey = document.getElementById("btnSaveKey");
const keyStatus = document.getElementById("keyStatus");

// ------------------------------------------------------------------
// Settings — API key
// ------------------------------------------------------------------
btnGear.addEventListener("click", () => settingsPanel.classList.toggle("open"));

chrome.storage.local.get("cadence_api_key", (stored) => {
  if (stored.cadence_api_key) {
    keyStatus.textContent = "● set";
    keyStatus.className = "key-status set";
    apiKeyInput.placeholder = "sk-ant-... (saved)";
  } else {
    keyStatus.textContent = "● not set";
    keyStatus.className = "key-status unset";
  }
});

btnSaveKey.addEventListener("click", () => {
  const key = apiKeyInput.value.trim();
  if (!key) return;
  chrome.storage.local.set({ cadence_api_key: key }, () => {
    apiKeyInput.value = "";
    apiKeyInput.placeholder = "sk-ant-... (saved)";
    keyStatus.textContent = "● set";
    keyStatus.className = "key-status set";
    settingsPanel.classList.remove("open");
    addMessage("agent", "API key saved.");
  });
});

// ------------------------------------------------------------------
// Init — check if a DAG is already loaded and update current page ctx
// ------------------------------------------------------------------
chrome.runtime.sendMessage({ type: "GET_DAG_INFO" }, (info) => {
  if (info && info.loaded) {
    setDagLoaded(info);
  }
});

chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
  if (tab) {
    pageCtx.innerHTML = `Current page: <span>${tab.url}</span>`;
    chrome.runtime.sendMessage({ type: "GET_CURRENT_NODE", url: tab.url }, (res) => {
      if (res && res.node) {
        pageCtx.innerHTML = `On node: <span>${res.node.label}</span>`;
      }
    });
  }
});

// ------------------------------------------------------------------
// DAG import
// ------------------------------------------------------------------
btnImport.addEventListener("click", () => fileInput.click());

fileInput.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    try {
      const dag = JSON.parse(ev.target.result);
      // Write directly to storage to avoid message size limits, then notify background
      chrome.storage.local.set({ cadence_dag: dag }, () => {
        chrome.runtime.sendMessage({ type: "RELOAD_DAG" }, (res) => {
          if (res && res.ok) {
            setDagLoaded(res);
            addMessage("agent", `DAG loaded: <strong>${dag.graph.application_name}</strong> — ${dag.nodes.length} nodes, ${dag.links.length} edges.`);
          } else {
            addMessage("agent", "Failed to load DAG — invalid format.", true);
          }
        });
      });
    } catch {
      addMessage("agent", "Could not parse JSON file.", true);
    }
  };
  reader.readAsText(file);
  fileInput.value = "";
});

function setDagLoaded(info) {
  dagInfo.innerHTML = `DAG: <span>${info.app || "loaded"}</span> · ${info.nodes}n / ${info.edges}e`;
  btnSend.disabled = false;
  queryInput.placeholder = "Ask me to do something on this page...";
}

// ------------------------------------------------------------------
// Query submission
// ------------------------------------------------------------------
btnSend.addEventListener("click", submitQuery);
queryInput.addEventListener("keydown", (e) => { if (e.key === "Enter") submitQuery(); });

async function submitQuery() {
  const query = queryInput.value.trim();
  if (!query) return;

  queryInput.value = "";
  btnSend.disabled = true;
  addMessage("user", query);

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  chrome.runtime.sendMessage({ type: "QUERY", query, url: tab.url, tabId: tab.id }, (res) => {
    btnSend.disabled = false;

    if (!res) {
      addMessage("agent", "No response from background.", true);
      return;
    }

    if (res.error) {
      addMessage("agent", res.error, true);
      return;
    }

    if (res.cached) {
      addMessage("agent", `(cached) ${res.answer}`);
      return;
    }

    if (res.answer) {
      addMessage("agent", res.answer);
      return;
    }

    if (res.plan) {
      const stepsEl = addMessage("agent", res.plan.description);
      showSteps(stepsEl, res.plan.steps);
    }
  });
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------
function addMessage(role, html, isError = false) {
  const now = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const div = document.createElement("div");
  div.className = `msg ${role}${isError ? " error" : ""}`;
  div.innerHTML = `<div class="bubble">${html}</div><span class="msg-time">${now}</span>`;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}

function showSteps(containerEl, steps) {
  const stepsDiv = document.createElement("div");
  stepsDiv.className = "steps";
  steps.forEach((s, i) => {
    const d = document.createElement("div");
    d.id = `step-${i}`;
    d.className = i === 0 ? "active" : "";
    d.textContent = `${i + 1}. ${s}`;
    stepsDiv.appendChild(d);
  });
  containerEl.appendChild(stepsDiv);

  // Listen for step progress updates
  const listener = (msg) => {
    if (msg.type === "STEP_PROGRESS") {
      const prev = stepsDiv.querySelector(".active");
      if (prev) prev.className = "done";
      const next = stepsDiv.querySelector(`#step-${msg.step}`);
      if (next) next.className = "active";
    }
    if (msg.type === "STEP_DONE") {
      stepsDiv.querySelectorAll("div").forEach(d => d.className = "done");
      chrome.runtime.onMessage.removeListener(listener);
      // Show final result
      if (msg.result) addMessage("agent", msg.result);
    }
    if (msg.type === "STEP_ERROR") {
      const active = stepsDiv.querySelector(".active");
      if (active) active.style.color = "#fc8181";
      chrome.runtime.onMessage.removeListener(listener);
      addMessage("agent", msg.error, true);
    }
  };
  chrome.runtime.onMessage.addListener(listener);
}
