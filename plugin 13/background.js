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
    this.cache.delete(key);
    this.cache.set(key, val);
    return val;
  }

  set(key, value) {
    if (this.cache.has(key)) this.cache.delete(key);
    if (this.cache.size >= this.maxSize) {
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
// Collect all reachable edges via BFS (for AI prompt)
// ------------------------------------------------------------------
function getAllReachableEdges(startNodeId) {
  const visited = new Set();
  const queue = [startNodeId];
  const edges = [];

  while (queue.length) {
    const nodeId = queue.shift();
    if (visited.has(nodeId)) continue;
    visited.add(nodeId);

    for (const { edge, target_id } of (adjacency[nodeId] || [])) {
      const sourceNode = nodeIndex[nodeId];
      const targetNode = nodeIndex[target_id];
      edges.push({
        interaction_id: edge.interaction_id,
        ui_label: edge.ui_label,
        source_label: sourceNode ? sourceNode.label : nodeId,
        target_label: targetNode ? targetNode.label : target_id,
        source_id: nodeId,
        target_id,
      });
      if (!visited.has(target_id)) queue.push(target_id);
    }
  }

  return edges;
}

// ------------------------------------------------------------------
// Claude API — resolve natural language query to a path of edge IDs
// ------------------------------------------------------------------
async function resolvePathWithAI(query, startNodeId, apiKey) {
  const reachableEdges = getAllReachableEdges(startNodeId);
  if (!reachableEdges.length) return null;

  console.log("[CADENCE] Reachable edges for query:", reachableEdges.map(e => e.ui_label));

  const edgeList = reachableEdges
    .map(e => `[${e.interaction_id}] "${e.ui_label}"  (${e.source_label} -> ${e.target_label})`)
    .join("\n");

  const startNode = nodeIndex[startNodeId];

  const prompt = `You are a UI navigation assistant for a web application.

The user is currently on: "${startNode ? startNode.label : startNodeId}"

The user wants to: "${query}"

Available navigation actions (each line: [interaction_id] "button/link label"  (from page -> to page)):
${edgeList}

Return ONLY a valid JSON array of interaction_ids representing the shortest sequential path to fulfill the user's request. Each step's target page must be the source of the next step.

Example response: ["act_state_node_1_0", "act_state_node_2_3"]

If no path can fulfill the request, return [].
Do not include any explanation — only the JSON array.`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 256,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error?.message || `API error ${response.status}`);
  }

  const data = await response.json();
  let text = data.content?.[0]?.text?.trim() || "[]";

  // Strip markdown code fences if Claude wrapped the response
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();

  console.log("[CADENCE] AI response:", text);

  let ids;
  try {
    ids = JSON.parse(text);
  } catch {
    console.error("[CADENCE] Failed to parse AI response as JSON:", text);
    return null;
  }

  if (!Array.isArray(ids) || ids.length === 0) return null;

  // Resolve interaction_ids back to edge objects, validate they exist
  const path = ids.map(id => linkIndex[id]).filter(Boolean);
  console.log("[CADENCE] Resolved path:", ids, "->", path.length, "edges");
  return path.length ? path : null;
}

// ------------------------------------------------------------------
// Page summarisation
// ------------------------------------------------------------------
const SUMMARISE_PATTERNS = /\b(summar|what does|what is|explain|overview|tell me about|describe)\b/i;

