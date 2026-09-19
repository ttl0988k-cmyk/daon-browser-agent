/**
 * DAON Browser Agent - Side Panel Controller
 * 로컬 DAON 백엔드(127.0.0.1:9090)와 통신하고, 크롬 탭 감지 및 조작을 수행합니다.
 */

const SERVER_BASE = 'http://127.0.0.1:9090';

// State
let currentSessionId = null;
let activeTab = null;
let allTabsList = [];
let autoContextEnabled = true; // 기본값: 자동 탭 및 컨텍스트 동기화
let attachedContext = null;
let isGenerating = false;
let currentEventSource = null;
let selectedModel = null;
let lastUserPrompt = '';
let currentActiveBubble = null;
let lastActionResults = [];
let currentApprovalPollTimer = null;
let currentGoal = null;
let currentAutonomousStep = 0;
const MAX_AUTONOMOUS_STEPS = 6;
let isAutoLooping = false;

// DOM Elements
const connectionBadge = document.getElementById('connectionBadge');
const statusDot = connectionBadge?.querySelector('.status-dot');
const statusText = connectionBadge?.querySelector('.status-text');
const clearChatBtn = document.getElementById('clearChatBtn');
const modelSelect = document.getElementById('modelSelect');
const agentProfileName = document.getElementById('agentProfileName');
const activeTabTitle = document.getElementById('activeTabTitle');
const tabsCountBadge = document.getElementById('tabsCountBadge');
const autoContextToggle = document.getElementById('autoContextToggle');
const autoContextLabel = document.getElementById('autoContextLabel');
const attachTabBtn = document.getElementById('attachTabBtn');
const attachedPill = document.getElementById('attachedPill');
const attachedPillText = document.getElementById('attachedPillText');
const removeAttachedBtn = document.getElementById('removeAttachedBtn');
const chatContainer = document.getElementById('chatContainer');
const welcomeCard = document.getElementById('welcomeCard');
const userInput = document.getElementById('userInput');
const sendBtn = document.getElementById('sendBtn');

// Quick Action Buttons
const quickListTabsBtn = document.getElementById('quickListTabsBtn');
const quickSummarizeBtn = document.getElementById('quickSummarizeBtn');
const quickFindBtn = document.getElementById('quickFindBtn');
const quickSnapshotBtn = document.getElementById('quickSnapshotBtn');

// ── 1. 초기화 & 헬스 체크 ───────────────────────────────────────────────────
async function init() {
  setupEventListeners();
  await loadAutoContextSetting();
  await loadAvailableModels();
  await loadActiveProfile();
  await loadSession();
  await updateActiveTabAndTabs();
  await checkServerHealth();
  await checkPendingApproval(chatContainer);

  // 10초마다 서버 헬스체크 및 탭 상태 최신화, 대기 중인 승인 요청 확인
  setInterval(async () => {
    await checkServerHealth();
    await updateActiveTabAndTabs();
    if (!isGenerating) {
      await checkPendingApproval(chatContainer);
    }
  }, 5000);
}

async function loadAutoContextSetting() {
  try {
    const stored = await chrome.storage.local.get(['daon_auto_context']);
    if (typeof stored.daon_auto_context === 'boolean') {
      autoContextEnabled = stored.daon_auto_context;
    }
  } catch (e) {
    autoContextEnabled = true;
  }
  updateAutoContextUI();
}

function updateAutoContextUI() {
  if (!autoContextToggle) return;
  if (autoContextEnabled) {
    autoContextToggle.className = 'attach-chip active';
    if (autoContextLabel) autoContextLabel.textContent = '자동 탭 감지 ON';
    autoContextToggle.title = '모든 탭과 현재 페이지 정보를 질문 시 자동으로 전달합니다 (클릭하여 끄기)';
  } else {
    autoContextToggle.className = 'attach-chip inactive';
    if (autoContextLabel) autoContextLabel.textContent = '자동 감지 OFF';
    autoContextToggle.title = '자동 감지가 꺼져 있습니다 (클릭하여 켜기)';
  }
}

async function checkServerHealth() {
  try {
    const res = await fetch(`${SERVER_BASE}/api/system/status`, {
      method: 'GET',
      headers: { 'Accept': 'application/json' }
    });
    if (res.ok) {
      setConnectionStatus(true, '연결됨: 9090');
    } else {
      setConnectionStatus(false, '오류');
    }
  } catch (err) {
    try {
      const res2 = await fetch(`${SERVER_BASE}/api/sessions`, { method: 'GET' });
      if (res2.ok) {
        setConnectionStatus(true, '연결됨: 9090');
        return;
      }
    } catch (e) {}
    setConnectionStatus(false, '다온 오프라인');
  }
}

function setConnectionStatus(isOnline, text) {
  if (!connectionBadge) return;
  connectionBadge.className = `status-badge ${isOnline ? 'online' : 'offline'}`;
  if (statusText) statusText.textContent = text;
}

// ── 2. 모델 & 에이전트 프로필 로드 ─────────────────────────────────────────
async function loadAvailableModels() {
  try {
    const res = await fetch(`${SERVER_BASE}/api/models`);
    if (!res.ok) return;
    const data = await res.json();
    const groups = data.groups || [];

    if (!modelSelect) return;
    modelSelect.innerHTML = '';
    let firstModelId = null;

    groups.forEach(group => {
      const chatModels = (group.models || []).filter(m => m.type === 'chat' || !m.type);
      if (chatModels.length === 0) return;

      const optgroup = document.createElement('optgroup');
      optgroup.label = group.provider || '기타';

      chatModels.forEach(m => {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = m.label || m.id;
        optgroup.appendChild(opt);
        if (!firstModelId) firstModelId = m.id;
      });

      modelSelect.appendChild(optgroup);
    });

    const stored = await chrome.storage.local.get(['daon_selected_model']);
    if (stored.daon_selected_model) {
      modelSelect.value = stored.daon_selected_model;
      selectedModel = stored.daon_selected_model;
    } else if (firstModelId) {
      modelSelect.value = firstModelId;
      selectedModel = firstModelId;
    }
  } catch (err) {
    console.warn('모델 목록 로드 실패:', err);
    if (modelSelect) modelSelect.innerHTML = '<option value="">기본 모델</option>';
  }
}

async function loadActiveProfile() {
  try {
    const res = await fetch(`${SERVER_BASE}/api/profile/active`);
    if (res.ok) {
      const data = await res.json();
      if (data.name && agentProfileName) {
        agentProfileName.textContent = data.name;
      }
    }
  } catch (e) {
    console.warn('프로필 로드 실패:', e);
  }
}

// ── 3. 세션 관리 ─────────────────────────────────────────────────────────
async function loadSession() {
  const stored = await chrome.storage.local.get(['daon_browser_session_id']);
  if (stored.daon_browser_session_id) {
    try {
      const res = await fetch(`${SERVER_BASE}/api/session?session_id=${encodeURIComponent(stored.daon_browser_session_id)}`);
      if (res.ok) {
        const data = await res.json();
        currentSessionId = stored.daon_browser_session_id;
        const messages = data.session?.messages || [];
        if (messages.length > 0) {
          renderRestoredMessages(messages);
        } else {
          clearChatUI();
        }
        return;
      }
    } catch (e) {
      console.warn('세션 유효성 확인 실패, 새 세션 생성 예정:', e);
    }
  }
  await createNewSession();
}

function renderRestoredMessages(messages) {
  chatContainer.innerHTML = '';
  for (const m of messages) {
    const role = m.role === 'assistant' ? 'bot' : (m.role === 'user' ? 'user' : null);
    if (!role) continue;
    let content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    // 시스템 안내 프롬프트 및 컨텍스트 제거하여 사용자 순수 메시지만 복원
    if (role === 'user') {
      if (content.includes('[연속 자율 실행 모드') || content.includes('연속 자율 진행 피드백')) {
        continue;
      }
      if (content.includes('[사용자 요청]')) {
        const parts = content.split('[사용자 요청]');
        content = parts[1].trim();
      }
      if (content.includes('[브라우저 제어')) {
        content = content.split('[브라우저 제어')[0].trim();
      }
      if (content.includes('(참고: 브라우저 조작')) {
        content = content.split('(참고: 브라우저 조작')[0].trim();
      }
    }
    appendMessage(role, content);
  }
  chatContainer.scrollTop = chatContainer.scrollHeight;
}

async function createNewSession() {
  try {
    const res = await fetch(`${SERVER_BASE}/api/session/new`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspace: 'C:\\daon',
        model: selectedModel || undefined
      })
    });
    if (res.ok) {
      const data = await res.json();
      currentSessionId = data.session.session_id;
      await chrome.storage.local.set({ daon_browser_session_id: currentSessionId });
      clearChatUI();
      console.log('[DAON Agent] 새 세션 생성 완료:', currentSessionId);
      return currentSessionId;
    }
  } catch (err) {
    console.error('서버 세션 생성 실패:', err);
  }
  currentSessionId = 'browser_' + Math.random().toString(36).substring(2, 10);
  await chrome.storage.local.set({ daon_browser_session_id: currentSessionId });
  clearChatUI();
  return currentSessionId;
}

function clearChatUI() {
  chatContainer.innerHTML = '';
  if (welcomeCard) chatContainer.appendChild(welcomeCard);
  attachedContext = null;
  updateAttachedPill();
}

