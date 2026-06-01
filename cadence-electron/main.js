const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

// ------------------------------------------------------------------
// Persistence paths (survive app restarts)
// ------------------------------------------------------------------
const DAG_PATH = path.join(app.getPath('userData'), 'cadence_dag.json');
const KEY_PATH = path.join(app.getPath('userData'), 'cadence_api_key.txt');

// ------------------------------------------------------------------
// Runtime state
// ------------------------------------------------------------------
let chatWin = null;
let browserWin = null;

let dag = null;
let adjacency = {};  // node_id -> [{ edge, target_id }]
let nodeIndex = {};  // node_id -> node
let linkIndex = {};  // interaction_id -> link

// LRU query cache (Map preserves insertion order)
const queryCache = new Map();
const CACHE_MAX = 50;
function cacheSet(key, val) {
  if (queryCache.has(key)) queryCache.delete(key);
  if (queryCache.size >= CACHE_MAX) queryCache.delete(queryCache.keys().next().value);
  queryCache.set(key, val);
}

// ------------------------------------------------------------------
// DAG persistence
// ------------------------------------------------------------------
function loadDagFromDisk() {
  try {
    if (fs.existsSync(DAG_PATH)) {
      dag = JSON.parse(fs.readFileSync(DAG_PATH, 'utf8'));
      buildIndices();
      console.log(`[CADENCE] DAG loaded from disk — ${dag.nodes.length} nodes`);
    }
  } catch (e) {
    console.error('[CADENCE] Failed to load DAG:', e.message);
  }
}

function saveDagToDisk() {
  try {
    fs.writeFileSync(DAG_PATH, JSON.stringify(dag), 'utf8');
  } catch (e) {
    console.error('[CADENCE] Failed to save DAG:', e.message);
  }
}

function buildIndices() {
  adjacency = {}; nodeIndex = {}; linkIndex = {};
  if (!dag) return;
  dag.nodes.forEach(n => { nodeIndex[n.id] = n; adjacency[n.id] = []; });
  dag.links.forEach(link => {
    linkIndex[link.interaction_id] = link;
    if (!adjacency[link.source]) adjacency[link.source] = [];
    adjacency[link.source].push({ edge: link, target_id: link.target });
  });
}

function findNodeForUrl(url) {
  if (!dag) return null;
  try {
    const pathname = new URL(url).pathname;
    return dag.nodes.find(n => n.url_pattern && new RegExp(n.url_pattern).test(pathname)) || null;
  } catch { return null; }
}

// ------------------------------------------------------------------
// API key persistence
// ------------------------------------------------------------------
function loadApiKey() {
  try {
    if (fs.existsSync(KEY_PATH)) return fs.readFileSync(KEY_PATH, 'utf8').trim();
  } catch {}
  return null;
}

function saveApiKey(key) {
  fs.writeFileSync(KEY_PATH, key, 'utf8');
}

// ------------------------------------------------------------------
// Claude API
// ------------------------------------------------------------------
async function callClaude(apiKey, messages, maxTokens = 256) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: maxTokens, messages }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `API error ${res.status}`);
  }
  const data = await res.json();
  return data.content?.[0]?.text?.trim() || '';
}

function getAllReachableEdges(startNodeId) {
  const visited = new Set();
  const queue = [startNodeId];
  const edges = [];
  while (queue.length) {
    const nodeId = queue.shift();
    if (visited.has(nodeId)) continue;
    visited.add(nodeId);
    for (const { edge, target_id } of (adjacency[nodeId] || [])) {
      const src = nodeIndex[nodeId];
      const tgt = nodeIndex[target_id];
      edges.push({
        interaction_id: edge.interaction_id,
        ui_label: edge.ui_label,
        source_label: src ? src.label : nodeId,
        target_label: tgt ? tgt.label : target_id,
        source_id: nodeId,
        target_id,
        locator: edge.locator,
      });
      if (!visited.has(target_id)) queue.push(target_id);
    }
  }
  return edges;
}

