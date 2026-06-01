// CADENCE Background Service Worker
// Handles DAG storage, intent matching, path planning, and LRU cache.

// ------------------------------------------------------------------
// LRU Cache
// ------------------------------------------------------------------
class LRUCache {
  constructor(maxSize = 50) {
    this.maxSize = maxSize;
    this.cache = new Map();
  }

  get(key) {
    if (!this.cache.has(key)) return null;
    const val = this.cache.get(key);
    // Re-insert to mark as recently used
    this.cache.delete(key);
    this.cache.set(key, val);
    return val;
  }

  set(key, value) {
    if (this.cache.has(key)) this.cache.delete(key);
    if (this.cache.size >= this.maxSize) {
      // Evict least recently used (first entry)
      this.cache.delete(this.cache.keys().next().value);
    }
    this.cache.set(key, value);
  }

  has(key) { return this.cache.has(key); }
}

const queryCache = new LRUCache(50);

// ------------------------------------------------------------------
// DAG state (in memory; persisted to chrome.storage.local)
// ------------------------------------------------------------------
let dag = null;
let adjacency = {};   // node_id -> [{ edge, target_id }]
let nodeIndex = {};   // node_id -> node
let linkIndex = {};   // interaction_id -> link

async function loadDagFromStorage() {
  const stored = await chrome.storage.local.get("cadence_dag");
  if (stored.cadence_dag) {
    dag = stored.cadence_dag;
    buildIndices();
  }
}

function buildIndices() {
  adjacency = {};
  nodeIndex = {};
  linkIndex = {};
  if (!dag) return;

  dag.nodes.forEach(n => {
    nodeIndex[n.id] = n;
    adjacency[n.id] = [];
  });

  dag.links.forEach(link => {
    linkIndex[link.interaction_id] = link;
    if (!adjacency[link.source]) adjacency[link.source] = [];
    adjacency[link.source].push({ edge: link, target_id: link.target });
  });
}

loadDagFromStorage();

// ------------------------------------------------------------------
// URL -> Node matching
// ------------------------------------------------------------------
function findNodeForUrl(url) {
  if (!dag) return null;
  try {
    const path = new URL(url).pathname;
    return dag.nodes.find(n => {
      if (!n.url_pattern) return false;
      return new RegExp(n.url_pattern).test(path);
    }) || null;
  } catch { return null; }
}

// ------------------------------------------------------------------
// Intent matching — score edges by how well ui_label matches query
// ------------------------------------------------------------------
function tokenise(text) {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
}

function scoreEdge(edge, queryTokens) {
  const labelTokens = tokenise(edge.ui_label || "");
  const matches = queryTokens.filter(t => labelTokens.some(l => l.includes(t) || t.includes(l)));
  return matches.length / Math.max(queryTokens.length, 1);
}

// BFS from startNodeId, scoring each reachable edge
function findBestPath(startNodeId, queryTokens) {
  const visited = new Set();
  const queue = [{ nodeId: startNodeId, path: [] }];
  let bestScore = 0;
  let bestPath = null;

  while (queue.length) {
    const { nodeId, path } = queue.shift();
    if (visited.has(nodeId)) continue;
    visited.add(nodeId);

    const edges = adjacency[nodeId] || [];
    for (const { edge, target_id } of edges) {
      const score = scoreEdge(edge, queryTokens);
      const currentPath = [...path, edge];

      if (score > bestScore) {
        bestScore = score;
        bestPath = currentPath;
      }

      if (!visited.has(target_id)) {
        queue.push({ nodeId: target_id, path: currentPath });
      }
    }
  }

  return bestScore > 0 ? { path: bestPath, score: bestScore } : null;
}

// ------------------------------------------------------------------
// Determine if a node is a data terminal (has API calls to replay)
// ------------------------------------------------------------------
function isDataTerminal(node) {
  if (!node) return false;
  return !!(node.properties && node.properties.extraction_selectors);
}

function getReplayableApiCall(edge) {
  const calls = edge.associated_network_calls || [];
  return calls.find(c => c.replayable_via_plugin !== false && c.method === "GET");
}

// ------------------------------------------------------------------
// Message handlers
// ------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "LOAD_DAG") {
    dag = msg.dag;
    buildIndices();
    chrome.storage.local.set({ cadence_dag: dag });
    sendResponse({
      ok: true,
      app: dag.graph.application_name,
      nodes: dag.nodes.length,
      edges: dag.links.length,
    });
    return true;
  }

  if (msg.type === "GET_DAG_INFO") {
    if (!dag) { sendResponse(null); return; }
    sendResponse({
      loaded: true,
      app: dag.graph.application_name,
      nodes: dag.nodes.length,
      edges: dag.links.length,
    });
    return true;
  }

  if (msg.type === "GET_CURRENT_NODE") {
    const node = findNodeForUrl(msg.url);
    sendResponse({ node });
    return true;
  }

  if (msg.type === "QUERY") {
    handleQuery(msg, sender, sendResponse);
    return true; // async response
  }

  if (msg.type === "EXECUTION_RESULT") {
    // Forwarded from content script — broadcast to popup
    chrome.runtime.sendMessage({ type: "STEP_DONE", result: msg.result });
    return true;
  }

  if (msg.type === "EXECUTION_ERROR") {
    chrome.runtime.sendMessage({ type: "STEP_ERROR", error: msg.error });
    return true;
  }
});