// ── 4. 멀티탭 감지 및 활성 탭 추적 (Multi-Tab Sensor) ─────────────────────
async function updateActiveTabAndTabs() {
  try {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    allTabsList = tabs || [];
    activeTab = allTabsList.find(t => t.active) || allTabsList[0];

    if (activeTab && activeTabTitle) {
      activeTabTitle.textContent = activeTab.title || activeTab.url || '새 탭';
      activeTabTitle.title = activeTab.url || '';
    }

    if (tabsCountBadge) {
      tabsCountBadge.textContent = `${allTabsList.length}개 탭`;
      tabsCountBadge.title = `현재 창에 열려 있는 총 ${allTabsList.length}개의 탭 감지됨`;
    }
  } catch (e) {
    console.warn('탭 목록 및 활성 탭 갱신 실패:', e);
  }
}

// 탭 이벤트 리스너 등록
chrome.tabs.onActivated.addListener(() => updateActiveTabAndTabs());
chrome.tabs.onUpdated.addListener(() => updateActiveTabAndTabs());
chrome.tabs.onCreated.addListener(() => updateActiveTabAndTabs());
chrome.tabs.onRemoved.addListener(() => updateActiveTabAndTabs());

function formatTabsContext(tabs) {
  if (!tabs || tabs.length === 0) return '열려 있는 탭 정보를 가져올 수 없습니다.';
  return tabs.map(t => {
    const status = t.active ? '[★현재 활성 탭]' : '[열린 탭]';
    return `- [탭 ID: ${t.id}] ${status} #${t.index + 1}: "${t.title || '제목 없음'}" (${t.url || ''})`;
  }).join('\n');
}

/**
 * 조용하게(경고창 없이) 활성 탭의 DOM 컨텍스트를 추출
 */
async function extractTabContextSilently(tab = null) {
  const target = tab || activeTab;
  if (!target || !target.id) return null;

  // 특수 내부 URL 방어 (보안상 DOM 스크립트 실행 불가)
  if (target.url && (
    target.url.startsWith('chrome://') ||
    target.url.startsWith('edge://') ||
    target.url.startsWith('about:') ||
    target.url.startsWith('chrome-extension://')
  )) {
    return {
      title: target.title || '브라우저 시스템 페이지',
      url: target.url,
      bodyText: '(크롬 내부 시스템 페이지입니다 - 보안 정책상 DOM 스크립트 접근이 제한됩니다)',
      metaDesc: '',
      selectedText: '',
      interactive: { buttons: [], inputs: [] }
    };
  }

  try {
    const res = await chrome.tabs.sendMessage(target.id, { action: 'GET_PAGE_CONTEXT' }, { frameId: 0 });
    if (res && res.ok && res.data && res.data.url && res.data.url !== 'about:blank') {
      if (!res.data.title || res.data.title === 'about:blank') {
        res.data.title = target.title || res.data.title;
      }
      return res.data;
    }
  } catch (err) {
    // Content script가 아직 로드되지 않은 경우 무소음 동적 주입 시도
    try {
      // ── [2026-09-19 3차] ensureContentScript 로 통일 ──────────────────────
      // ⚠️ 종전에는 여기서 플래그 리셋 없이 그냥 executeScript 했다.
      //    확장 리로드 후에는 __daonContentScriptLoaded 가 isolated world 에 남아
      //    content.js 가 조용히 return → "주입했는데 여전히 응답 없음" → 아래 폴백으로
      //    떨어졌다. 즉 **매 턴 실행되는 자동 컨텍스트 수집이 조용히 열화**되고 있었다.
      //    (에이전트가 페이지 컨텍스트 없이 판단하게 되는 조용한 오작동)
      await ensureContentScript(target.id);
      const res2 = await chrome.tabs.sendMessage(target.id, { action: 'GET_PAGE_CONTEXT' }, { frameId: 0 });
      if (res2 && res2.ok && res2.data && res2.data.url && res2.data.url !== 'about:blank') {
        if (!res2.data.title || res2.data.title === 'about:blank') {
          res2.data.title = target.title || res2.data.title;
        }
        return res2.data;
      }
    } catch (e2) {
      // 주입 실패 시 직접 DOM 추출 폴백으로 진행
    }
  }

  // 폴백 2: chrome.scripting.executeScript로 직접 상위 DOM 컨텍스트 추출 (가장 확실한 안전장치)
  try {
    const directResults = await chrome.scripting.executeScript({
      target: { tabId: target.id },
      func: () => {
        const clone = document.body ? document.body.cloneNode(true) : null;
        if (clone) {
          clone.querySelectorAll('script, style, noscript, svg').forEach(n => n.remove());
        }
        const text = clone ? (clone.innerText || clone.textContent || '').replace(/\s+/g, ' ').trim() : '';
        const buttons = Array.from(document.querySelectorAll('button, a, [role="button"], input[type="submit"]'))
          .map(b => (b.innerText || b.value || b.getAttribute('aria-label') || '').trim())
          .filter(t => t.length > 0 && t.length < 30)
          .slice(0, 25);
        const inputs = Array.from(document.querySelectorAll('input:not([type="hidden"]), textarea, select'))
          .map(i => i.placeholder || i.name || i.id || i.getAttribute('aria-label') || '')
          .filter(t => t.length > 0 && t.length < 40)
          .slice(0, 25);
        return {
          title: document.title || '',
          url: window.location.href,
          bodyText: text.length > 6000 ? text.substring(0, 6000) + '... (이하 생략)' : text,
          metaDesc: document.querySelector('meta[name="description"]')?.getAttribute('content') || '',
          selectedText: window.getSelection()?.toString()?.trim() || '',
          interactive: { buttons, inputs }
        };
      }
    });
    if (directResults && directResults[0] && directResults[0].result && directResults[0].result.url !== 'about:blank') {
      const d = directResults[0].result;
      if (!d.title || d.title === 'about:blank') d.title = target.title || d.title;
      return d;
    }
  } catch (e3) {}

  return {
    title: target.title || '활성 탭',
    url: (target.url && target.url !== 'about:blank') ? target.url : '',
    bodyText: '(페이지 본문을 읽어오는 중이거나 권한 제한 페이지입니다)',
    metaDesc: '',
    selectedText: '',
    interactive: { buttons: [], inputs: [] }
  };
}

// ── 5. 브라우저 탐색 및 탭 조작 (Actuator: Navigation & Tabs) ────────────────
function normalizeUrl(rawUrl) {
  if (!rawUrl) return 'https://www.google.com';
  let url = rawUrl.trim();
  // 마크다운 링크 [링크](url) 제거
  const mdMatch = url.match(/\((https?:\/\/[^\s)]+)\)/);
  if (mdMatch) url = mdMatch[1];

  if (/^https?:\/\//i.test(url) || /^chrome:\/\//i.test(url) || /^about:/i.test(url)) {
    return url;
  }
  if (url.includes('.') && !url.includes(' ')) {
    return 'https://' + url;
  }
  return `https://www.google.com/search?q=${encodeURIComponent(url)}`;
}

function waitForTabLoad(tabId, timeoutMs = 6000) {
  if (!tabId) return Promise.resolve();
  return new Promise((resolve) => {
    let finished = false;
    const timer = setTimeout(() => {
      if (!finished) {
        finished = true;
        try { chrome.tabs.onUpdated.removeListener(onUpdate); } catch (_) {}
        resolve();
      }
    }, timeoutMs);

    function onUpdate(updatedId, info) {
      if (updatedId === tabId && info.status === 'complete') {
        if (!finished) {
          finished = true;
          clearTimeout(timer);
          try { chrome.tabs.onUpdated.removeListener(onUpdate); } catch (_) {}
          setTimeout(resolve, 800);
        }
      }
    }

    chrome.tabs.onUpdated.addListener(onUpdate);
  });
}

async function handleNavigate(url) {
  const targetUrl = normalizeUrl(url);
  await updateActiveTabAndTabs();
  let targetTabId = activeTab ? activeTab.id : null;
  if (targetTabId) {
    await chrome.tabs.update(targetTabId, { url: targetUrl, active: true });
    await waitForTabLoad(targetTabId, 6000);
  } else {
    const tab = await chrome.tabs.create({ url: targetUrl, active: true });
    targetTabId = tab.id;
    await waitForTabLoad(targetTabId, 6000);
  }
  await updateActiveTabAndTabs();
  return { ok: true, url: targetUrl };
}

async function handleNewTab(url) {
  const targetUrl = url ? normalizeUrl(url) : 'chrome://newtab/';
  const newTab = await chrome.tabs.create({ url: targetUrl, active: true });
  if (newTab && newTab.id && !targetUrl.startsWith('chrome://')) {
    await waitForTabLoad(newTab.id, 6000);
  }
  await updateActiveTabAndTabs();
  return { ok: true, url: targetUrl, tabId: newTab ? newTab.id : null };
}