async function resolvePathWithAI(query, startNodeId, apiKey) {
  const reachableEdges = getAllReachableEdges(startNodeId);
  if (!reachableEdges.length) return null;

  const edgeList = reachableEdges
    .map(e => `[${e.interaction_id}] "${e.ui_label}"  (${e.source_label} -> ${e.target_label})`)
    .join('\n');
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

  let text = await callClaude(apiKey, [{ role: 'user', content: prompt }]);
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

  try {
    const ids = JSON.parse(text);
    if (!Array.isArray(ids) || ids.length === 0) return null;
    // Resolve interaction_ids to full edge objects (which include locator)
    const resolved = ids.map(id => {
      const edge = linkIndex[id];
      if (!edge) return null;
      const rich = reachableEdges.find(e => e.interaction_id === id);
      return rich ? { ...edge, locator: rich.locator } : edge;
    }).filter(Boolean);
    return resolved.length ? resolved : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------
// Browser window helpers
// ------------------------------------------------------------------
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function waitForNavigation(timeout = 5000) {
  return new Promise(resolve => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      browserWin.webContents.removeListener('did-finish-load', finish);
      browserWin.webContents.removeListener('did-navigate', finish);
      resolve();
    };
    browserWin.webContents.once('did-finish-load', finish);
    browserWin.webContents.once('did-navigate', finish);
    setTimeout(finish, timeout);
  });
}

async function getPageText() {
  return browserWin.webContents.executeJavaScript(`
    (function() {
      const skip = new Set(['SCRIPT','STYLE','NOSCRIPT','HEADER','FOOTER','NAV']);
      function walk(el) {
        if (!el) return '';
        if (skip.has(el.tagName)) return '';
        if (el.nodeType === Node.TEXT_NODE) return el.textContent.trim();
        return Array.from(el.childNodes).map(walk).join(' ');
      }
      return walk(document.body).replace(/\\s+/g, ' ').trim().slice(0, 6000);
    })()
  `);
}

async function clickElementInBrowser(locator) {
  return browserWin.webContents.executeJavaScript(`
    (function() {
      var locator = ${JSON.stringify(locator)};
      if (locator && locator.visible_text_match) {
        var all = document.querySelectorAll("button, a, [role='button'], input[type='submit']");
        for (var i = 0; i < all.length; i++) {
          var el = all[i];
          var text = (el.textContent || el.value || el.getAttribute('aria-label') || '').trim();
          if (text.toLowerCase().includes(locator.visible_text_match.toLowerCase())) {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            el.click();
            return { ok: true, method: 'text', matched: text };
          }
        }
      }
      if (locator && locator.css) {
        var el = document.querySelector(locator.css);
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          el.click();
          return { ok: true, method: 'css' };
        }
      }
      return { ok: false, error: 'Element not found: ' + (locator ? locator.visible_text_match || locator.css : 'null') };
    })()
  `);
}

async function summarisePage(apiKey, userQuery = null) {
  const pageText = await getPageText();
  if (!pageText) return 'Page has no readable content.';
  const content = userQuery
    ? `Using only the following web page content, answer this question: "${userQuery}"\n\nPage content:\n${pageText}`
    : `Summarise the following web page content in 3-5 concise bullet points:\n\n${pageText}`;
  return callClaude(apiKey, [{ role: 'user', content }], 512);
}

// ------------------------------------------------------------------
// Execute plan — walks the edge path, clicking live in browserWin
// ------------------------------------------------------------------
async function executePlan(navPath, apiKey, cacheKey, originalQuery) {
  try {
    for (let i = 0; i < navPath.length; i++) {
      const edge = navPath[i];
      chatWin.webContents.send('step-progress', { step: i });

      const result = await clickElementInBrowser(edge.locator);
      if (!result.ok) throw new Error(result.error);

      // Wait for navigation to settle (capped at 5s; SPA changes resolve instantly)
      await Promise.race([waitForNavigation(5000), sleep(1500)]);

      // Broadcast the new URL to the chat window's status bar
      chatWin.webContents.send('url-changed', browserWin.webContents.getURL());
    }

    // At destination — summarise the page using the original query as context
    const summary = await summarisePage(apiKey, originalQuery);
    cacheSet(cacheKey, summary);
    chatWin.webContents.send('step-done', { result: summary });
  } catch (err) {
    chatWin.webContents.send('step-error', { error: err.message || 'Execution failed.' });
  }
}

// ------------------------------------------------------------------
// IPC handlers
// ------------------------------------------------------------------
const SUMMARISE_RE = /\b(summar|what does|what is|explain|overview|tell me about|describe)\b/i;

ipcMain.handle('get-state', () => ({
  dagLoaded: !!dag,
  app: dag?.graph?.application_name,
  nodes: dag?.nodes?.length,
  edges: dag?.links?.length,
  apiKeySet: !!loadApiKey(),
  currentUrl: browserWin?.webContents.getURL() || 'about:blank',
}));

