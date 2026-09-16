/**
 * DAON Browser Agent - Content Script
 * 웹페이지 내부에서 실행되며 DOM 정보를 수집하고(Sensor) 마우스/키보드 액션을 대행합니다(Actuator).
 */

(function () {
  // 특수 내부 프레임 방어 (about:blank 또는 data: iframe에서는 동작하지 않음)
  if (!window.location.href || window.location.href === 'about:blank' || window.location.href.startsWith('data:')) {
    return;
  }
  if (window.__daonContentScriptLoaded) return;
  window.__daonContentScriptLoaded = true;

  console.log('[DAON Agent] Content script active on:', window.location.href);

  let activeBadge = null;
  let activeHighlightEl = null;

  // ── 시각적 피드백 (하이라이트 및 가상 뱃지) ─────────────────────────────────
  function showFeedback(element, text = 'DAON 작업 중') {
    clearFeedback();
    if (!element) return;

    element.classList.add('daon-agent-highlight');
    activeHighlightEl = element;

    const rect = element.getBoundingClientRect();
    const badge = document.createElement('div');
    badge.className = 'daon-agent-badge';
    badge.innerHTML = `<span style="font-size:12px;">🤖</span> <span>${text}</span>`;
    badge.style.left = `${window.scrollX + rect.left}px`;
    badge.style.top = `${window.scrollY + rect.top}px`;

    document.body.appendChild(badge);
    activeBadge = badge;

    setTimeout(clearFeedback, 2500);
  }

  function clearFeedback() {
    if (activeHighlightEl) {
      activeHighlightEl.classList.remove('daon-agent-highlight');
      activeHighlightEl = null;
    }
    if (activeBadge && activeBadge.parentNode) {
      activeBadge.parentNode.removeChild(activeBadge);
      activeBadge = null;
    }
  }

  // ── 요소 가시성(Visibility) 정밀 판별 ──────────────────────────────────────
  // 네이버 GNB 등 숨겨진 인풋(#gnb_svc_search_input) 오인 타겟팅 방어
  function isElementVisible(el) {
    if (!el) return false;
    try {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
        return false;
      }
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        return true;
      }
      return el.getClientRects().length > 0;
    } catch (e) {
      return false;
    }
  }

  // ── 검색 가능한 도큐먼트 수집 (메인 프레임 + 동일 출처 iframe/프레임 탐색) ────
  function getSearchableDocuments() {
    const docs = [document];
    try {
      const iframes = Array.from(document.querySelectorAll('iframe, frame'));
      for (const f of iframes) {
        try {
          const doc = f.contentDocument || f.contentWindow?.document;
          if (doc && doc.body) {
            docs.push(doc);
          }
        } catch (e) {
          // 크로스 오리진 iframe은 보안상 직접 접근 불가 (manifest all_frames 로 보완)
        }
      }
    } catch (e) {}
    return docs;
  }

  // ── 요소 탐색 헬퍼 (CSS 셀렉터 + 시맨틱 검색창/버튼 확장 + 가시성 우선 정렬) ──
  function findElement(query, nth = 1, options = {}) {
    if (!query) return null;
    query = String(query).trim();
    nth = Math.max(1, parseInt(nth) || 1);
    const { isInput = false, isClick = false } = options;

    const docs = getSearchableDocuments();
    const matches = [];

    function addMatch(el) {
      if (el && !matches.includes(el)) {
        matches.push(el);
      }
    }

    const lowerQuery = query.toLowerCase();

    // 0. 시맨틱 검색 및 프롬프트/AI 채팅 의도 감지 ('프롬프트', 'prompt', '검색', 'flow', 'chat' 등)
    const isSearchIntent = /검색|search|query|nx_query/i.test(query);
    const isPromptIntent = /프롬프트|prompt|flow|chat|대화|입력창|ask|describe|생성/i.test(query) ||
                           /div\[contenteditable/i.test(query) ||
                           /\[contenteditable/i.test(query);
    const isGenericInputIntent = /^input(\[type=['"]?text['"]?\])?$/i.test(query.replace(/\s+/g, ''));

    // 0-A. 입력 필드 탐색 시(isInput = true) 프롬프트창/검색창 및 텍스트 인풋 우선 탐색
    if (isInput && (isSearchIntent || isPromptIntent || isGenericInputIntent)) {
      const searchInputSelectors = [
        // Google Flow / AI Canvas / ChatGPT / Claude 특화 프롬프트 입력창 우선 탐색
        'textarea[placeholder*="prompt" i]',
        'textarea[placeholder*="Ask" i]',
        'textarea[placeholder*="Describe" i]',
        'textarea[placeholder*="입력" i]',
        '[contenteditable="true"][data-placeholder]',
        '[contenteditable="true"][role="textbox"]',
        '[contenteditable="true"][aria-label*="prompt" i]',
        '[contenteditable="true"][aria-label*="입력" i]',
        'div.ProseMirror',
        '[contenteditable="true"].ProseMirror',
        'div[data-slate-editor="true"]',
        'div[contenteditable="true"]',
        '[contenteditable="true"]',
        '[role="textbox"]',
        '#query',                      // 네이버 메인 검색창
        '#nx_query',                   // 네이버 통합검색 결과창
        'input[name="query"]',         // 네이버/다음 검색창
        'input[name="q"]',             // 구글/유튜브/깃허브 검색창
        'textarea[name="q"]',          // 최신 구글 검색창 (textarea)
        'input[type="search"]',        // HTML5 표준 검색창
        'input.search_input',          // 네이버 검색창 클래스
        'input[placeholder*="검색" i]', // 네이버 '검색어를 입력해 주세요.'
        'input[title*="검색" i]',       // 네이버 '검색어 입력'
        'input[aria-label*="검색" i]',
        'input[placeholder*="Search" i]',
        'input[aria-label*="Search" i]',
        'input[type="text"]',
        'input:not([type="hidden"]):not([type="button"]):not([type="submit"]):not([type="checkbox"]):not([type="radio"]):not([type="file"])',
        'textarea'
      ];

      for (const doc of docs) {
        for (const sel of searchInputSelectors) {
          try {
            const els = Array.from(doc.querySelectorAll(sel));
            for (const el of els) {
              // ⚠️ 화면에 실제로 보이는 활성 입력창만 추가 (최소 너비 40px, 높이 18px 이상)
              if (isElementVisible(el) && !el.disabled) {
                const rect = el.getBoundingClientRect();
                if (rect.width >= 40 && rect.height >= 18) {
                  addMatch(el);
                }
              }
            }
          } catch (e) {}
        }
      }

      if (matches.length > 0) {
        return matches[nth - 1] || matches[0];
      }
    }

    // 0-B. 클릭 액션 시(isClick = true) '검색'/'search' 관련 버튼 우선 탐색
    if (isClick && isSearchIntent) {
      const searchButtonSelectors = [
        '#search-btn',                   // 네이버 검색 버튼
        'button.btn_search',             // 네이버/다음 검색 버튼 클래스
        'button[type="submit"]',         // 폼 제출 검색 버튼
        'input[type="submit"]',          // 구형 폼 제출 버튼
        'button[aria-label*="검색" i]',
        'button[title*="검색" i]',
        'button[aria-label*="Search" i]',
        'button[title*="Search" i]',
        '[role="button"][aria-label*="검색" i]'
      ];

      for (const doc of docs) {
        for (const sel of searchButtonSelectors) {
          try {
            const els = Array.from(doc.querySelectorAll(sel));
            for (const el of els) {
              if (isElementVisible(el) && !el.disabled) {
                addMatch(el);
              }
            }
          } catch (e) {}
        }
      }

      if (matches.length > 0) {
        return matches[nth - 1] || matches[0];
      }
    }

    // 0-C. 클릭 액션 시(isClick = true) '생성'/'전송'/'제출'/'화살표' 버튼 우선 탐색 (Google Flow, ChatGPT, Claude 등)
    const isGenerateIntent = /생성|generate|create|전송|send|submit|화살표|arrow|run|run_btn/i.test(query);
    if (isClick && (isGenerateIntent || isPromptIntent)) {
      const generateButtonSelectors = [
        'button[aria-label*="generate" i]',
        'button[aria-label*="생성" i]',
        'button[aria-label*="send" i]',
        'button[aria-label*="전송" i]',
        'button[aria-label*="submit" i]',
        'button[aria-label*="run" i]',
        'button[aria-label*="arrow" i]',
        'button[title*="generate" i]',
        'button[title*="생성" i]',
        'button[title*="send" i]',
        'button[title*="submit" i]',
        'button[type="submit"]',
        '[role="button"][aria-label*="generate" i]',
        '[role="button"][aria-label*="생성" i]',
        '[role="button"][aria-label*="send" i]',
        '[role="button"][aria-label*="전송" i]',
        'button.send-button',
        'button.generate-button'
      ];

      for (const doc of docs) {
        for (const sel of generateButtonSelectors) {
          try {
            const els = Array.from(doc.querySelectorAll(sel));
            for (let el of els) {
              if (isElementVisible(el) && !el.disabled) {
                addMatch(el);
              }
            }
          } catch (e) {}
        }
      }

      if (matches.length > 0) {
        return matches[nth - 1] || matches[0];
      }
    }

    // 1. 직접 CSS 셀렉터 시도 (input[type=text]인 경우 type=search 및 textarea도 함께 확장)
    let cssSelector = query;
    if (/input\[type=['"]?text['"]?\]/i.test(query)) {
      cssSelector = 'input[type="text"], input[type="search"], input:not([type]), textarea';
    }

    for (const doc of docs) {
      try {
        const els = Array.from(doc.querySelectorAll(cssSelector));
        for (const el of els) addMatch(el);
      } catch (e) {
        // 유효하지 않은 CSS 셀렉터 구문이면 후속 탐색으로 진행
      }
    }

    // 2. ID 시도 (# 접두사 유무 모두 허용)
    const cleanId = query.startsWith('#') ? query.slice(1) : query;
    for (const doc of docs) {
      const elId = doc.getElementById(cleanId);
      if (elId) addMatch(elId);
    }

    // 3. Name 속성 시도
    for (const doc of docs) {
      try {
        const elNames = Array.from(doc.querySelectorAll(`[name="${cleanId}"]`));
        for (const el of elNames) addMatch(el);
      } catch (e) {}
    }

    // 4. Placeholder, Aria-Label, Title 매칭 (부분 일치)
    for (const doc of docs) {
      try {
        const attrEls = Array.from(doc.querySelectorAll(
          `[placeholder*="${query}" i], [aria-label*="${query}" i], [title*="${query}" i]`
        ));
        for (const el of attrEls) addMatch(el);
      } catch (e) {}
    }

    // 5. 버튼/링크 텍스트 내용으로 탐색
    for (const doc of docs) {
      const candidates = Array.from(doc.querySelectorAll('button, a, input[type="button"], input[type="submit"], [role="button"]'));
      for (const c of candidates) {
        const text = (c.innerText || c.textContent || c.value || '').trim();
        if (text.toLowerCase().includes(lowerQuery)) {
          addMatch(c);
        }
      }
    }

    // 6. 일반 텍스트 매칭 (단말 노드 위주)
    for (const doc of docs) {
      const allTextEls = Array.from(doc.querySelectorAll('span, div, p, label, li, td, th, h1, h2, h3, h4, em, strong'));
      for (const c of allTextEls) {
        if (c.children.length === 0 && (c.textContent || '').trim().toLowerCase().includes(lowerQuery)) {
          addMatch(c);
        }
      }
    }

    // 7. 일반 input/textarea/contenteditable 폴백
    if (matches.length === 0 && (isInput || /\b(input|text|edit|창|field)\b/i.test(query))) {
      for (const doc of docs) {
        const inputs = Array.from(doc.querySelectorAll(
          'input:not([type="hidden"]):not([type="button"]):not([type="submit"]):not([type="checkbox"]):not([type="radio"]):not([type="file"]):not([type="image"]), textarea, [contenteditable="true"], [role="textbox"]'
        ));
        for (const el of inputs) {
          if (isElementVisible(el)) {
            addMatch(el);
          }
        }
      }
    }

    if (matches.length === 0) return null;

    // ⚠️ 핵심: 가시성(visible) 요소를 최우선으로 정렬
    // 숨겨진 GNB 검색창(#gnb_svc_search_input 등)보다 실제 화면의 검색창이 항상 먼저 선택됨
    if (matches.length > 1) {
      const visibleMatches = matches.filter(el => isElementVisible(el));
      if (visibleMatches.length > 0) {
        return visibleMatches[nth - 1] || visibleMatches[0];
      }
    }

    return matches[nth - 1] || matches[0];
  }

  // ── 브라우저 네이티브 + React/Vue/ProseMirror/ContentEditable 호환 타이핑 ──────────
  // ⚠️ 사람 타이핑 리듬: 한 글자씩 랜덤 지연 삽입 (Google Flow, ChatGPT 등 봇 감지 회피)
  // ⚠️ 가상 돔(React/ProseMirror/Slate) 상태 및 유효성 검사 완벽 동기화 (희미한 플레이스홀더 탈출 & 생성 버튼 활성화)
  async function simulateTyping(element, text) {
    if (!element) return false;

    const isInput = element instanceof HTMLInputElement;
    const isTextarea = element instanceof HTMLTextAreaElement;
    const isEditable = element.isContentEditable ||
                       element.getAttribute('contenteditable') === 'true' ||
                       element.getAttribute('contenteditable') === '' ||
                       element.getAttribute('role') === 'textbox';

    // 1. 화면 스크롤 및 요소 활성화
    try {
      element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch (e) {}

    // Google Flow / ProseMirror / Slate 등 리치 에디터 내부 편집 노드(<p>, span 등) 정밀 타겟팅
    let targetEl = element;
    if (isEditable) {
      const innerNode = element.querySelector('p, [data-slate-node="element"], [data-slate-node="text"], div[data-placeholder], span');
      if (innerNode && isElementVisible(innerNode)) {
        targetEl = innerNode;
      }
    }

    // 실제 사람 마우스 인터랙션 시뮬레이션 (에디터 내부 포커스 및 캐럿 활성화)
    const rect = targetEl.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(evtType => {
      try {
        targetEl.dispatchEvent(new MouseEvent(evtType, {
          bubbles: true,
          cancelable: true,
          clientX: cx,
          clientY: cy,
          view: window
        }));
      } catch (e) {}
    });

    if (typeof targetEl.focus === 'function') targetEl.focus();
    if (typeof element.focus === 'function') element.focus();

    // 2. Selection 초기화: 오직 해당 입력창/에디터 내부만 안전하게 잡도록 Range 설정 (전체 페이지 선택 방지)
    if (typeof element.select === 'function') {
      try { element.select(); } catch (e) {}
    } else if (isEditable) {
      try {
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(targetEl || element);
        sel.removeAllRanges();
        sel.addRange(range);
      } catch (e) {}
    }

    // 3. 1차 시도: 한 글자씩 인간 타이핑 리듬 입력 (beforeinput + execCommand)
    let typedNatively = true;
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      let ok = false;
      try {
        // A. W3C 표준 beforeinput 이벤트 디스패치 (ProseMirror/Slate 트랜잭션 트리거)
        targetEl.dispatchEvent(new InputEvent('beforeinput', {
          bubbles: true,
          cancelable: true,
          inputType: 'insertText',
          data: char
        }));

        // B. 브라우저 네이티브 텍스트 삽입 명령 실행
        ok = document.execCommand('insertText', false, char);
      } catch (e) {
        ok = false;
      }

      // C. React / Vue 상태 감지용 input 이벤트 디스패치
      try {
        targetEl.dispatchEvent(new InputEvent('input', {
          bubbles: true,
          cancelable: true,
          inputType: 'insertText',
          data: char
        }));
      } catch (e) {}

      if (!ok) {
        // 네이티브 insertText가 지원되지 않거나 거부된 경우 루프 중단 후 즉시 전용 폴백 가동
        typedNatively = false;
        break;
      }

      // 사람 타자 속도 리듬 (글자당 20ms~50ms 랜덤 딜레이, 공백/개행은 45ms~75ms)
      const delay = (char === ' ' || char === '\n')
        ? Math.floor(Math.random() * 30) + 45
        : Math.floor(Math.random() * 30) + 20;
      await new Promise(r => setTimeout(r, delay));
    }

    // 4. 2차 시도: execCommand 미지원 또는 에디터에 글자가 반영되지 않았을 때의 안전 폴백
    const getCurrentText = () => {
      if (isInput || isTextarea) return element.value || '';
      return (element.innerText || element.textContent || '').trim();
    };

    const isTextPresent = getCurrentText().includes(text.trim().slice(0, Math.min(12, text.trim().length)));

    if (!typedNatively || !isTextPresent) {
      if (isInput || isTextarea) {
        // HTMLInputElement / HTMLTextAreaElement 프로토타입 setter 호출
        try {
          const proto = isInput ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          if (setter) {
            setter.call(element, text);
          } else {
            element.value = text;
          }
        } catch (e) {
          element.value = text;
        }
      } else if (isEditable) {
        // ⚠️ 리치 에디터(Google Flow, ProseMirror, Slate, Lexical) 전용 무손실 폴백:
        // 절대 raw innerText를 대입하지 않고(가상 돔 파괴 방지), 전체 insertText 또는 ClipboardEvent(paste) 실행!
        let inserted = false;
        try {
          if (typeof element.focus === 'function') element.focus();
          const sel = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(targetEl || element);
          sel.removeAllRanges();
          sel.addRange(range);
          inserted = document.execCommand('insertText', false, text);
        } catch (e) {
          inserted = false;
        }

        if (!inserted || !getCurrentText().includes(text.trim().slice(0, 10))) {
          // DataTransfer 가상 클립보드 붙여넣기 (ProseMirror handlePaste 수신 및 내부 트랜잭션 유도)
          try {
            const dt = new DataTransfer();
            dt.setData('text/plain', text);
            const pasteEvt = new ClipboardEvent('paste', {
              clipboardData: dt,
              bubbles: true,
              cancelable: true
            });
            targetEl.dispatchEvent(pasteEvt) || element.dispatchEvent(pasteEvt);
          } catch (e) {}
        }

        // 최후의 수단: 내부 <p> 또는 텍스트 컨테이너에 안전하게 주입
        if (!getCurrentText().includes(text.trim().slice(0, 10))) {
          try {
            const p = element.querySelector('p') || element;
            p.textContent = text;
          } catch (e) {
            try { element.textContent = text; } catch (_) {}
          }
        }
      }
    }

    // 5. ⚠️ 핵심: React / ProseMirror / Flow 내부 상태 완벽 각성 (희미한 텍스트 -> 활성 텍스트 & 생성 버튼 활성화)
    const wakeupEvents = [
      new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }),
      new Event('input', { bubbles: true, cancelable: true }),
      new Event('change', { bubbles: true, cancelable: true }),
      new KeyboardEvent('keydown', { bubbles: true, key: 'Process', code: 'Process' }),
      new KeyboardEvent('keyup', { bubbles: true, key: 'Process', code: 'Process' }),
    ];
    wakeupEvents.forEach(evt => {
      try { targetEl.dispatchEvent(evt); } catch (e) {}
      try { element.dispatchEvent(evt); } catch (e) {}
    });

    // ⚠️ Blur -> Focus 사이클로 폼 검증기 및 생성(제출) 버튼 잠금 해제
    try {
      targetEl.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      targetEl.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
      await new Promise(r => setTimeout(r, 60));
      if (typeof element.focus === 'function') element.focus();
      targetEl.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    } catch (e) {}

    // 6. 결과 검증
    return getCurrentText().includes(text.trim().slice(0, Math.min(10, text.trim().length))) || typedNatively;
  }

  // ── 마우스 클릭 시뮬레이션 ───────────────────────────────────────────────
  function simulateClick(element) {
    element.scrollIntoView({ behavior: 'smooth', block: 'center' });

    const mouseEvents = ['mouseenter', 'mouseover', 'mousedown', 'mouseup', 'click'];
    const rect = element.getBoundingClientRect();
    const clientX = rect.left + rect.width / 2;
    const clientY = rect.top + rect.height / 2;

    mouseEvents.forEach(eventType => {
      const event = new MouseEvent(eventType, {
        view: window,
        bubbles: true,
        cancelable: true,
        clientX,
        clientY
      });
      element.dispatchEvent(event);
    });

    if (typeof element.focus === 'function') element.focus();
    if (typeof element.click === 'function') element.click();
  }

  // ── 마우스 호버(Hover) 시뮬레이션 ────────────────────────────────────────
  function simulateHover(element) {
    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const rect = element.getBoundingClientRect();
    const clientX = rect.left + rect.width / 2;
    const clientY = rect.top + rect.height / 2;

    const mouseEvents = ['mouseenter', 'mouseover', 'mousemove'];
    mouseEvents.forEach(eventType => {
      element.dispatchEvent(new MouseEvent(eventType, {
        view: window,
        bubbles: true,
        cancelable: true,
        clientX,
        clientY
      }));
    });
  }

  // ── 키보드 입력(Key Press) 시뮬레이션 ─────────────────────────────────────
  function simulateKeyPress(element, key = 'Enter') {
    const target = element || document.activeElement || document.body;
    if (typeof target.focus === 'function') target.focus();

    const isEnter = key.toLowerCase() === 'enter';
    const isSpace = key.toLowerCase() === 'space' || key === ' ';
    const isEscape = key.toLowerCase() === 'escape';
    const isTab = key.toLowerCase() === 'tab';
    const isBackspace = key.toLowerCase() === 'backspace';

    const keyCode = isEnter ? 13 : (isEscape ? 27 : (isTab ? 9 : (isSpace ? 32 : (isBackspace ? 8 : (key.charCodeAt(0) || 0)))));

    const keyEvents = ['keydown', 'keypress', 'keyup'];
    keyEvents.forEach(type => {
      target.dispatchEvent(new KeyboardEvent(type, {
        key: isSpace ? ' ' : key,
        code: isEnter ? 'Enter' : (isEscape ? 'Escape' : (isTab ? 'Tab' : (isSpace ? 'Space' : (isBackspace ? 'Backspace' : key)))),
        keyCode: keyCode,
        which: keyCode,
        bubbles: true,
        cancelable: true,
        view: window
      }));
    });

    // ⚠️ 단일 문자 또는 Space 키인 경우 실제 DOM에 텍스트가 삽입되도록 execCommand 보완
    // (브라우저는 보안상 합성 KeyboardEvent만으로는 DOM에 글자를 적지 않음)
    if (isSpace) {
      try { document.execCommand('insertText', false, ' '); } catch (e) {}
    } else if (key.length === 1 && !isEnter && !isEscape && !isTab) {
      try { document.execCommand('insertText', false, key); } catch (e) {}
    }

    if (isEnter) {
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
        const form = target.closest('form');
        if (form) {
          try {
            if (typeof form.requestSubmit === 'function') {
              form.requestSubmit();
            } else if (typeof form.submit === 'function') {
              form.submit();
            }
          } catch (e) {
            const submitBtn = form.querySelector('button[type="submit"], input[type="submit"], button#search-btn, button.btn_search');
            if (submitBtn) submitBtn.click();
          }
        } else {
          // form 외부 검색 버튼 폴백
          const searchBtn = document.querySelector('#search-btn, button[type="submit"], button.btn_search, [aria-label*="검색"]');
          if (searchBtn && searchBtn !== target) searchBtn.click();
        }
      }
    }
  }

  // ── 페이지 컨텍스트 추출 (Sensor — 메인 + iframe 통합) ───────────────────
  function extractPageContext() {
    const title = document.title || '';
    const url = window.location.href;
    const selection = window.getSelection()?.toString()?.trim() || '';

    // 메타 설명 태그
    const metaDesc = document.querySelector('meta[name="description"]')?.getAttribute('content') || '';

    const docs = getSearchableDocuments();
    let combinedText = '';
    const buttons = [];
    const inputs = [];

    for (const doc of docs) {
      if (!doc.body) continue;
      const clone = doc.body.cloneNode(true);
      const unwanted = clone.querySelectorAll('script, style, noscript, svg, nav, footer');
      unwanted.forEach(n => n.remove());

      let text = clone.innerText || clone.textContent || '';
      text = text.replace(/\s+/g, ' ').trim();
      if (text) {
        combinedText += (combinedText ? '\n\n' : '') + text;
      }

      // 주요 대화형 요소 수집 (보이는 요소 우선)
      Array.from(doc.querySelectorAll('button, [role="button"], input[type="submit"], a.btn, a[role="button"]'))
        .filter(b => isElementVisible(b))
        .map(b => (b.innerText || b.value || b.getAttribute('aria-label') || '').trim())
        .filter(t => t.length > 0 && t.length < 30)
        .forEach(t => { if (!buttons.includes(t)) buttons.push(t); });

      Array.from(doc.querySelectorAll('input:not([type="hidden"]), textarea, select'))
        .filter(i => isElementVisible(i))
        .map(i => i.placeholder || i.name || i.id || i.getAttribute('aria-label') || '')
        .filter(t => t.length > 0 && t.length < 40)
        .forEach(t => { if (!inputs.includes(t)) inputs.push(t); });
    }

    if (combinedText.length > 6000) {
      combinedText = combinedText.substring(0, 6000) + '... (이하 생략)';
    }

    return {
      title,
      url,
      metaDesc,
      selectedText: selection,
      bodyText: combinedText,
      interactive: {
        buttons: buttons.slice(0, 25),
        inputs: inputs.slice(0, 25)
      }
    };
  }

  // ── 대화형 요소 스냅샷 추출 (Agent Grounding — 메인 + iframe 통합) ────────
  function extractInteractiveSnapshot() {
    const docs = getSearchableDocuments();
    const items = [];
    let count = 0;

    for (const doc of docs) {
      if (count >= 50) break;
      const elements = Array.from(doc.querySelectorAll('a, button, input, select, textarea, [role="button"]'));
      for (const el of elements) {
        if (count >= 50) break;
        if (!isElementVisible(el)) continue;

        const tag = el.tagName.toLowerCase();
        const type = el.type || '';
        const text = (el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || '').trim();
        const id = el.id ? `#${el.id}` : '';
        const name = el.getAttribute('name') ? `[name="${el.getAttribute('name')}"]` : '';

        items.push({
          index: ++count,
          tag,
          type,
          text: text.slice(0, 40),
          selector: id || name || (el.className ? `.${el.className.split(' ')[0]}` : tag)
        });
      }
    }

    return items;
  }

  // ── 메시지 리스너 (사이드패널 ↔ 컨텐츠 스크립트) ─────────────────────────
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // ⚠️ 광고, 트래커 등 서브프레임이 메시지를 가로채서 조기 실패 응답을 보내는 현상 원천 차단
    // 브라우저 조작 액션은 반드시 메인 프레임(window.top)에서만 단독 처리
    if (window !== window.top) {
      return false;
    }

    try {
      switch (request.action) {
        case 'GET_PAGE_CONTEXT': {
          const ctx = extractPageContext();
          sendResponse({ ok: true, data: ctx });
          break;
        }

        case 'GET_PAGE_SNAPSHOT': {
          const snapshot = extractInteractiveSnapshot();
          sendResponse({ ok: true, data: snapshot });
          break;
        }

        case 'ACT_CLICK': {
          const el = findElement(request.target || request.selector, request.nth || 1, { isClick: true });
          if (!el) {
            sendResponse({ ok: false, error: `요소를 찾을 수 없습니다: "${request.target || request.selector}" (nth: ${request.nth || 1})` });
            return;
          }
          showFeedback(el, `클릭: ${request.target || '버튼'}`);
          simulateClick(el);
          sendResponse({
            ok: true,
            message: `클릭 완료: <${el.tagName.toLowerCase()}> "${(el.innerText || el.value || '').trim().slice(0, 30)}"`,
            url: window.location.href
          });
          break;
        }

        case 'ACT_HOVER': {
          const el = findElement(request.target || request.selector, request.nth || 1, { isClick: false });
          if (!el) {
            sendResponse({ ok: false, error: `요소를 찾을 수 없습니다: "${request.target || request.selector}" (nth: ${request.nth || 1})` });
            return;
          }
          showFeedback(el, `호버: ${request.target || '요소'}`);
          simulateHover(el);
          sendResponse({
            ok: true,
            message: `호버(Mouse Over) 완료: <${el.tagName.toLowerCase()}> "${(el.innerText || el.value || '').trim().slice(0, 30)}"`,
            url: window.location.href
          });
          break;
        }

        case 'ACT_PRESS_KEY': {
          const key = request.key || 'Enter';
          let el = request.target ? findElement(request.target, request.nth || 1, { isInput: true }) : null;
          if (el) {
            showFeedback(el, `키: ${key}`);
          }
          simulateKeyPress(el, key);
          sendResponse({
            ok: true,
            message: `키 입력 완료: [${key}]${el ? ` (대상: <${el.tagName.toLowerCase()}>)` : ''}`
          });
          break;
        }

        case 'ACT_TYPE': {
          (async () => {
            try {
              const el = findElement(request.target || request.selector, request.nth || 1, { isInput: true });
              if (!el) {
                sendResponse({ ok: false, error: `입력 필드를 찾을 수 없습니다: "${request.target || request.selector}"` });
                return;
              }
              const visible = isElementVisible(el);
              showFeedback(el, `입력: "${request.text}"`);
              const verified = await simulateTyping(el, request.text);
              const val = ('value' in el && typeof el.value === 'string')
                ? el.value
                : ((el.innerText || el.textContent || '').trim().slice(0, 50));
              sendResponse({
                ok: true,
                verified: verified && visible,
                value: val,
                message: `입력 완료: "${request.text}" (${visible ? '화면 표시 정상' : '경고: 숨겨진 요소에 입력됨'})`
              });
            } catch (err) {
              sendResponse({ ok: false, error: err.message });
            }
          })();
          break;
        }

        case 'ACT_SCROLL': {
          const direction = request.direction || 'down';
          const amount = request.amount || (window.innerHeight * 0.7);
          const top = direction === 'down' ? amount : (direction === 'up' ? -amount : 0);
          window.scrollBy({ top, behavior: 'smooth' });
          sendResponse({ ok: true, scrollY: window.scrollY });
          break;
        }

        default:
          sendResponse({ ok: false, error: `알 수 없는 액션: ${request.action}` });
      }
    } catch (err) {
      console.error('[DAON Agent Content Script Error]', err);
      sendResponse({ ok: false, error: err.message });
    }
    return true; // 비동기 응답 지원
  });

})();