async function handleSwitchTab(identifier) {
  await updateActiveTabAndTabs();
  if (!allTabsList || allTabsList.length === 0) return { ok: false, error: '열린 탭 없음' };

  let targetTab = null;
  const numId = parseInt(identifier);
  if (!isNaN(numId)) {
    targetTab = allTabsList.find(t => t.id === numId);
    if (!targetTab && numId > 0 && numId <= allTabsList.length) {
      targetTab = allTabsList[numId - 1];
    }
  }

  if (!targetTab && identifier) {
    const q = String(identifier).toLowerCase();
    targetTab = allTabsList.find(t =>
      (t.title && t.title.toLowerCase().includes(q)) ||
      (t.url && t.url.toLowerCase().includes(q))
    );
  }

  if (targetTab) {
    await chrome.tabs.update(targetTab.id, { active: true });
    await updateActiveTabAndTabs();
    // ── [2026-09-19 3차] 전환 직후 콘텐츠 스크립트 선제 보장 ──────────────────
    // 실측: SWITCH_TAB("284440455" → opencode.ai) 성공 → SNAPSHOT 즉시 실패
    //       (250ms 재시도까지 소진). 무거운 SPA 는 주입이 늦고, 확장 리로드 후
    //       백그라운드 탭은 orphaned 상태라 재시도로는 영영 복구되지 않는다.
    //       여기서 미리 재주입해 두면 후속 snapshot/click 이 첫 시도에 성공한다.
    try { await ensureContentScript(targetTab.id); } catch (_) {}
    return { ok: true, tab: targetTab };
  }
  return { ok: false, error: `일치하는 탭을 찾을 수 없습니다: "${identifier}"` };
}

async function handleCloseTab(identifier) {
  await updateActiveTabAndTabs();
  let targetTab = null;
  if (identifier) {
    const numId = parseInt(identifier);
    if (!isNaN(numId)) {
      targetTab = allTabsList.find(t => t.id === numId);
      if (!targetTab && numId > 0 && numId <= allTabsList.length) {
        targetTab = allTabsList[numId - 1];
      }
    }
    if (!targetTab) {
      const q = String(identifier).toLowerCase();
      targetTab = allTabsList.find(t =>
        (t.title && t.title.toLowerCase().includes(q)) ||
        (t.url && t.url.toLowerCase().includes(q))
      );
    }
  } else {
    targetTab = activeTab;
  }

  if (targetTab && targetTab.id) {
    await chrome.tabs.remove(targetTab.id);
    await updateActiveTabAndTabs();
    return { ok: true, tab: targetTab };
  }
  return { ok: false, error: `닫을 탭을 찾을 수 없습니다: "${identifier}"` };
}

// ── ★ [4차] 인터랙션 후 정착 대기 (jev 이식) ────────────────────────────────
// 원본 design.md: "The next observation waits for up to two animation frames
//   or 50 ms after an interaction."
//   종전 우리는 300ms 고정으로 기다렸다 → 원본 대비 6배 느림.
//   2 RAF 는 "다음 페인트 2회"를 기다리는 최소 단위라, 동적 DOM 갱신을
//   놓치지 않으면서 고정 지연을 줄인다. 실패하면 기존 백오프가 받쳐준다.
async function settle() {
  try {
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  } catch (e) {}
  await new Promise(r => setTimeout(r, 50));
}

// ── [2026-09-19 3차] content script 준비 보장 (자동 복구) ────────────────────
// 문제 2종:
//   ① 확장 리로드 후 기존 탭의 content script 는 orphaned(컨텍스트 무효화) 된다.
//      chrome.tabs.sendMessage 가 "Could not establish connection" 으로 실패하고,
//      이건 **영구 실패**다 — 재시도로는 절대 복구되지 않고 F5 만이 해결이었다.
//   ② 탭 전환 직후엔 아직 응답 준비 전이라 일시 실패한다(타이밍 경합).
// 해법: PING → 실패 시 재주입(플래그 리셋 포함) → PING 폴링.
//       성공 경로에서는 핑 1회만 지불하므로 지연이 사실상 0이다.
//    실측(2026-09-19, opencode.ai): SWITCH_TAB 성공 → SNAPSHOT 실패(250ms 재시도 포함).
//      opencode.ai 는 무거운 SPA 라 250ms 1회 재시도로는 부족했다.
async function ensureContentScript(tabId) {
  if (!tabId) return false;

  // 1) 살아있는지 가벼운 핑으로 확인
  try {
    const pong = await chrome.tabs.sendMessage(tabId, { action: 'PING' }, { frameId: 0 });
    if (pong && pong.ok) return true;
  } catch (_) { /* 죽었음 → 재주입으로 진행 */ }

  if (!chrome.scripting) return false;

  // 2) orphaned 플래그 리셋
  //    ⚠️ chrome.scripting.executeScript 는 content script 와 같은 isolated world 에서
  //       실행되므로, 여기서 리셋해야 content.js 의 중복 주입 가드가 통과한다.
  //       (리셋 없이는 재주입이 조용히 skip 되어 "주입했는데 응답 없음"이 된다)
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      func: () => { window.__daonContentScriptLoaded = false; }
    });
  } catch (_) {}

  // 3) content.js (+css) 재주입
  try {
    await chrome.scripting.insertCSS({ target: { tabId, allFrames: false }, files: ['content.css'] });
  } catch (_) {}
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      files: ['content.js']
    });
  } catch (e) {
    console.warn('[DAON Agent] content.js 재주입 실패:', e && e.message);
    return false;
  }

  // 4) 주입 직후 응답 준비 대기 — 짧은 폴링으로 재핑
  for (let i = 0; i < 4; i++) {
    await new Promise(r => setTimeout(r, 120));
    try {
      const pong = await chrome.tabs.sendMessage(tabId, { action: 'PING' }, { frameId: 0 });
      if (pong && pong.ok) return true;
    } catch (_) {}
  }
  return false;
}

async function executeBrowserAction(action, payload) {
  if (!activeTab || !activeTab.id) {
    await updateActiveTabAndTabs();
  }
  if (!activeTab || !activeTab.id) return { ok: false, error: '활성 탭 없음' };

  const tabId = activeTab.id;
  const send = () => chrome.tabs.sendMessage(tabId, { action, ...payload }, { frameId: 0 });

  try {
    // ⚠️ frameId: 0 지정하여 서브프레임(광고/트래커 등) 배제하고 메인 프레임에만 메시지 송신
    return await send();
  } catch (err) {
    // ⚠️ [2026-09-19 3차] 1차 실패 시 content script 자체를 보장한다.
    //    확장 리로드로 orphaned 된 경우엔 재시도만으로 영원히 실패하므로 재주입이 필수.
    await ensureContentScript(tabId);

    // 재주입/대기 후 백오프 재시도 (250 → 600 → 1200ms, 총 ~2초)
    const delays = [250, 600, 1200];
    for (const d of delays) {
      await new Promise(r => setTimeout(r, d));
      try {
        const retryRes = await send();
        if (retryRes && retryRes.ok !== false) return retryRes;
        // ok:false 응답이면 정상 응답이므로 그대로 반환(재시도 무의미)
        if (retryRes) return retryRes;
      } catch (_retryErr) {}
    }

    try {
      // 구형 환경 또는 예외 시 브로드캐스트 폴백
      const fallbackRes = await chrome.tabs.sendMessage(tabId, { action, ...payload });
      return fallbackRes;
    } catch (e2) {
      console.error('브라우저 액션 실행 오류:', err);
      return {
        ok: false,
        error: err.message,
        hint: '대상 탭에서 새로고침(F5) 후 다시 시도하세요.'
      };
    }
  }
}