ipcMain.handle('set-api-key', (_, key) => {
  saveApiKey(key.trim());
  return { ok: true };
});

// Renderer passes JSON text; main process parses and saves to disk.
ipcMain.handle('load-dag', (_, dagJson) => {
  try {
    dag = JSON.parse(dagJson);
    buildIndices();
    saveDagToDisk();
    // Navigate the browser to the DAG's base URL automatically
    if (dag.graph?.base_url) browserWin.loadURL(dag.graph.base_url);
    return { ok: true, app: dag.graph.application_name, nodes: dag.nodes.length, edges: dag.links.length };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Open native file picker from main process (avoids renderer security restrictions)
ipcMain.handle('open-dag-file', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(chatWin, {
    title: 'Open cadence_dag.json',
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile'],
  });
  if (canceled || !filePaths.length) return { ok: false };
  try {
    const dagJson = fs.readFileSync(filePaths[0], 'utf8');
    dag = JSON.parse(dagJson);
    buildIndices();
    saveDagToDisk();
    if (dag.graph?.base_url) browserWin.loadURL(dag.graph.base_url);
    return { ok: true, app: dag.graph.application_name, nodes: dag.nodes.length, edges: dag.links.length };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('navigate', (_, url) => {
  try {
    browserWin.loadURL(url);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('query', async (_, query) => {
  if (!dag) return { error: 'No DAG loaded. Import a cadence_dag.json first.' };

  const apiKey = loadApiKey();
  if (!apiKey) return { error: 'No API key set. Click ⚙ to add your Anthropic key.' };

  const cacheKey = query.toLowerCase().trim();
  if (queryCache.has(cacheKey)) return { cached: true, answer: queryCache.get(cacheKey) };

  const currentUrl = browserWin.webContents.getURL();
  const startNode = findNodeForUrl(currentUrl);
  if (!startNode) return { error: `Current page (${currentUrl}) not found in DAG. Navigate to ${dag.graph?.application_name || 'the app'} first.` };

  // Summarisation / Q&A shortcut — no navigation needed
  if (SUMMARISE_RE.test(query)) {
    try {
      const answer = await summarisePage(apiKey, query);
      cacheSet(cacheKey, answer);
      return { answer };
    } catch (err) {
      return { error: `Summarisation failed: ${err.message}` };
    }
  }

  // Resolve navigation path with Claude
  let navPath;
  try {
    navPath = await resolvePathWithAI(query, startNode.id, apiKey);
  } catch (err) {
    return { error: `AI error: ${err.message}` };
  }

  // No path found — try answering from current page content
  if (!navPath || navPath.length === 0) {
    try {
      const answer = await summarisePage(apiKey, query);
      cacheSet(cacheKey, answer);
      return { answer };
    } catch {
      return { error: `Could not find a navigation path for: "${query}"` };
    }
  }

  const steps = navPath.map(e => e.ui_label);

  // Fire-and-forget — progress events are pushed to the chat window via IPC
  executePlan(navPath, apiKey, cacheKey, query);

  return { plan: { description: `Executing: ${steps.join(' → ')}`, steps } };
});

// ------------------------------------------------------------------
// Window creation
// ------------------------------------------------------------------
function createWindows() {
  loadDagFromDisk();

  // Chat / control window
  chatWin = new BrowserWindow({
    width: 420,
    height: 700,
    resizable: false,
    title: 'CADENCE',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  chatWin.loadFile('chat.html');
  chatWin.setMenuBarVisibility(false);

  // Browser window — user sees live clicks here
  browserWin = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'CADENCE Browser',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  browserWin.setMenuBarVisibility(false);
  browserWin.loadURL('about:blank');

  // Push URL changes to the chat window's status bar
  const sendUrl = (_, url) => {
    if (chatWin && !chatWin.isDestroyed()) chatWin.webContents.send('url-changed', url);
  };
  browserWin.webContents.on('did-navigate', sendUrl);
  browserWin.webContents.on('did-navigate-in-page', sendUrl);

  // If user closes browser window, re-create it
  browserWin.on('closed', () => {
    browserWin = new BrowserWindow({ width: 1280, height: 800, title: 'CADENCE Browser',
      webPreferences: { nodeIntegration: false, contextIsolation: true } });
    browserWin.setMenuBarVisibility(false);
    browserWin.loadURL('about:blank');
    browserWin.webContents.on('did-navigate', sendUrl);
    browserWin.webContents.on('did-navigate-in-page', sendUrl);
  });
}

app.whenReady().then(createWindows);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindows(); });