async function summarisePage(tabId, apiKey, userQuery = null) {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      // Grab visible text, skip nav/footer noise
      const skip = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "HEADER", "FOOTER", "NAV"]);
      const walk = (el) => {
        if (skip.has(el.tagName)) return "";
        if (el.nodeType === Node.TEXT_NODE) return el.textContent.trim();
        return Array.from(el.childNodes).map(walk).join(" ");
      };
      return walk(document.body).replace(/\s+/g, " ").trim().slice(0, 6000);
    },
  });

  const pageText = res.result;
  if (!pageText) return "Page has no readable content.";

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 512,
      messages: [{
        role: "user",
        content: userQuery
        ? `Using only the following web page content, answer this question: "${userQuery}"\n\nPage content:\n${pageText}`
        : `Summarise the following web page content in 3-5 concise bullet points:\n\n${pageText}`,
      }],
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error?.message || `API error ${response.status}`);
  }

  const data = await response.json();
  return data.content?.[0]?.text?.trim() || "Could not summarise.";
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
    sendResponse({ ok: true, app: dag.graph.application_name, nodes: dag.nodes.length, edges: dag.links.length });
    return true;
  }

  if (msg.type === "RELOAD_DAG") {
    // Popup wrote DAG directly to storage; just reload indices from there
    loadDagFromStorage().then(() => {
      if (!dag) { sendResponse({ ok: false }); return; }
      sendResponse({ ok: true, app: dag.graph.application_name, nodes: dag.nodes.length, edges: dag.links.length });
    });
    return true;
  }

  if (msg.type === "GET_DAG_INFO") {
    if (!dag) { sendResponse(null); return; }
    sendResponse({ loaded: true, app: dag.graph.application_name, nodes: dag.nodes.length, edges: dag.links.length });
    return true;
  }

  if (msg.type === "GET_CURRENT_NODE") {
    const node = findNodeForUrl(msg.url);
    sendResponse({ node });
    return true;
  }

  if (msg.type === "QUERY") {
    handleQuery(msg, sender, sendResponse);
    return true;
  }

  if (msg.type === "EXECUTION_RESULT") {
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

  // Get API key
  const stored = await chrome.storage.local.get("cadence_api_key");
  const apiKey = stored.cadence_api_key;
  if (!apiKey) {
    sendResponse({ error: "No API key set. Click the gear icon to add your Anthropic API key." });
    return;
  }

  // Summarisation shortcut — return summary directly in one response
  if (SUMMARISE_PATTERNS.test(query)) {
    try {
      const summary = await summarisePage(tabId, apiKey, query);
      queryCache.set(cacheKey, { answer: summary });
      sendResponse({ answer: summary });
    } catch (err) {
      sendResponse({ error: `Summarisation failed: ${err.message}` });
    }
    return;
  }

  // Resolve path via Claude
  let path;
  try {
    path = await resolvePathWithAI(query, startNode.id, apiKey);
  } catch (err) {
    sendResponse({ error: `AI error: ${err.message}` });
    return;
  }

  if (!path || path.length === 0) {
    // No navigation path — try answering from the current page content
    try {
      const answer = await summarisePage(tabId, apiKey, query);
      queryCache.set(cacheKey, { answer });
      sendResponse({ answer });
    } catch (err) {
      sendResponse({ error: `Could not find a path and page query failed: ${err.message}` });
    }
    return;
  }

  const steps = path.map(e => e.ui_label);
  const lastEdge = path[path.length - 1];
  const apiCall = getReplayableApiCall(lastEdge);
  const mode = apiCall ? "api" : "click";

  sendResponse({ plan: { description: `Executing: ${steps.join(" → ")}`, steps } });

  executeplan(tabId, path, mode, cacheKey, query, apiKey);
}

// ------------------------------------------------------------------
// Execution
// ------------------------------------------------------------------
async function executeplan(tabId, path, mode, cacheKey, originalQuery, apiKey) {
  const lastEdge = path[path.length - 1];

  try {
    for (let i = 0; i < path.length; i++) {
      const edge = path[i];
      const isLast = i === path.length - 1;

      chrome.runtime.sendMessage({ type: "STEP_PROGRESS", step: i });

      if (isLast && mode === "api") {
        const apiCall = getReplayableApiCall(edge);
        if (apiCall) {
          const result = await replayApiCall(tabId, apiCall, edge);
          if (result) {
            queryCache.set(cacheKey, { answer: result });
            chrome.runtime.sendMessage({ type: "STEP_DONE", result });
            return;
          }
          // null means non-JSON response — fall through to DOM summarisation
        }
      }

      await chrome.scripting.executeScript({
        target: { tabId },
        func: clickElement,
        args: [edge.locator],
      });

      await sleep(1500);
    }

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
      // Auto-summarise the destination page
      try {
        const summary = await summarisePage(tabId, apiKey, originalQuery);
        queryCache.set(cacheKey, { answer: summary });
        chrome.runtime.sendMessage({ type: "STEP_DONE", result: summary });
      } catch {
        const result = "Reached the target page.";
        queryCache.set(cacheKey, { answer: result });
        chrome.runtime.sendMessage({ type: "STEP_DONE", result });
      }
    }

  } catch (err) {
    chrome.runtime.sendMessage({ type: "STEP_ERROR", error: err.message || "Execution failed." });
  }
}

async function replayApiCall(tabId, apiCall, edge) {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    func: async (url) => {
      try {
        const r = await fetch(url, { credentials: "include" });
        const ct = r.headers.get("content-type") || "";
        if (!ct.includes("json")) return null; // signal: not JSON, use DOM fallback
        const json = await r.json();
        return JSON.stringify(json, null, 2);
      } catch {
        return null;
      }
    },
    args: [apiCall.url_pattern],
  });
  return res.result || null; // null triggers DOM summarisation fallback
}

function formatExtracted(data) {
  if (!data) return "No data extracted.";
  return Object.entries(data).map(([k, v]) => `<strong>${k}</strong>: ${v}`).join("<br>");
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function clickElement(locator) {
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
  if (locator.css) {
    const el = document.querySelector(locator.css);
    if (el) { el.click(); return { ok: true, method: "css" }; }
  }
  throw new Error(`Could not find element: "${locator.visible_text_match || locator.css}"`);
}

function extractData(selectors) {
  const result = {};
  for (const [key, selector] of Object.entries(selectors)) {
    const el = document.querySelector(selector);
    result[key] = el ? (el.innerText || el.textContent || "").trim() : "not found";
  }
  return result;
}