// ── 6. 메시지 전송 & 실시간 자동 컨텍스트 결합 ──────────────────────────────
async function stopGeneration(isNewPrompt = false) {
  isAutoLooping = false;
  currentAutonomousStep = 0;
  currentGoal = null;

  if (currentEventSource) {
    try {
      currentEventSource.close();
    } catch (_) {}
    currentEventSource = null;
  }

  if (currentSessionId) {
    try {
      fetch(`${SERVER_BASE}/api/chat/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: currentSessionId })
      }).catch((e) => console.warn('[DAON Agent] cancel fetch error:', e));
    } catch (e) {}
  }

  if (currentActiveBubble) {
    const spinner = currentActiveBubble.querySelector('.action-spinner');
    if (spinner) spinner.remove();
    const hint = currentActiveBubble.querySelector('.reasoning-hint');
    if (hint) hint.remove();
    appendActionCard(currentActiveBubble, isNewPrompt ? '⏹️ [새 지시 수신] 이전 작업이 중단되었습니다.' : '⏹️ 작업이 중단되었습니다.');
  }

  isGenerating = false;
  currentActiveBubble = null;
  sendBtn.disabled = false;
}

async function sendMessage(customText = null, isAutoFollowup = false) {
  let text = '';
  if (!isAutoFollowup) {
    text = (customText !== null ? customText : userInput.value).trim();
    if (!text) {
      // 텍스트 없이 버튼 클릭 시 현재 생성 중이면 즉시 중단
      if (isGenerating) {
        await stopGeneration(false);
      }
      return;
    }
    // 새 사용자 요청 시작
    currentGoal = text;
    currentAutonomousStep = 1;
    isAutoLooping = true;
    lastUserPrompt = text;
  } else {
    // 자동 후속 턴
    text = currentGoal || lastUserPrompt || '이전 작업 연속 수행';
  }

  // ⚡ [진행 중인 작업 자동 중지 및 새 메시지 즉시 전송]
  if (isGenerating && !isAutoFollowup) {
    console.log('[DAON Agent] ⚡ 작업 진행 중 새 지시 수신 — 이전 작업 중지 및 새 메시지 즉시 전송');
    await stopGeneration(true);
  }

  if (welcomeCard && welcomeCard.parentNode) {
    welcomeCard.remove();
  }

  if (!isAutoFollowup) {
    // 사용자 말풍선 추가 (화면에는 사용자의 실제 질문만 표시)
    appendMessage('user', text);
    if (customText === null) {
      userInput.value = '';
      adjustTextareaHeight();
    }
  } else {
    // 연속 자율 진행 단계 표시용 뱃지 삽입
    const stepBadge = document.createElement('div');
    stepBadge.className = 'auto-step-indicator';
    stepBadge.innerHTML = `<span>🔄</span> <span>연속 작업 진행 중... (Step ${currentAutonomousStep}/${MAX_AUTONOMOUS_STEPS})</span>`;
    chatContainer.appendChild(stepBadge);
    chatContainer.scrollTop = chatContainer.scrollHeight;
  }

  // 컨텍스트 및 시스템 프롬프트 조합
  let fullPrompt = '';
  let contextHeader = '';

  if (autoContextEnabled) {
    // 자동 컨텍스트 수집: 전체 탭 목록 및 활성 탭 DOM 상태 실시간 수집
    await updateActiveTabAndTabs();
    const tabsSummary = formatTabsContext(allTabsList);
    const activeCtx = await extractTabContextSilently(activeTab);

    contextHeader = `[실시간 브라우저 환경 컨텍스트 (자동 수집)]\n`;
    contextHeader += `■ 현재 브라우저에 열려 있는 모든 탭 목록 (총 ${allTabsList.length}개):\n${tabsSummary}\n\n`;
    if (activeCtx) {
      const finalTitle = (activeCtx.title && activeCtx.title !== 'about:blank') ? activeCtx.title : (activeTab?.title || '활성 탭');
      const finalUrl = (activeCtx.url && activeCtx.url !== 'about:blank') ? activeCtx.url : (activeTab?.url || '');
      contextHeader += `■ 현재 활성 탭 상세 정보 (#${(activeTab?.index || 0) + 1}: "${finalTitle}"):\n`;
      contextHeader += `- URL: ${finalUrl}\n`;
      if (activeCtx.metaDesc) contextHeader += `- 요약: ${activeCtx.metaDesc}\n`;
      if (activeCtx.selectedText) contextHeader += `- 사용자가 마우스로 드래그(선택)한 텍스트:\n"""${activeCtx.selectedText}"""\n`;
      if (activeCtx.bodyText) contextHeader += `- 페이지 본문 핵심 내용:\n"""${activeCtx.bodyText}"""\n`;
      if (activeCtx.interactive?.buttons?.length > 0) contextHeader += `- 주요 버튼: ${activeCtx.interactive.buttons.join(', ')}\n`;
      if (activeCtx.interactive?.inputs?.length > 0) contextHeader += `- 주요 입력창: ${activeCtx.interactive.inputs.join(', ')}\n`;
    }
  } else if (attachedContext) {
    contextHeader = `[현재 웹 브라우저 탭 수동 첨부 컨텍스트]\n- 제목: ${attachedContext.title}\n- URL: ${attachedContext.url}\n${attachedContext.selectedText ? `- 선택된 텍스트: """${attachedContext.selectedText}"""\n` : ''}- 본문: """${attachedContext.bodyText}"""\n\n`;
    attachedContext = null;
    updateAttachedPill();
  }

  // 직전 액션 실행 결과 주입 (에이전트가 결과를 즉시 인지하도록 피드백 루프 완성)
  let actionResultHeader = '';
  if (lastActionResults && lastActionResults.length > 0) {
    actionResultHeader = `[직전 브라우저 액션 실행 결과 (성공 여부 피드백)]\n` +
      lastActionResults.map(r => `- ${r.summary}`).join('\n') + `\n\n`;
    lastActionResults = []; // 주입 후 비움
  }

  // 에이전트 브라우저 조작 및 실시간 시각 지침
  const systemGuide = `[구글 크롬 사이드패널 브라우저 조작 지침 — 필수 원칙]
1. [실시간 화면 직접 인지]: 당신은 현재 사용자의 실제 구글 크롬 브라우저를 실시간으로 직접 보고 있습니다! 위 [실시간 브라우저 환경 컨텍스트]에 현재 열린 탭 목록과 활성 탭(iframe 내부 포함)의 본문 텍스트, 제목, 버튼, 링크, 입력창 정보가 매 턴마다 최신 상태로 제공됩니다.
2. [직전 액션 결과 자동 인지]: 당신이 실행한 조작의 성공/실패 결과는 위 [직전 브라우저 액션 실행 결과]로 즉시 보고됩니다. 따라서 조작 후 사용자에게 "확인해주세요"라고 되묻지 마세요!
3. [브라우저 전용 액션 태그 사용 필수]: 데스크톱용 내부 브라우저 도구(browser_*)나 터미널/파이썬 스크립트 도구를 쓰지 마세요. 웹페이지 조작 및 입력은 오직 아래의 XML 액션 태그(<daon_action ... />)를 사용해야 실제 브라우저에서 즉각 실행됩니다.
4. [실시간 조작 액션 태그]: 브라우저 조작이 필요할 때는 반드시 아래의 XML 액션 태그를 응답에 포함하세요. 크롬 확장 프로그램이 실제 브라우저에서 즉시 실행합니다:
   - 버튼/카드/링크 클릭: <daon_action action="click" nodeId="12" />  ★권장  /  또는 <daon_action action="click" target="버튼텍스트 또는 CSS셀렉터" nth="1" />
   - 마우스 호버(드롭다운/메뉴 열기): <daon_action action="hover" nodeId="12" />  ★권장  /  또는 <daon_action action="hover" target="메뉴텍스트 또는 셀렉터" nth="1" />
   - 키보드 입력(Enter, Escape 등): <daon_action action="press" key="Enter" nodeId="3" />  ★권장  /  또는 <daon_action action="press" key="Enter" target="입력창(선택)" />
   - 대화형 요소 스냅샷 추출: <daon_action action="snapshot" />
   - 현재 화면 캡처(스크린샷): <daon_action action="screenshot" />
   - 잠시 대기(로딩 대기 등): <daon_action action="wait" ms="1500" />
   - 사이트 이동: <daon_action action="navigate" url="https://..." />
   - 새 탭 열기: <daon_action action="new_tab" url="https://..." />
   - 탭 전환: <daon_action action="switch_tab" tab_id="탭ID" />
   - 탭 닫기: <daon_action action="close_tab" tab_id="탭ID" />
   - 텍스트 입력: <daon_action action="type" nodeId="3" text="입력내용" />  ★권장  /  또는 <daon_action action="type" target="입력창ID/셀렉터" text="입력내용" nth="1" />
   - 스크롤: <daon_action action="scroll" direction="down|up" />
   - 드롭다운 선택(네이티브 select): <daon_action action="select" nodeId="7" value="Design" />  ★ 스냅샷에 →select="값" 이 보이면 그 값을 쓰세요.
   ⚠️ [요소 지정 규칙 — nodeId 우선 (필수)]:
   - 먼저 <daon_action action="snapshot" /> 로 스냅샷을 찍으면 각 요소에 nodeId가 함께 표시됩니다. 예: [#3|nodeId=7] <button> "검색"
   - 클릭/호버/입력은 반드시 그 nodeId로 지정하세요 (예: <daon_action action="click" nodeId="7" />). nodeId는 스냅샷 시점의 정확한 요소를 가리킵니다.
   - 스냅샷 이후 페이지가 바뀌면 실행이 자동으로 거부됩니다(엉뚱한 요소 조작 방지). 이때 [⚠️ 페이지 변경 감지] 안내가 오므로, 다시 스냅샷을 찍고 새 nodeId로 재시도하세요. 같은 nodeId로 반복 시도하지 마세요.
   - nodeId가 없는 요소에 한해서만 target=셀렉터를 사용하세요.
   - type/click/press가 "가려져 있습니다(covered)"로 거부되면 확장이 자동으로 오버레이(자동완성 드롭다운)를 걷어내고 1회 재판정합니다. 그래도 실패하면 다시 스냅샷을 찍으세요.
   ⚠️ [텍스트/프롬프트 입력 필수 규칙 — 구글 플로우/ChatGPT 등 봇 감지 회피]:
   - 단어, 문장, 검색어, 프롬프트 등 모든 텍스트는 반드시 단 1개의 <daon_action action="type" target="프롬프트창 또는 셀렉터" text="완전한 문자열" /> 태그로 입력하세요!
   - 확장 프로그램 시스템이 브라우저 내부에서 실제 사람처럼 한 글자씩 무작위 지연(25~65ms)을 주며 휴먼 리듬으로 자동 타이핑하므로, 봇 감지가 완벽히 회피됩니다.
   - 절대로 <daon_action action="press" key="...">와 wait로 글자를 하나씩 쪼개지 마세요! (press는 합성 키 이벤트라 실제 입력창에 글자가 써지지 않고 실패합니다.)
5. [연속 자율 실행 지원]: 사용자의 지시가 여러 단계(예: "네이버로 이동해서 AI뉴스 검색해봐")로 구성된 경우, 첫 번째 액션(<daon_action action="navigate" ... />)을 실행하면 브라우저가 이동한 뒤 변경된 새 화면 컨텍스트와 함께 다음 턴이 자동으로 이어집니다! 따라서 미래 화면의 요소를 미리 추측해서 누르려 하지 말고, [이동/클릭] → [새 화면 확인 후 후속 동작] 순서대로 자연스럽게 단계를 이어가세요. 모든 목표가 완료되면 액션 태그 없이 최종 요약 결과를 사용자에게 설명하고 마무리하세요.
6. [대화 태도]: 불필요한 사족 없이, 친절하고 명쾌하게 자신감 넘치는 어조로 행동하세요. (예: "네! 네이버로 이동해서 검색을 진행할게요. <daon_action action=\\"navigate\\" url=\\"https://www.naver.com\\" />")`;

  if (!isAutoFollowup) {
    if (contextHeader) {
      fullPrompt = `${contextHeader}\n${actionResultHeader}${systemGuide}\n\n[사용자 요청]\n${text}`;
    } else {
      fullPrompt = `${actionResultHeader}${systemGuide}\n\n[사용자 요청]\n${text}`;
    }
  } else {
    const followupInstruction = `[연속 자율 실행 모드 — Step ${currentAutonomousStep}/${MAX_AUTONOMOUS_STEPS}]\n` +
      `■ 사용자의 원래 요청: "${currentGoal}"\n` +
      `■ 직전 브라우저 액션이 실행 완료되어 화면이 갱신되었습니다.\n` +
      `■ 지침: 위 [실시간 브라우저 환경 컨텍스트]의 최신 화면(URL, 제목, 본문, 버튼, 입력창)을 확인하세요.\n` +
      `사용자의 원래 요청을 완수하기 위한 다음 단계 액션(<daon_action ... />)을 즉시 실행하세요. 만약 사용자의 요청(예: 검색 결과 확인/탐색 등)이 모두 완료되었다면, 추가 액션 태그 없이 사용자에게 최종 결과를 상세히 보고하세요.\n\n`;

    if (contextHeader) {
      fullPrompt = `${contextHeader}\n${actionResultHeader}${systemGuide}\n\n${followupInstruction}`;
    } else {
      fullPrompt = `${actionResultHeader}${systemGuide}\n\n${followupInstruction}`;
    }
  }

  // 에이전트 대기 말풍선 생성
  const botMessageEl = appendMessage('bot', '');
  const bubble = botMessageEl.querySelector('.bubble');
  bubble.innerHTML = '<div class="action-spinner"></div>';
  currentActiveBubble = bubble;

  isGenerating = true;
  sendBtn.disabled = false;

  try {
    if (!currentSessionId) {
      await createNewSession();
    }

    let startRes = await fetch(`${SERVER_BASE}/api/chat/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: currentSessionId,
        message: fullPrompt,
        model: selectedModel || undefined,
        planning_mode: false,
        surface: 'chrome_extension'
      })
    });

    if (startRes.status === 404) {
      console.warn('[DAON Agent] 세션 만료됨(404). 새 세션 생성 후 재시도...');
      await createNewSession();
      startRes = await fetch(`${SERVER_BASE}/api/chat/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: currentSessionId,
          message: fullPrompt,
          model: selectedModel || undefined,
          planning_mode: false,
          surface: 'chrome_extension'
        })
      });
    }

    if (!startRes.ok) {
      const errBody = await startRes.text().catch(() => '');
      throw new Error(`서버 응답 오류 (${startRes.status}) ${errBody}`);
    }

    const startData = await startRes.json();
    const streamId = startData.stream_id;
    bubble.innerHTML = '';

    listenToStream(streamId, bubble);

  } catch (err) {
    console.error('메시지 전송 실패:', err);
    bubble.innerHTML = `<span style="color:#f43f5e;">⚠️ 오류 발생: ${err.message}. 다온 앱(server.py)이 9090 포트에서 켜져 있는지 확인해 주세요.</span>`;
    finishGeneration();
  }
}