// ------------------------------------------------------------------
// Query handler
// ------------------------------------------------------------------
async function handleQuery(msg, sender, sendResponse) {
  if (!dag) {
    sendResponse({ error: "No DAG loaded. Import a cadence_dag.json first." });
    return;
  }

  const { query, url, tabId } = msg;
  const cacheKey = query.toLowerCase().trim();

  // Check LRU cache first
  if (queryCache.has(cacheKey)) {
    const cached = queryCache.get(cacheKey);
    sendResponse({ cached: true, answer: cached.answer });
    return;
  }

  const startNode = findNodeForUrl(url);
  if (!startNode) {
    sendResponse({ error: `Current page not found in DAG. Make sure you're on ${dag.graph.application_name}.` });
    return;
  }

  const queryTokens = tokenise(query);
  const result = findBestPath(startNode.id, queryTokens);

  if (!result || !result.path || result.path.length === 0) {
    sendResponse({ error: `Could not find a path for: "${query}". Try rephrasing using the UI labels.` });
    return;
  }

  const { path } = result;
  const steps = path.map(e => e.ui_label);

  // Check if the last edge leads to a data terminal or has replayable API
  const lastEdge = path[path.length - 1];
  const targetNode = nodeIndex[lastEdge.target];
  const apiCall = getReplayableApiCall(lastEdge);
  const mode = apiCall ? "api" : "click";

  sendResponse({
    plan: {
      description: `Executing: ${steps.join(" → ")}`,
      steps,
    },
  });

  // Execute the plan
  executeplan(tabId, path, mode, cacheKey, query);
}

// ------------------------------------------------------------------
// Execution — sends plan to content script step by step
// ------------------------------------------------------------------
async function executeplan(tabId, path, mode, cacheKey, originalQuery) {
  const lastEdge = path[path.length - 1];

  try {
    for (let i = 0; i < path.length; i++) {
      const edge = path[i];
      const isLast = i === path.length - 1;

      // Notify popup of progress
      chrome.runtime.sendMessage({ type: "STEP_PROGRESS", step: i });

      if (isLast && mode === "api") {
        // Fast path: replay the API call directly
        const apiCall = getReplayableApiCall(edge);
        if (apiCall) {
          const result = await replayApiCall(tabId, apiCall, edge);
          queryCache.set(cacheKey, { answer: result });
          chrome.runtime.sendMessage({ type: "STEP_DONE", result });
          return;
        }
      }

      // Visible click path
      await chrome.scripting.executeScript({
        target: { tabId },
        func: clickElement,
        args: [edge.locator],
      });

      // Wait for navigation/animation to settle
      await sleep(1500);
    }

    // At terminal node — extract DOM data if selectors exist
    const targetNode = nodeIndex[lastEdge.target];
    if (targetNode && targetNode.properties && targetNode.properties.extraction_selectors) {
      const selectors = targetNode.properties.extraction_selectors;
      const [extracted] = await chrome.scripting.executeScript({
        target: { tabId },
        func: extractData,
        args: [selectors],
      });
      const result = formatExtracted(extracted.result);
      queryCache.set(cacheKey, { answer: result });
      chrome.runtime.sendMessage({ type: "STEP_DONE", result });
    } else {
      const result = "Done — reached the target page.";
      queryCache.set(cacheKey, { answer: result });
      chrome.runtime.sendMessage({ type: "STEP_DONE", result });
    }

  } catch (err) {
    chrome.runtime.sendMessage({ type: "STEP_ERROR", error: err.message || "Execution failed." });
  }
}

// Replay a GET API call using fetch from the page's context (carries cookies)
async function replayApiCall(tabId, apiCall, edge) {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    func: async (url) => {
      try {
        const r = await fetch(url, { credentials: "include" });
        const json = await r.json();
        return JSON.stringify(json, null, 2);
      } catch (e) {
        return `API call failed: ${e.message}`;
      }
    },
    args: [apiCall.url_pattern],
  });
  return res.result || "No data returned.";
}

function formatExtracted(data) {
  if (!data) return "No data extracted.";
  return Object.entries(data)
    .map(([k, v]) => `<strong>${k}</strong>: ${v}`)
    .join("<br>");
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ------------------------------------------------------------------
// Injected functions (run in page context via executeScript)
// ------------------------------------------------------------------

// Clicks an element using visible text first, CSS as fallback
function clickElement(locator) {
  // Try visible text match first (most stable)
  if (locator.visible_text_match) {
    const all = document.querySelectorAll("button, a, [role='button'], input[type='submit']");
    for (const el of all) {
      const text = (el.textContent || el.value || el.getAttribute("aria-label") || "").trim();
      if (text.toLowerCase().includes(locator.visible_text_match.toLowerCase())) {
        el.click();
        return { ok: true, method: "text", matched: text };
      }
    }
  }
  // CSS fallback
  if (locator.css) {
    const el = document.querySelector(locator.css);
    if (el) { el.click(); return { ok: true, method: "css" }; }
  }
  throw new Error(`Could not find element: "${locator.visible_text_match || locator.css}"`);
}

// Extracts data from the page using CSS selectors
function extractData(selectors) {
  const result = {};
  for (const [key, selector] of Object.entries(selectors)) {
    const el = document.querySelector(selector);
    result[key] = el ? (el.innerText || el.textContent || "").trim() : "not found";
  }
  return result;
}
