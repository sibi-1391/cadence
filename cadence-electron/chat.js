const messagesEl  = document.getElementById('messages');
const queryInput  = document.getElementById('queryInput');
const btnSend     = document.getElementById('btnSend');
const btnImport   = document.getElementById('btnImport');
const dagInfo     = document.getElementById('dagInfo');
const urlBar      = document.getElementById('urlBar');
const btnGo       = document.getElementById('btnGo');
const btnGear     = document.getElementById('btnGear');
const settingsPanel = document.getElementById('settingsPanel');
const apiKeyInput = document.getElementById('apiKeyInput');
const btnSaveKey  = document.getElementById('btnSaveKey');
const keyStatus   = document.getElementById('keyStatus');

// ------------------------------------------------------------------
// Init — load persisted state from main process
// ------------------------------------------------------------------
window.cadence.getState().then(state => {
  if (state.dagLoaded) setDagLoaded(state);
  if (state.currentUrl) urlBar.value = state.currentUrl;
  if (state.apiKeySet) {
    keyStatus.textContent = '● set';
    keyStatus.className = 'key-status set';
  } else {
    keyStatus.textContent = '● not set';
    keyStatus.className = 'key-status unset';
  }
});

// ------------------------------------------------------------------
// Settings — API key
// ------------------------------------------------------------------
btnGear.addEventListener('click', () => settingsPanel.classList.toggle('open'));

btnSaveKey.addEventListener('click', async () => {
  const key = apiKeyInput.value.trim();
  if (!key) return;
  await window.cadence.setApiKey(key);
  apiKeyInput.value = '';
  apiKeyInput.placeholder = 'sk-ant-... (saved)';
  keyStatus.textContent = '● set';
  keyStatus.className = 'key-status set';
  settingsPanel.classList.remove('open');
  addMessage('agent', 'API key saved.');
});

// ------------------------------------------------------------------
// DAG import — opens native file picker (main process reads the file)
// ------------------------------------------------------------------
btnImport.addEventListener('click', async () => {
  const res = await window.cadence.openDagFile();
  if (!res.ok) {
    if (res.error) addMessage('agent', `Failed to load DAG: ${res.error}`, true);
    return;
  }
  setDagLoaded(res);
  addMessage('agent', `DAG loaded: <strong>${res.app}</strong> — ${res.nodes} nodes, ${res.edges} edges.`);
});

function setDagLoaded(info) {
  dagInfo.innerHTML = `DAG: <span>${info.app || 'loaded'}</span> · ${info.nodes}n / ${info.edges}e`;
  queryInput.disabled = false;
  btnSend.disabled = false;
  queryInput.placeholder = 'Ask me to do something on this page...';
}

// ------------------------------------------------------------------
// Browser URL bar
// ------------------------------------------------------------------
btnGo.addEventListener('click', navigateTo);
urlBar.addEventListener('keydown', e => { if (e.key === 'Enter') navigateTo(); });

async function navigateTo() {
  let url = urlBar.value.trim();
  if (!url) return;
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  await window.cadence.navigate(url);
}

// Keep URL bar in sync with the browser window
window.cadence.onUrlChanged(url => {
  urlBar.value = url;
});

// ------------------------------------------------------------------
// Query submission
// ------------------------------------------------------------------
btnSend.addEventListener('click', submitQuery);
queryInput.addEventListener('keydown', e => { if (e.key === 'Enter') submitQuery(); });

async function submitQuery() {
  const query = queryInput.value.trim();
  if (!query) return;

  queryInput.value = '';
  setInputLocked(true);
  addMessage('user', query);

  const res = await window.cadence.query(query);
  setInputLocked(false);

  if (!res) { addMessage('agent', 'No response.', true); return; }
  if (res.error) { addMessage('agent', res.error, true); return; }

  if (res.cached) { addMessage('agent', `(cached) ${res.answer}`); return; }
  if (res.answer) { addMessage('agent', res.answer); return; }

  if (res.plan) {
    const container = addMessage('agent', res.plan.description);
    showSteps(container, res.plan.steps);
  }
}

function setInputLocked(locked) {
  queryInput.disabled = locked;
  btnSend.disabled = locked;
}

// ------------------------------------------------------------------
// Step progress display
// ------------------------------------------------------------------
function showSteps(containerEl, steps) {
  const stepsDiv = document.createElement('div');
  stepsDiv.className = 'steps';
  steps.forEach((s, i) => {
    const d = document.createElement('div');
    d.id = `step-${i}`;
    d.className = i === 0 ? 'active' : '';
    d.textContent = `${i + 1}. ${s}`;
    stepsDiv.appendChild(d);
  });
  containerEl.appendChild(stepsDiv);

  function cleanup() {
    window.cadence.onStepProgress(() => {});
    window.cadence.onStepDone(() => {});
    window.cadence.onStepError(() => {});
  }

  window.cadence.onStepProgress(({ step }) => {
    const prev = stepsDiv.querySelector('.active');
    if (prev) prev.className = 'done';
    const next = stepsDiv.querySelector(`#step-${step}`);
    if (next) next.className = 'active';
  });

  window.cadence.onStepDone(({ result }) => {
    stepsDiv.querySelectorAll('div').forEach(d => d.className = 'done');
    cleanup();
    if (result) addMessage('agent', result);
  });

  window.cadence.onStepError(({ error }) => {
    const active = stepsDiv.querySelector('.active');
    if (active) active.style.color = '#fc8181';
    cleanup();
    addMessage('agent', error, true);
  });
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------
function addMessage(role, html, isError = false) {
  const now = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const div = document.createElement('div');
  div.className = `msg ${role}${isError ? ' error' : ''}`;
  div.innerHTML = `<div class="bubble">${html}</div><span class="msg-time">${now}</span>`;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}