function listenToStream(streamId, bubble) {
  let accumulatedText = '';
  const sseUrl = `${SERVER_BASE}/api/chat/stream?stream_id=${streamId}`;
  currentEventSource = new EventSource(sseUrl);

  function handleToken(e) {
    try {
      const data = JSON.parse(e.data);
      const text = typeof data === 'string' ? data : (data.text || data.delta || '');
      accumulatedText += text;
      bubble.innerHTML = renderMarkdown(accumulatedText);
      chatContainer.scrollTop = chatContainer.scrollHeight;
    } catch (err) {
      accumulatedText += e.data;
      bubble.innerHTML = renderMarkdown(accumulatedText);
      chatContainer.scrollTop = chatContainer.scrollHeight;
    }
  }

  currentEventSource.addEventListener('token', handleToken);
  currentEventSource.addEventListener('chunk', handleToken);
  currentEventSource.onmessage = handleToken;

  currentEventSource.addEventListener('reasoning', (e) => {
    try {
      const data = JSON.parse(e.data);
      if (!bubble.querySelector('.reasoning-hint')) {
        const hint = document.createElement('div');
        hint.className = 'reasoning-hint';
        hint.style.fontSize = '11px';
        hint.style.color = '#94a3b8';
        hint.style.fontStyle = 'italic';
        hint.style.marginBottom = '6px';
        hint.textContent = '💭 생각하는 중...';
        bubble.prepend(hint);
      }
    } catch (err) {}
  });

  currentEventSource.addEventListener('notice', (e) => {
    try {
      const data = JSON.parse(e.data);
      appendActionCard(bubble, 'ℹ️ ' + (data.message || '알림'));
    } catch (err) {}
  });

  currentEventSource.addEventListener('tool', (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data.name && data.name !== '_thinking') {
        appendActionCard(bubble, `⚡ 도구 실행: ${data.name}`);
      }
    } catch (err) {}
  });

  currentEventSource.addEventListener('tool_call', (e) => {
    try {
      const data = JSON.parse(e.data);
      appendActionCard(bubble, `⚡ 도구 실행: ${data.name || '작업 중'}`);
    } catch (err) {}
  });

  // ── 승인 요청 (Approval) 이벤트 리스너 ──
  currentEventSource.addEventListener('approval', (e) => {
    try {
      const data = JSON.parse(e.data);
      renderApprovalCard(data, bubble);
    } catch (err) {
      console.warn('approval parse failed:', err);
    }
  });

  // 생성 중 1.5초 간격으로 백엔드 승인 대기 상태 폴링 (SSE 누락 대비)
  if (currentApprovalPollTimer) clearInterval(currentApprovalPollTimer);
  currentApprovalPollTimer = setInterval(async () => {
    if (!isGenerating) {
      clearInterval(currentApprovalPollTimer);
      currentApprovalPollTimer = null;
      return;
    }
    await checkPendingApproval(bubble);
  }, 1500);

  currentEventSource.addEventListener('done', async (e) => {
    const hint = bubble.querySelector('.reasoning-hint');
    if (hint) hint.remove();

    try {
      const data = JSON.parse(e.data);
      const msgs = data.session?.messages || [];
      const lastAsst = msgs.slice().reverse().find(m => m.role === 'assistant');
      if (lastAsst && (!accumulatedText || accumulatedText.trim() === '')) {
        accumulatedText = lastAsst.content || '';
        bubble.innerHTML = renderMarkdown(accumulatedText);
      }
    } catch (err) {
      console.warn('done 데이터 파싱 실패:', err);
    }

    finishGeneration();
    await parseAndExecuteActions(accumulatedText, bubble);
  });

  currentEventSource.addEventListener('error', (e) => {
    console.warn('SSE 스트림 종료 또는 에러:', e);
    const hint = bubble.querySelector('.reasoning-hint');
    if (hint) hint.remove();
    finishGeneration();
  });
}

function finishGeneration() {
  if (currentApprovalPollTimer) {
    clearInterval(currentApprovalPollTimer);
    currentApprovalPollTimer = null;
  }
  if (currentEventSource) {
    try {
      currentEventSource.close();
    } catch (_) {}
    currentEventSource = null;
  }
  isGenerating = false;
  currentActiveBubble = null;
  sendBtn.disabled = false;
  userInput.focus();
}

// ── 7. 에이전트 응답 내 브라우저 액션 태그 파싱 및 자동 실행 ───────────────
async function parseAndExecuteActions(text, bubble) {
  let executedAny = false;
  // 슬래시 유무 유연 매칭 (<daon_action ... /> 또는 <daon_action ...>)
  const regex = /<daon_action\s+([^>]+?)\/?>/gi;
  let match;

  while ((match = regex.exec(text)) !== null) {
    executedAny = true;
    const attrStr = match[1];
    // ⚠️ 2026-09-10 패치: 속성값에 반대 따옴표가 포함된 CSS 셀렉터(input[placeholder*='x'] 등)를
    // 온전히 파싱하도록 개선. 기존 [^"']+ 패턴은 값 내부의 반대 따옴표에서 조기 종료되어
    // target이 잘렸음 (예: "input[placeholder*=" 까지만 인식 → 입력 실패).
    const getAttr = (name) => {
      const dq = attrStr.match(new RegExp(`\\b${name}="([^"]*)"`, 'i'));
      if (dq) return dq[1];
      const sq = attrStr.match(new RegExp(`\\b${name}='([^']*)'`, 'i'));
      return sq ? sq[1] : null;
    };

    const action = (getAttr('action') || '').toLowerCase();
    const target = getAttr('target');
    const urlVal = getAttr('url');
    const tabIdVal = getAttr('tab_id');
    const inputVal = getAttr('text') || '';
    const dir = getAttr('direction') || 'down';

    const nth = parseInt(getAttr('nth') || '1', 10) || 1;
    const keyVal = getAttr('key') || 'Enter';
    const waitMs = parseInt(getAttr('ms') || '1000', 10) || 1000;
    // ★ nodeId: 스냅샷이 부여한 런타임 신원 (2026-09-19 jev guard 이식)
    //   스냅샷→실행 사이 DOM이 바뀌면 guard 검증에서 실행이 거부된다(엉뚱한 요소 조작 차단).
    //   nodeId가 있으면 target보다 우선한다.
    const rawNodeId = getAttr('nodeid') || getAttr('node_id');
    const nodeIdVal = (rawNodeId !== null && rawNodeId !== '' && !isNaN(Number(rawNodeId)))
      ? Number(rawNodeId) : null;

    // 1. 사이트 이동 (navigate / goto / open_url)
    if ((action === 'navigate' || action === 'goto' || action === 'open_url') && (urlVal || target)) {
      const toUrl = urlVal || target;
      const card = appendActionCard(bubble, `🌐 [사이트 이동] "${toUrl}" 로 이동 중...`);
      const res = await handleNavigate(toUrl);
      updateActionCard(card, res.ok ? `✅ 이동 완료: ${res.url}` : `❌ 이동 실패: ${res.error}`, !res.ok);
      lastActionResults.push({ summary: `NAVIGATE("${toUrl}"): ${res.ok ? '성공' : '실패'} (${res.ok ? res.url : res.error})` });
    }
    // 2. 새 탭 열기 (new_tab / open_tab)
    else if ((action === 'new_tab' || action === 'open_tab') && (urlVal || target)) {
      const toUrl = urlVal || target;
      const card = appendActionCard(bubble, `📑 [새 탭 열기] "${toUrl}" 여는 중...`);
      const res = await handleNewTab(toUrl);
      updateActionCard(card, res.ok ? `✅ 새 탭 생성 완료 (${res.url})` : `❌ 새 탭 열기 실패`, !res.ok);
      lastActionResults.push({ summary: `NEW_TAB("${toUrl}"): ${res.ok ? '성공' : '실패'}` });
    }
    // 3. 탭 전환 (switch_tab / select_tab)
    else if (action === 'switch_tab' || action === 'select_tab') {
      const ident = tabIdVal || target;
      const card = appendActionCard(bubble, `🔀 [탭 전환] "${ident}" 탭으로 전환 중...`);
      const res = await handleSwitchTab(ident);
      updateActionCard(card, res.ok ? `✅ "${res.tab.title}" 탭으로 전환 완료` : `❌ 전환 실패: ${res.error}`, !res.ok);
      lastActionResults.push({ summary: `SWITCH_TAB("${ident}"): ${res.ok ? '성공' : '실패'}` });
    }
    // 4. 탭 닫기 (close_tab / remove_tab)
    else if (action === 'close_tab' || action === 'remove_tab') {
      const ident = tabIdVal || target;
      const card = appendActionCard(bubble, `❌ [탭 닫기] "${ident || '현재 탭'}" 닫는 중...`);
      const res = await handleCloseTab(ident);
      updateActionCard(card, res.ok ? `✅ 탭 닫기 완료` : `❌ 닫기 실패: ${res.error}`, !res.ok);
      lastActionResults.push({ summary: `CLOSE_TAB("${ident || '현재 탭'}"): ${res.ok ? '성공' : '실패'}` });
    }
    // 5. 클릭 (click) — nodeId 우선, nth 다중 매칭 지원
    else if (action === 'click' && (target || nodeIdVal !== null)) {
      const label = nodeIdVal !== null ? `요소 #${nodeIdVal}` : `"${target}"`;
      const card = appendActionCard(bubble, `🖱️ [클릭] ${label}${nth > 1 ? ` (${nth}번째)` : ''} 시도 중...`);
      const res = await executeBrowserAction('ACT_CLICK',
        nodeIdVal !== null ? { nodeId: nodeIdVal } : { target, nth });
      updateActionCard(card, res.ok ? `✅ ${res.message}` : `❌ 클릭 실패: ${res.error}`, !res.ok);
      lastActionResults.push({
        summary: `CLICK(${label}${nth > 1 ? `, nth=${nth}` : ''}): ${res.ok ? '성공' : '실패'} — ${res.ok ? res.message : res.error}` +
          (res.stale ? ' [⚠️ 페이지 변경 감지 — 페이지가 바뀌었으니 다시 스냅샷을 찍고 새 nodeId로 재시도하세요]' : '')
      });
      if (res.ok) await settle();   // [4차] 300ms 고정 → 2 RAF or 50ms
    }
    // 6. 마우스 호버 (hover)
    else if (action === 'hover' && (target || nodeIdVal !== null)) {
      const label = nodeIdVal !== null ? `요소 #${nodeIdVal}` : `"${target}"`;
      const card = appendActionCard(bubble, `🔍 [호버] ${label}${nth > 1 ? ` (${nth}번째)` : ''} 마우스 호버 중...`);
      const res = await executeBrowserAction('ACT_HOVER',
        nodeIdVal !== null ? { nodeId: nodeIdVal } : { target, nth });
      updateActionCard(card, res.ok ? `✅ ${res.message}` : `❌ 호버 실패: ${res.error}`, !res.ok);
      lastActionResults.push({
        summary: `HOVER(${label}${nth > 1 ? `, nth=${nth}` : ''}): ${res.ok ? '성공' : '실패'} — ${res.ok ? res.message : res.error}` +
          (res.stale ? ' [⚠️ 페이지 변경 감지 — 다시 스냅샷을 찍고 새 nodeId로 재시도하세요]' : '')
      });
      if (res.ok) await settle();   // [4차] 200ms 고정 → 2 RAF or 50ms
    }
    // 7. 키보드 입력 (press / key)
    else if (action === 'press' || action === 'key') {
      const keyLabel = nodeIdVal !== null ? `요소 #${nodeIdVal}` : (target ? `"${target}"` : '현재 포커스');
      const card = appendActionCard(bubble, `⌨️ [키 입력] [${keyVal}] → ${keyLabel} 실행 중...`);
      const res = await executeBrowserAction('ACT_PRESS_KEY',
        nodeIdVal !== null ? { key: keyVal, nodeId: nodeIdVal } : { key: keyVal, target, nth });
      updateActionCard(card, res.ok ? `✅ ${res.message}` : `❌ 키 입력 실패: ${res.error}`, !res.ok);
      lastActionResults.push({
        summary: `PRESS_KEY("${keyVal}"${nodeIdVal !== null ? `, 요소 #${nodeIdVal}` : ''}): ${res.ok ? '성공' : '실패'} — ${res.ok ? res.message : res.error}` +
          (res.stale ? ' [⚠️ 페이지 변경 감지 — 다시 스냅샷을 찍고 새 nodeId로 재시도하세요]' : '')
      });
      if (res.ok) await settle();   // [4차] 300ms 고정 → 2 RAF or 50ms
    }
    // 8. 텍스트 입력 (type) — nodeId 우선
    else if (action === 'type' && (target || nodeIdVal !== null)) {
      const label = nodeIdVal !== null ? `요소 #${nodeIdVal}` : `"${target}"`;
      const card = appendActionCard(bubble, `⌨️ [입력] ${label}에 "${inputVal}" 입력 중...`);
      const res = await executeBrowserAction('ACT_TYPE',
        nodeIdVal !== null ? { nodeId: nodeIdVal, text: inputVal } : { target, text: inputVal, nth });
      updateActionCard(card, res.ok ? `✅ ${res.message}` : `❌ 입력 실패: ${res.error}`, !res.ok);
      lastActionResults.push({
        summary: `TYPE(${label}, "${inputVal}"): ${res.ok ? '성공' : '실패'} — ${res.ok ? res.message : res.error}` +
          (res.stale ? ' [⚠️ 페이지 변경 감지 — 다시 스냅샷을 찍고 새 nodeId로 재시도하세요]' : '')
      });
      if (res.ok) await settle();   // [4차] 300ms 고정 → 2 RAF or 50ms
    }
    // 8-b. 셀렉트 옵션 선택 (select) — 네이티브 <select> 전용 [4차 jev 이식]
    //   원본 browser.py L152~157: '관찰된 옵션'에서만 고르고 input+change 를 함께 디스패치.
    //   스냅샷이 노출한 selectValue 를 value 로 넘긴다.
    //   사용: <daon_action action="select" nodeId="7" value="Design" />
    else if (action === 'select' && (target || nodeIdVal !== null)) {
      const selVal = getAttr('value') || getAttr('select_value') || inputVal || '';
      const label = nodeIdVal !== null ? `요소 #${nodeIdVal}` : `"${target}"`;
      const card = appendActionCard(bubble, `📋 [선택] ${label} → "${selVal}" 선택 중...`);
      const res = await executeBrowserAction('ACT_SELECT',
        nodeIdVal !== null ? { nodeId: nodeIdVal, value: selVal } : { target, nth, value: selVal });
      updateActionCard(card, res.ok ? `✅ ${res.message}` : `❌ 선택 실패: ${res.error}`, !res.ok);
      lastActionResults.push({
        summary: `SELECT(${label}, "${selVal}"): ${res.ok ? '성공' : '실패'} — ${res.ok ? res.message : res.error}` +
          (res.stale ? ' [⚠️ 페이지 변경 감지 — 다시 스냅샷을 찍고 새 nodeId로 재시도하세요]' : '')
      });
      if (res.ok) await settle();
    }
    // 9. 잠시 대기 (wait) — 0.5초 이하는 카드를 띄우지 않고 조용히 대기 (화면 도배 방지)
    else if (action === 'wait') {
      if (waitMs > 500) {
        const card = appendActionCard(bubble, `⏳ [대기] ${(waitMs / 1000).toFixed(1)}초 대기 중...`);
        await new Promise(resolve => setTimeout(resolve, waitMs));
        updateActionCard(card, `✅ ${(waitMs / 1000).toFixed(1)}초 대기 완료`);
      } else {
        await new Promise(resolve => setTimeout(resolve, waitMs));
      }
      lastActionResults.push({ summary: `WAIT(${waitMs}ms): 완료` });
    }
    // 10. 스크린샷 캡처 (screenshot)
    else if (action === 'screenshot') {
      const card = appendActionCard(bubble, `📸 [스크린샷] 화면 캡처 중...`);
      try {
        const dataUrl = await new Promise((resolve, reject) => {
          chrome.tabs.captureVisibleTab(null, { format: 'png' }, (res) => {
            if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
            else resolve(res);
          });
        });
        if (dataUrl) {
          const img = document.createElement('img');
          img.src = dataUrl;
          img.style.maxWidth = '100%';
          img.style.borderRadius = '8px';
          img.style.marginTop = '8px';
          img.style.border = '1px solid rgba(255,255,255,0.1)';
          bubble.appendChild(img);
          updateActionCard(card, `✅ 스크린샷 캡처 완료`);
          lastActionResults.push({ summary: `SCREENSHOT(): 성공 (화면 캡처됨)` });
        }
      } catch (e) {
        updateActionCard(card, `❌ 스크린샷 실패: ${e.message}`, true);
        lastActionResults.push({ summary: `SCREENSHOT(): 실패 (${e.message})` });
      }
    }
    // 11. 대화형 요소 스냅샷 추출 (snapshot / elements)
    else if (action === 'snapshot' || action === 'elements') {
      const card = appendActionCard(bubble, `📸 [스냅샷] 대화형 요소 추출 중...`);
      const res = await executeBrowserAction('GET_PAGE_SNAPSHOT');
      if (res && res.ok && Array.isArray(res.data)) {
        // ★ nodeId를 함께 노출 — 클릭/입력 시 selector 재탐색 대신 nodeId로 지정하면
        //   스냅샷 시점과 동일한 요소가 보장되고, 페이지가 바뀌면 실행이 거부된다.
        const summary = res.data.slice(0, 30).map(it =>
          `[#${it.index}|nodeId=${it.nodeId}] <${it.role || it.tag}> "${it.text}"${it.value ? ` 값="${it.value}"` : ''}${it.selectValue ? ` →select="${it.selectValue}"` : ''} (${it.selector})`
        ).join('\n');
        updateActionCard(card, `✅ 스냅샷 완료 (총 ${res.data.length}개 요소 감지)`);
        lastActionResults.push({ summary: `SNAPSHOT(): 성공 (총 ${res.data.length}개 대화형 요소 감지됨):\n${summary}` });
      } else {
        updateActionCard(card, `❌ 스냅샷 실패: ${res?.error || '요소 추출 불가'}`, true);
        lastActionResults.push({ summary: `SNAPSHOT(): 실패` });
      }
    }
    // 12. 스크롤 (scroll)
    else if (action === 'scroll') {
      const card = appendActionCard(bubble, `📜 [스크롤] 화면 ${dir === 'down' ? '아래' : '위'}로 이동...`);
      await executeBrowserAction('ACT_SCROLL', { direction: dir });
      updateActionCard(card, `✅ 스크롤 완료 (${dir === 'down' ? '아래' : '위'})`);
      lastActionResults.push({ summary: `SCROLL("${dir}"): 완료` });
    }
  }

  // 스마트 내비게이션 폴백: 사용자가 이동을 요청했는데 에이전트가 태그 없이 URL만 언급한 경우
  // ⚠️ 2026-09-19 v1.1.4 — 안전장치 3종 (종전 조건이 헐거워 '시키지 않은 이동'이 가능했다)
  //   ① 자율 후속 턴에서는 폴백 금지 → 사용자가 직접 보낸 턴(currentAutonomousStep <= 1)에서만
  //   ② 현재 탭이 이미 같은 도메인이면 이동 금지 → 제자리 재이동·연쇄 이동 차단
  //   ③ 도메인 대조가 실패하면 아무것도 하지 않음(fail-closed) → 불확실하면 이동하지 않는다
  if (!executedAny && lastUserPrompt && currentAutonomousStep <= 1) {
    const navIntent = /이동|가줘|가자|열어|접속|틀어|navigate|go to|open/i.test(lastUserPrompt);
    if (navIntent) {
      const urlMatch = text.match(/https?:\/\/[^\s<>"')]+|\b(?:www\.)?[a-zA-Z0-9-]+\.(?:com|net|org|kr|co\.kr|io|dev|ai|app)\b/i);
      if (urlMatch) {
        const detectedUrl = urlMatch[0];
        // ② 현재 탭 도메인 실시간 대조 (이 시점에만 조회 — 평상 경로 비용 0)
        let sameSite = false;
        try {
          const [cur] = await chrome.tabs.query({ active: true, currentWindow: true });
          const curUrl = (cur && cur.url) || '';
          const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (_) { return ''; } };
          const a = hostOf(/^https?:\/\//i.test(detectedUrl) ? detectedUrl : 'https://' + detectedUrl);
          const b = hostOf(curUrl);
          sameSite = !!a && a === b;
        } catch (_) {}
        if (sameSite) {
          appendActionCard(bubble, `ℹ️ 이미 같은 사이트에 있습니다 — 중복 이동을 건너뜁니다. (${detectedUrl})`);
        } else {
          appendActionCard(bubble, `🌐 [스마트 이동 감지] 감지된 사이트 "${detectedUrl}" 로 이동합니다...`);
          const res = await handleNavigate(detectedUrl);
          appendActionCard(bubble, res.ok ? `✅ 이동 완료: ${res.url}` : `❌ 이동 실패: ${res.error}`);
          if (res.ok) executedAny = true;
        }
      }
    }
  }

  // ── 연속 자율 실행 피드백 루프 (Autonomous Multi-Step Loop) ──
  if (executedAny) {
    if (isAutoLooping && currentGoal && currentAutonomousStep < MAX_AUTONOMOUS_STEPS) {
      currentAutonomousStep++;
      appendActionCard(bubble, `🔄 [연속 자율 진행] 화면 갱신 후 다음 단계로 자동 연결합니다... (Step ${currentAutonomousStep}/${MAX_AUTONOMOUS_STEPS})`);
      setTimeout(async () => {
        if (!isAutoLooping) return;
        await triggerAutoFollowup();
      }, 1200);
    } else {
      if (currentAutonomousStep >= MAX_AUTONOMOUS_STEPS) {
        appendActionCard(bubble, `ℹ️ 연속 자율 작업 최대 횟수(${MAX_AUTONOMOUS_STEPS}회)에 도달하여 대기합니다.`);
      }
      isAutoLooping = false;
      currentAutonomousStep = 0;
      currentGoal = null;
    }
  } else {
    // 액션 태그가 없으면 작업이 완료되었거나 일반 설명 응답이므로 루프 종료
    isAutoLooping = false;
    currentAutonomousStep = 0;
    currentGoal = null;
  }
}

async function triggerAutoFollowup() {
  if (isGenerating || !isAutoLooping) return;
  await sendMessage(null, true);
}

// ── 8. UI 렌더링 헬퍼 ────────────────────────────────────────────────────
function appendMessage(role, text) {
  const row = document.createElement('div');
  row.className = `message-row ${role}`;

  if (role === 'bot') {
    const avatar = document.createElement('div');
    avatar.className = 'avatar bot';
    avatar.innerHTML = '🤖';
    row.appendChild(avatar);
  }

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.innerHTML = renderMarkdown(text);
  row.appendChild(bubble);

  chatContainer.appendChild(row);
  chatContainer.scrollTop = chatContainer.scrollHeight;
  return row;
}

function appendActionCard(bubbleEl, text) {
  const card = document.createElement('div');
  card.className = 'action-card';
  card.style.marginTop = '6px';
  card.textContent = text;
  bubbleEl.appendChild(card);
  chatContainer.scrollTop = chatContainer.scrollHeight;
  return card;
}

function updateActionCard(card, text, isError = false) {
  if (!card) return;
  card.textContent = text;
  if (isError) {
    card.style.background = 'rgba(239, 68, 68, 0.15)';
    card.style.borderColor = 'rgba(239, 68, 68, 0.4)';
    card.style.color = '#fca5a5';
  } else {
    card.style.background = 'rgba(16, 185, 129, 0.12)';
    card.style.borderColor = 'rgba(16, 185, 129, 0.35)';
    card.style.color = '#6ee7b7';
  }
  chatContainer.scrollTop = chatContainer.scrollHeight;
}

function renderMarkdown(str) {
  if (!str) return '';
  // 화면 표시 시 내부 XML 액션 태그(<daon_action ... />)는 깔끔하게 숨김 처리
  let clean = str.replace(/<daon_action\s+[^>]*\/?>/gi, '').replace(/<\/daon_action>/gi, '').trim();
  let html = clean
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // 코드 블록 (```code```)
  html = html.replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>');
  // 인라인 코드 (`code`)
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  // 볼드 (**text**)
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // 줄바꿈
  html = html.replace(/\n/g, '<br/>');

  return html;
}

function updateAttachedPill() {
  if (!attachedPill) return;
  if (attachedContext) {
    attachedPill.classList.remove('hidden');
    if (attachedPillText) attachedPillText.textContent = `📌 ${attachedContext.title.slice(0, 24)}...`;
  } else {
    attachedPill.classList.add('hidden');
  }
}

function adjustTextareaHeight() {
  userInput.style.height = 'auto';
  userInput.style.height = Math.min(userInput.scrollHeight, 120) + 'px';
}

// ── 9. 이벤트 리스너 바인딩 ──────────────────────────────────────────────
function setupEventListeners() {
  if (connectionBadge) connectionBadge.addEventListener('click', checkServerHealth);

  if (clearChatBtn) {
    clearChatBtn.addEventListener('click', async () => {
      if (confirm('대화 내용을 모두 지우고 새 작업을 시작할까요?')) {
        await createNewSession();
      }
    });
  }

  if (modelSelect) {
    modelSelect.addEventListener('change', async () => {
      selectedModel = modelSelect.value;
      await chrome.storage.local.set({ daon_selected_model: selectedModel });
      console.log('[DAON Agent] 모델 선택 변경:', selectedModel);
    });
  }

  // 자동 탭 감지 토글 버튼
  if (autoContextToggle) {
    autoContextToggle.addEventListener('click', async () => {
      autoContextEnabled = !autoContextEnabled;
      await chrome.storage.local.set({ daon_auto_context: autoContextEnabled });
      updateAutoContextUI();
    });
  }

  // 수동 탭 첨부 버튼 (기존 하위 호환)
  if (attachTabBtn) {
    attachTabBtn.addEventListener('click', async () => {
      const ctx = await extractTabContextSilently();
      if (ctx) {
        attachedContext = ctx;
        updateAttachedPill();
        userInput.focus();
      }
    });
  }

  if (removeAttachedBtn) {
    removeAttachedBtn.addEventListener('click', () => {
      attachedContext = null;
      updateAttachedPill();
    });
  }

  if (sendBtn) sendBtn.addEventListener('click', () => sendMessage());

  if (userInput) {
    userInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });
    userInput.addEventListener('input', adjustTextareaHeight);
  }

  // 퀵 액션 바
  if (quickListTabsBtn) {
    quickListTabsBtn.addEventListener('click', () => {
      sendMessage('현재 열려 있는 모든 브라우저 탭 목록을 확인해서 알려줘.');
    });
  }

  if (quickSummarizeBtn) {
    quickSummarizeBtn.addEventListener('click', () => {
      sendMessage('현재 활성화된 웹페이지의 핵심 내용을 3줄로 요약해줘.');
    });
  }

  if (quickFindBtn) {
    quickFindBtn.addEventListener('click', () => {
      sendMessage('이 페이지에서 가장 중요한 핵심 정보와 주요 링크들을 정리해줘.');
    });
  }

  if (quickSnapshotBtn) {
    quickSnapshotBtn.addEventListener('click', async () => {
      if (!activeTab || !activeTab.id) return;
      try {
        const res = await chrome.tabs.sendMessage(activeTab.id, { action: 'GET_PAGE_SNAPSHOT' }, { frameId: 0 });
        if (res && res.ok && res.data) {
          const list = res.data.map(i =>
            `[#${i.index}|nodeId=${i.nodeId}] <${i.role || i.tag}> "${i.text}"${i.value ? ` 값="${i.value}"` : ''} (셀렉터: ${i.selector})`
          ).join('\n');
          sendMessage(`이 페이지에서 발견된 대화형 요소 목록입니다:\n${list}\n\n이 중에서 어떤 동작을 수행할 수 있는지 추천해줘.`);
        }
      } catch (e) {
        sendMessage('현재 페이지의 주요 대화형 요소들을 분석해줘.');
      }
    });
  }

  // 예시 프롬프트 클릭
  if (chatContainer) {
    chatContainer.addEventListener('click', (e) => {
      const chip = e.target.closest('.example-chip');
      if (chip) {
        const prompt = chip.getAttribute('data-prompt');
        if (prompt) {
          userInput.value = prompt;
          sendMessage();
        }
      }
    });
  }
}

// ── 9. 승인 (Approval) 요청 확인 및 인터랙티브 카드 렌더링 ──────────────────
async function checkPendingApproval(container) {
  if (!currentSessionId) return;
  try {
    const res = await fetch(`${SERVER_BASE}/api/approval/pending?session_id=${encodeURIComponent(currentSessionId)}`);
    if (!res.ok) return;
    const json = await res.json();
    if (json && json.has_pending && json.pending) {
      renderApprovalCard(json.pending, container || currentActiveBubble || chatContainer);
    }
  } catch (e) {
    // 무소음 통과
  }
}

function renderApprovalCard(data, container) {
  if (!data) return;
  const targetContainer = container || currentActiveBubble || chatContainer;
  if (!targetContainer) return;

  const existingCard = document.getElementById('daonInlineApprovalCard');

  // 백엔드에서 45초 무응답 자동 승인된 경우 카드 갱신
  if (data.status === 'auto_approved') {
    if (existingCard) {
      existingCard.className = 'inline-approval-card resolved';
      existingCard.innerHTML = `
        <div class="approval-header">
          <span class="approval-icon">✅</span>
          <span class="approval-title">자동 승인됨</span>
        </div>
        <div class="approval-body" style="color:var(--accent-emerald);">
          ${escapeHtml(data.message || '45초 무응답으로 자동 승인되어 작업을 계속 진행합니다.')}
        </div>
      `;
      setTimeout(() => existingCard.remove(), 5000);
    }
    return;
  }

  // 이미 카드가 렌더링되어 있으면 중복 렌더링 방지
  if (existingCard) return;

  const isDangerous = data.type === 'dangerous_command' || !!data.command;
  const cmd = data.command || '';
  const desc = data.description || data.message || (isDangerous ? '명령 실행을 허용할까요?' : '작업 실행 승인이 필요합니다.');
  const previewId = data.preview_id || '';

  const card = document.createElement('div');
  card.className = 'inline-approval-card';
  card.id = 'daonInlineApprovalCard';

  let bodyHtml = `<div class="approval-body">${escapeHtml(desc)}</div>`;
  if (cmd) {
    bodyHtml += `<pre class="approval-command"><code>${escapeHtml(cmd)}</code></pre>`;
  }

  card.innerHTML = `
    <div class="approval-header">
      <span class="approval-icon">⚠️</span>
      <span class="approval-title">도구 실행 승인 요청</span>
    </div>
    ${bodyHtml}
    <div class="approval-actions">
      <button class="btn-approval approve" id="btnApproveAction">
        <span>승인 (계속 진행)</span>
      </button>
      <button class="btn-approval reject" id="btnRejectAction">
        <span>거부</span>
      </button>
    </div>
  `;

  const btnApprove = card.querySelector('#btnApproveAction');
  const btnReject = card.querySelector('#btnRejectAction');

  btnApprove.addEventListener('click', async () => {
    btnApprove.disabled = true;
    btnReject.disabled = true;
    btnApprove.textContent = '승인 처리 중...';
    try {
      if (isDangerous) {
        await fetch(`${SERVER_BASE}/api/approval/respond`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            session_id: currentSessionId,
            choice: 'once'
          })
        });
      } else {
        await fetch(`${SERVER_BASE}/api/approval/approve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            session_id: currentSessionId,
            preview_id: previewId
          })
        });
      }
      card.className = 'inline-approval-card resolved';
      card.innerHTML = `
        <div class="approval-header">
          <span class="approval-icon">✅</span>
          <span class="approval-title">승인 완료</span>
        </div>
        <div class="approval-body" style="color:var(--accent-emerald);">
          승인이 완료되었습니다. 에이전트가 다음 작업을 계속 진행합니다.
        </div>
      `;
      setTimeout(() => card.remove(), 6000);
    } catch (err) {
      console.error('승인 처리 실패:', err);
      btnApprove.disabled = false;
      btnReject.disabled = false;
      btnApprove.textContent = '다시 승인 시도';
    }
  });

  btnReject.addEventListener('click', async () => {
    btnApprove.disabled = true;
    btnReject.disabled = true;
    btnReject.textContent = '거부 처리 중...';
    try {
      if (isDangerous) {
        await fetch(`${SERVER_BASE}/api/approval/respond`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            session_id: currentSessionId,
            choice: 'deny'
          })
        });
      } else {
        await fetch(`${SERVER_BASE}/api/approval/reject`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            session_id: currentSessionId,
            preview_id: previewId
          })
        });
      }
      card.className = 'inline-approval-card rejected';
      card.innerHTML = `
        <div class="approval-header">
          <span class="approval-icon">❌</span>
          <span class="approval-title">작업 거부됨</span>
        </div>
        <div class="approval-body" style="color:var(--accent-rose);">
          도구 실행을 거부했습니다. 에이전트가 이를 인지하고 대안을 찾습니다.
        </div>
      `;
      setTimeout(() => card.remove(), 4000);
    } catch (err) {
      console.error('거부 처리 실패:', err);
      btnApprove.disabled = false;
      btnReject.disabled = false;
      btnReject.textContent = '다시 거부 시도';
    }
  });

  targetContainer.appendChild(card);
  chatContainer.scrollTop = chatContainer.scrollHeight;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// 실행
document.addEventListener('DOMContentLoaded', init);
