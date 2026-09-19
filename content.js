/**
 * DAON Browser Agent - Content Script
 * 웹페이지 내부에서 실행되며 DOM 정보를 수집하고(Sensor) 마우스/키보드 액션을 대행합니다(Actuator).
 */

(function () {
  // 특수 내부 프레임 방어 (about:blank 또는 data: iframe에서는 동작하지 않음)
  if (!window.location.href || window.location.href === 'about:blank' || window.location.href.startsWith('data:')) {
    return;
  }
  // ── [2026-09-19 3차] 중복 주입 가드 ───────────────────────────────────────
  // ⚠️ 함정: 확장을 리로드하면 기존 탭의 content script는 orphaned(컨텍스트 무효화)가
  //    되지만, 이 플래그는 isolated world에 그대로 남는다. 그 상태로
  //    chrome.scripting.executeScript 로 재주입하면 여기서 조용히 return 되어
  //    "주입했는데도 여전히 응답 없음"이 된다.
  //    → sidepanel 이 재주입 직전에 window.__daonContentScriptLoaded = false 로 리셋한다.
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
      // iframe 내부 요소는 그 프레임의 뷰로 계산해야 정확하다.
      // 메인 window.getComputedStyle(el) 은 다른 문서의 요소에 대해 신뢰할 수 없다.
      const win = (el.ownerDocument && el.ownerDocument.defaultView) || window;
      const style = win.getComputedStyle(el);
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

  // ══════════════════════════════════════════════════════════════════════════
  // 요소 레지스트리 + guard — jev-ultrafast 이식 (2026-09-19)
  // ──────────────────────────────────────────────────────────────────────────
  // 문제: 기존 실행 경로는 스냅샷의 selector 문자열로 요소를 '재탐색'했다.
  //       스냅샷 → 클릭 사이에 DOM이 바뀌면 같은 셀렉터가 다른 요소를 가리켜
  //       엉뚱한 클릭이 발생했다. (검증 단계 없음)
  // 해결: 스냅샷 시점에 노드 신원(WeakMap)과 의미(guard)를 보관하고,
  //       실행 직전에 재검증한다. 기하는 저장하지 않고 입력 직전 재해석 + hit-test.
  // ══════════════════════════════════════════════════════════════════════════
  const __daonReg = (window.__daonReg ||= {
    ids: new WeakMap(),     // el → nodeId
    nodes: new Map(),       // nodeId → el
    guards: new Map(),      // nodeId → guard 스냅샷
    next: 1
  });

  function regIdentity(el) {
    if (!__daonReg.ids.has(el)) __daonReg.ids.set(el, __daonReg.next++);
    const id = __daonReg.ids.get(el);
    __daonReg.nodes.set(id, el);
    return id;
  }

  // 끊긴 노드 정리 (누수 방지)
  function regPrune() {
    for (const [id, el] of __daonReg.nodes) {
      if (!el || !el.isConnected) {
        __daonReg.nodes.delete(id);
        __daonReg.guards.delete(id);
      }
    }
  }

  // ── [2026-09-19 4차] pageKey — 문서 전체 지문 (jev 이식) ────────────────────
  // 원본 snapshot.js L44~46:
  //   cache.pageKey=()=>[performance.timeOrigin,location.href,scrollX,scrollY,
  //     innerWidth,innerHeight,[...querySelectorAll('input,textarea,select')]
  //       .filter(safe).map(e=>[identity(e),e.value,e.checked,e.selectedIndex,e.disabled,e.readOnly])]
  //
  // 목적: guard 는 '그 요소'만 본다. 그래서 SPA 가 DOM 을 재사용한 채 라우팅만
  //       바꾸거나, 같은 폼의 다른 필드 값이 바뀐 경우를 못 잡는다.
  //       pageKey 는 문서 신원(URL/뷰포트/스크롤) + 모든 폼 값 상태를 담아
  //       그 구멍을 메운다. 원본 fresh() 는 [page_key, guard] 를 함께 비교한다
  //       (browser.py L88~98).
  //
  // ⚠️ 원본은 identity(e) 를 호출해 새 요소에 ID 를 '부여'한다. 그런데 pageKey 를
  //    실행 시점(fresh)에도 호출하므로 비교 중에 ID 가 늘어날 수 있다.
  //    우리는 실행 시점에는 ids.get(el) 로 '읽기만' 해서 이 비대칭을 제거한다.
  const PAGEKEY_FIELDS = ['timeOrigin', 'url', 'scrollX', 'scrollY', 'innerWidth', 'innerHeight', 'formState'];

  function pageKeyOf() {
    return [
      performance.timeOrigin,
      location.href,
      window.scrollX,
      window.scrollY,
      window.innerWidth,
      window.innerHeight,
      Array.from(document.querySelectorAll('input,textarea,select'))
        .filter(el => !['password', 'file', 'hidden'].includes(el.type))
        .map(el => [
          __daonReg.ids.get(el) ?? null,   // ★ 읽기 전용 (원본 identity() 부작용 제거)
          el.value, el.checked, el.selectedIndex, el.disabled, el.readOnly
        ])
    ];
  }

  // pageKey 비교 — 다르면 변경된 필드 이름 배열을 돌려준다(없으면 null)
  function pageKeyDiff(before, now) {
    if (!before || !now) return null;
    const len = Math.min(before.length, now.length);
    const changed = [];
    for (let i = 0; i < len; i++) {
      const a = typeof before[i] === 'object' ? JSON.stringify(before[i]) : String(before[i] ?? '');
      const b = typeof now[i] === 'object' ? JSON.stringify(now[i]) : String(now[i] ?? '');
      if (a !== b) changed.push(PAGEKEY_FIELDS[i] || `pk${i}`);
    }
    return changed.length ? changed : null;
  }

  // ── [4차] combobox 타이핑 후 제안 대기 (jev 이식) ───────────────────────────
  // 원본 design.md: "Editable ARIA comboboxes instead wait for visible options,
  //   capped at 200 ms. This avoids paying for a prediction before autocomplete
  //   suggestions arrive."
  //
  // 우리가 covered 자동 복구로 '사후' 우회하던 문제를 원본은 '예방'한다.
  // 자동완성 드롭다운이 뜨는 것을 기다려 준 뒤 다음 액션으로 넘어가면,
  // 오버레이가 입력창을 덮은 상태를 애초에 만들지 않는다.
  function isComboboxLike(el) {
    if (!el) return false;
    if (accRole(el) === 'combobox') return true;
    if (el.getAttribute('aria-controls')) return true;
    if (el.getAttribute('list')) return true;
    if (el.getAttribute('aria-autocomplete')) return true;
    return false;
  }

  async function waitForSuggestions(el, maxMs = 200) {
    if (!isComboboxLike(el)) return false;
    const t0 = Date.now();
    while (Date.now() - t0 < maxMs) {
      await sleep(25);
      try {
        // 제안 목록이 실제로 보이는가 (role=option / listbox / datalist / aria-expanded)
        const opts = document.querySelectorAll(
          '[role="option"],[role="listbox"] option,datalist option,[role="listbox"] [role="option"]');
        for (const o of opts) {
          if (isElementVisible(o)) return true;
        }
        if (el.getAttribute('aria-expanded') === 'true') return true;
      } catch (e) {}
    }
    return false;
  }

  // ── [4차] 인터랙션 후 정착 대기 (jev 이식) ─────────────────────────────────
  // 원본 design.md: "The next observation waits for up to two animation frames
  //   or 50 ms after an interaction."
  //   우리는 sidepanel 에서 300ms 고정으로 기다리고 있었다 → 6배 느림.
  async function settleAfterInteraction() {
    try {
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    } catch (e) {}
    await sleep(50);
  }

  // 접근성 이름 계산 — jev snapshot.js name() 이식
  function accName(el, seen = new Set()) {
    if (!el || seen.has(el)) return '';
    seen.add(el);
    const referenced = (el.getAttribute('aria-labelledby') || '')
      .split(/\s+/).map(id => accName(document.getElementById(id), seen))
      .filter(Boolean).join(' ');
    return referenced || el.getAttribute('aria-label') ||
      [...(el.labels || [])].map(l => accName(l, seen)).filter(Boolean).join(' ') ||
      (['button', 'submit', 'reset'].includes(el.type) ? el.value : '') ||
      el.getAttribute('alt') ||
      (el.tagName === 'INPUT' ? '' : [...el.childNodes].map(n =>
        n.nodeType === 3 ? n.textContent :
        (n.nodeType === 1 && n.getAttribute('aria-hidden') !== 'true') ? accName(n, seen) : ''
      ).join(' ').trim()) ||
      el.getAttribute('title') || el.getAttribute('placeholder') || '';
  }

  // 역할 판정 — jev snapshot.js role() 이식
  const ACC_ROLES = ['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem',
    'menuitemradio', 'option', 'gridcell', 'combobox', 'textbox', 'searchbox', 'spinbutton'];

  function accRole(el) {
    const explicit = el.getAttribute('role');
    if (ACC_ROLES.includes(explicit)) return explicit;
    if (el.tagName === 'BUTTON' || el.tagName === 'SUMMARY') return 'button';
    if (el.tagName === 'A') return 'link';
    if (el.tagName === 'SELECT') return 'combobox';
    if (el.tagName === 'TEXTAREA' || el.isContentEditable) return 'textbox';
    if (el.tagName === 'INPUT') {
      if (['checkbox', 'radio'].includes(el.type)) return el.type;
      if (['button', 'submit', 'reset', 'image'].includes(el.type)) return 'button';
      if (el.type === 'search') return 'searchbox';
      if (el.type === 'number') return 'spinbutton';
      if (['text', 'email', 'url', 'tel'].includes(el.type)) return 'textbox';
    }
    return null;
  }

  // guard 스냅샷: 신원 + 의미. 기하(rect)는 저장하지 않는다(실행 직전 재해석).
  function guardOf(el) {
    if (!el || !el.isConnected) return null;
    let visible = true;
    try { visible = isElementVisible(el); } catch (e) { visible = false; }
    if (!visible) return null;
    let scope = null;
    try {
      scope = el.closest('form,dialog,[role="dialog"],article,li,tr,[role="row"]') || el.parentElement;
    } catch (e) {}
    return [
      accRole(el),
      accName(el),
      ('value' in el) ? (el.value ?? null) : null,
      ('checked' in el) ? (el.checked ?? null) : null,
      (el.tagName === 'SELECT') ? (el.selectedIndex ?? null) : null,
      ('readOnly' in el) ? (el.readOnly ?? null) : null,
      (typeof el.matches === 'function') ? el.matches(':disabled') : null,
      el.getAttribute('aria-disabled'),
      el.getAttribute('aria-expanded'),
      el.getAttribute('aria-checked'),
      el.getAttribute('aria-selected'),
      el.getAttribute('href'),
      (scope && scope.innerText ? scope.innerText : '').slice(0, 6000)
    ];
  }

  // hit-test: 요소가 다른 것에 가려졌는지 (jev는 입력 직전 기하를 재해석한다)
  function isCovered(el) {
    try {
      // ⚠️ 다른 문서(iframe 내부)의 요소는 좌표계가 다르다.
      //    el.getBoundingClientRect() 는 그 프레임 기준인데 document.elementFromPoint 는
      //    메인 문서 기준이라, 그대로 비교하면 항상 covered 로 오판해 클릭이 막힌다.
      //    잘못 막는 것보다 기존 동작을 유지하는 편이 안전하므로 hit-test 를 건너뛴다.
      if (el.ownerDocument && el.ownerDocument !== document) return false;

      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return true;
      const dx = Math.max(1, Math.min(4, r.width / 4));
      const dy = Math.max(1, Math.min(4, r.height / 4));
      const pts = [
        [r.left + r.width / 2, r.top + r.height / 2],
        [r.left + dx, r.top + dy],
        [r.right - dx, r.bottom - dy]
      ];
      for (const [x, y] of pts) {
        if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) return true;
        const hit = document.elementFromPoint(x, y);
        if (!hit) return true;
        if (hit !== el && !el.contains(hit) && !hit.contains(el)) return true;
      }
      return false;
    } catch (e) {
      return false;   // 판정 불가 시 기존 동작 유지 (fail-open)
    }
  }

  // nodeId 해석 + guard 검증. 통과할 때만 요소를 돌려준다.
  function resolveGuarded(nodeId) {
    const el = __daonReg.nodes.get(nodeId);
    if (!el) {
      return { ok: false, reason: 'gone', error: `요소 #${nodeId}를 찾을 수 없습니다. 다시 스냅샷을 찍으세요.` };
    }
    if (!el.isConnected) {
      __daonReg.nodes.delete(nodeId);
      __daonReg.guards.delete(nodeId);
      return { ok: false, reason: 'disconnected', error: `요소 #${nodeId}가 페이지에서 제거되었습니다(DOM 변경). 다시 스냅샷을 찍으세요.` };
    }
    if (!isElementVisible(el)) {
      return { ok: false, reason: 'hidden', error: `요소 #${nodeId}가 더 이상 보이지 않습니다(숨김/이동). 다시 스냅샷을 찍으세요.` };
    }
    const before = __daonReg.guards.get(nodeId);
    if (before) {
      const now = guardOf(el);
      if (!now) {
        return { ok: false, reason: 'unobservable', error: `요소 #${nodeId}의 상태를 읽을 수 없습니다. 다시 스냅샷을 찍으세요.` };
      }
      const FIELDS = ['role', 'name', 'value', 'checked', 'selectedIndex', 'readOnly',
        'disabled', 'aria-disabled', 'aria-expanded', 'aria-checked', 'aria-selected', 'href'];
      const changed = [];
      const len = Math.min(before.length - 1, now.length - 1);   // 마지막(scope 텍스트)은 제외
      for (let i = 0; i < len; i++) {
        if (String(before[i] ?? '') !== String(now[i] ?? '')) changed.push(FIELDS[i] || `f${i}`);
      }
      if (changed.length) {
        return {
          ok: false, reason: 'stale', changed,
          error: `요소 #${nodeId}의 상태가 스냅샷 이후 변경되었습니다(${changed.join(', ')}). 다시 스냅샷을 찍으세요.`
        };
      }
    }
    // ── ★ [4차] 문서 전체 지문 비교 (jev fresh() 이식) ──────────────────────
    // guard 는 '그 요소'만 본다 → SPA 가 DOM 을 재사용한 채 라우팅만 바꾸거나,
    // 같은 폼의 다른 필드가 바뀐 경우를 못 잡는다. pageKey 가 그 구멍을 메운다.
    // 원본 browser.py L88~98 이 [page_key, guard] 를 함께 비교하는 것과 동일.
    if (__daonReg.pageKey) {
      const pkChanged = pageKeyDiff(__daonReg.pageKey, pageKeyOf());
      if (pkChanged) {
        return {
          ok: false, reason: 'stale', changed: pkChanged,
          error: `문서 상태가 스냅샷 이후 변경되었습니다(${pkChanged.join(', ')}). 다시 스냅샷을 찍으세요.`
        };
      }
    }
    if (isCovered(el)) {
      return { ok: false, reason: 'covered', error: `요소 #${nodeId}가 다른 요소에 가려져 있습니다(오버레이/스크롤). 다시 스냅샷을 찍으세요.` };
    }
    return { ok: true, el };
  }

  // ── [2026-09-19 추가] covered 자동 복구 ────────────────────────────────────
  // 문제: 검색창을 클릭하면 자동완성 드롭다운이 뜨는데, 그 오버레이가 검색창 자체를
  //       덮어 isCovered()가 true가 된다 → type/click이 'covered'로 거부되고
  //       에이전트가 "다시 스냅샷"만 반복하다 검색 자동화가 매번 막힌다.
  // 해법: covered일 때만 (1) 오버레이 바깥 클릭 → (2) Escape 순으로 닫고 재판정.
  //       정상 실행 경로에는 아무 지연도 추가하지 않는다(성공 시 부작용 0).
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function _clickAtPoint(x, y) {
    try {
      const hit = document.elementFromPoint(x, y);
      if (!hit) return false;
      ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(t => {
        try {
          hit.dispatchEvent(new MouseEvent(t, {
            bubbles: true, cancelable: true, clientX: x, clientY: y, view: window
          }));
        } catch (e) {}
      });
      return true;
    } catch (e) { return false; }
  }

  function dismissOverlayByOutsideClick(el) {
    try {
      const r = el ? el.getBoundingClientRect() : null;
      // 오버레이 바깥 후보: 좌측 상단 여백 → 실패 시 요소 위쪽 여백
      const candidates = [
        [3, 3],
        [Math.max(3, window.innerWidth - 4), 3],
        [3, r ? Math.max(3, r.top - 12) : 3]
      ];
      for (const [x, y] of candidates) {
        if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) continue;
        const hit = document.elementFromPoint(x, y);
        if (!hit) continue;
        if (el && (hit === el || el.contains(hit) || hit.contains(el))) continue;
        _clickAtPoint(x, y);
        return true;
      }
    } catch (e) {}
    return false;
  }

  function pressEscapeKey() {
    try {
      const t = document.activeElement || document.body;
      ['keydown', 'keypress', 'keyup'].forEach(type => {
        try {
          t.dispatchEvent(new KeyboardEvent(type, {
            key: 'Escape', code: 'Escape', keyCode: 27, which: 27,
            bubbles: true, cancelable: true, view: window
          }));
        } catch (e) {}
      });
      return true;
    } catch (e) { return false; }
  }

  // covered 전용 복구 래퍼 — 그 외 실패(gone/stale/hidden 등)는 즉시 반환(정직한 실패 유지)
  async function resolveGuardedRecover(nodeId) {
    let res = resolveGuarded(nodeId);
    if (res.ok || res.reason !== 'covered') return res;

    const el = __daonReg.nodes.get(nodeId) || null;

    // 1차: 오버레이 바깥 클릭 (Escape보다 침습적이지 않음 — 페이지 자체 Escape 핸들러 오작동 방지)
    if (dismissOverlayByOutsideClick(el)) {
      await sleep(200);
      res = resolveGuarded(nodeId);
      if (res.ok || res.reason !== 'covered') return res;
    }

    // 2차: Escape (자동완성/드롭다운 확실히 닫기)
    pressEscapeKey();
    await sleep(200);
    return resolveGuarded(nodeId);
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
  // ⚠️ 2026-09-19 개편: 각 요소에 nodeId(런타임 신원)와 guard를 부여한다.
  //    실행 시 selector 재탐색 대신 nodeId로 지정하면 스냅샷 시점과 동일한 요소가 보장된다.
  function extractInteractiveSnapshot() {
    regPrune();
    const docs = getSearchableDocuments();
    const items = [];
    let count = 0;
    const LIMIT = 250;

    const SELECTOR = 'a, button, input, select, textarea, summary, [contenteditable="true"], ' +
      '[role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="switch"], ' +
      '[role="tab"], [role="menuitem"], [role="menuitemradio"], [role="option"], ' +
      '[role="combobox"], [role="textbox"], [role="searchbox"], [role="spinbutton"]';

    for (const doc of docs) {
      if (count >= LIMIT) break;
      const elements = Array.from(doc.querySelectorAll(SELECTOR));
      for (const el of elements) {
        if (count >= LIMIT) break;
        if (!isElementVisible(el)) continue;
        if (['password', 'file', 'hidden'].includes(el.type)) continue;
        if (typeof el.matches === 'function' &&
            (el.matches(':disabled') || el.closest('[aria-disabled="true"]'))) continue;

        // 뷰포트 밖 요소 제외 (jev: 중심 좌표가 화면 내)
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
        if (cx < 0 || cy < 0 || cx >= window.innerWidth || cy >= window.innerHeight) continue;

        // ★ 신원 + guard 등록
        const nodeId = regIdentity(el);
        const guard = guardOf(el);
        if (guard) __daonReg.guards.set(nodeId, guard);

        const tag = el.tagName.toLowerCase();
        const role = accRole(el) || tag;
        const type = el.type || '';
        const accname = accName(el).replace(/\s+/g, ' ').trim();
        const text = (accname || el.innerText || el.value || el.placeholder ||
                      el.getAttribute('aria-label') || '').trim();

        const id = el.id ? `#${el.id}` : '';
        const nameAttr = el.getAttribute('name') ? `[name="${el.getAttribute('name')}"]` : '';
        // 안전한 클래스명만 셀렉터로 (특수문자 포함 시 깨짐)
        let cls = '';
        if (!id && !nameAttr && typeof el.className === 'string' && el.className.trim()) {
          const first = el.className.trim().split(/\s+/)[0];
          if (/^[A-Za-z_-][A-Za-z0-9_-]*$/.test(first)) cls = `.${first}`;
        }

        items.push({
          index: ++count,
          nodeId,                               // ★ 실행 시 이 값으로 지정 (권장)
          tag,
          role,
          type,
          text: text.slice(0, 60),
          value: ('value' in el) ? String(el.value ?? '').slice(0, 60) : '',
          selector: id || nameAttr || cls || tag
        });

        // ── ★ [4차] SELECT 옵션 개별 노출 (jev 이식) ──────────────────────────
        // 원본 snapshot.js L68~71: SELECT 의 각 '미선택' 옵션을 별개 액션으로 노출한다.
        //   for (const o of e.options) if (!o.selected && !o.disabled && !o.closest('optgroup[disabled]'))
        //     actions.push({...base, kind:'select', value:o.value, label:base.label+' → '+o.label});
        // 우리는 옵션 항목에 selectValue 를 실어, sidepanel 이 ACT_SELECT 로 실행하게 한다.
        // nodeId 는 SELECT 노드를 그대로 가리킨다(옵션은 실행 대상이 아니라 선택지).
        if (tag === 'select') {
          const baseLabel = text;
          for (const o of el.options) {
            if (count >= LIMIT) break;
            if (o.selected || o.disabled || o.closest('optgroup[disabled]')) continue;
            items.push({
              index: ++count,
              nodeId,
              tag: 'option',
              role: 'option',
              type: '',
              text: `${baseLabel} → ${o.label || o.text}`.slice(0, 60),
              value: String(o.value ?? '').slice(0, 60),
              selectValue: String(o.value ?? ''),     // ★ ACT_SELECT 에 전달할 값
              selector: `${id || tag} option`
            });
          }
        }
      }
    }

    // ★ [4차] 스냅샷 시점의 문서 전체 지문을 보관 — 실행 시점에 비교해
    //   guard 가 못 잡는 전역 변화(SPA 라우팅/타 필드 변경)를 감지한다.
    __daonReg.pageKey = pageKeyOf();

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
        // ── [2026-09-19 3차] 준비 상태 프로브 ───────────────────────────────
        // 확장 리로드/탭 전환 직후 content script가 죽어 있는지 가볍게 확인하는 용도.
        // sidepanel이 이 핑 실패를 감지해 content.js를 프로그래밍 방식으로 재주입한다.
        case 'PING': {
          sendResponse({
            ok: true, pong: true, v: '1.1.3',
            url: location.href, readyState: document.readyState
          });
          break;
        }

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
          (async () => {
            try {
              let el = null;
              // ① nodeId 경로 (권장): 스냅샷 시점 노드를 guard 검증 후 실행 — 엉뚱한 요소 클릭 차단
              //    covered(오버레이)면 자동으로 오버레이를 걷어내고 재판정한다.
              if (request.nodeId !== undefined && request.nodeId !== null) {
                const res = await resolveGuardedRecover(Number(request.nodeId));
                if (!res.ok) {
                  sendResponse({ ok: false, stale: true, reason: res.reason, error: res.error });
                  return;
                }
                el = res.el;
              } else {
                // ② 레거시 selector 경로 (하위 호환)
                el = findElement(request.target || request.selector, request.nth || 1, { isClick: true });
              }
              if (!el) {
                sendResponse({ ok: false, error: `요소를 찾을 수 없습니다: "${request.target || request.selector}" (nth: ${request.nth || 1})` });
                return;
              }
              showFeedback(el, `클릭: ${request.target || '버튼'}`);
              simulateClick(el);
              sendResponse({
                ok: true,
                nodeId: __daonReg.ids.get(el) ?? null,
                message: `클릭 완료: <${el.tagName.toLowerCase()}> "${(el.innerText || el.value || '').trim().slice(0, 30)}"`,
                url: window.location.href
              });
            } catch (err) {
              sendResponse({ ok: false, error: err.message });
            }
          })();
          break;
        }

        case 'ACT_HOVER': {
          (async () => {
            try {
              let el = null;
              if (request.nodeId !== undefined && request.nodeId !== null) {
                const res = await resolveGuardedRecover(Number(request.nodeId));
                if (!res.ok) {
                  sendResponse({ ok: false, stale: true, reason: res.reason, error: res.error });
                  return;
                }
                el = res.el;
              } else {
                el = findElement(request.target || request.selector, request.nth || 1, { isClick: false });
              }
              if (!el) {
                sendResponse({ ok: false, error: `요소를 찾을 수 없습니다: "${request.target || request.selector}" (nth: ${request.nth || 1})` });
                return;
              }
              showFeedback(el, `호버: ${request.target || '요소'}`);
              simulateHover(el);
              sendResponse({
                ok: true,
                nodeId: __daonReg.ids.get(el) ?? null,
                message: `호버(Mouse Over) 완료: <${el.tagName.toLowerCase()}> "${(el.innerText || el.value || '').trim().slice(0, 30)}"`,
                url: window.location.href
              });
            } catch (err) {
              sendResponse({ ok: false, error: err.message });
            }
          })();
          break;
        }

        case 'ACT_PRESS_KEY': {
          (async () => {
            try {
              const key = request.key || 'Enter';
              let el = null;
              let viaNode = false;
              // ① nodeId 경로 [2026-09-19 신설] — click/hover/type과 대칭화.
              //    종전에는 nodeId를 아예 받지 않아 항상 document.activeElement로 갔다.
              //    그래서 대상 입력창에 포커스가 없으면 엉뚱한 곳에 Enter가 가면서도
              //    '성공'을 반환하는 거짓 성공이 발생했다(실측: type 실패 후 Enter가 성공으로 보고됨).
              if (request.nodeId !== undefined && request.nodeId !== null) {
                const res = await resolveGuardedRecover(Number(request.nodeId));
                if (!res.ok) {
                  sendResponse({ ok: false, stale: true, reason: res.reason, error: res.error });
                  return;
                }
                el = res.el;
                viaNode = true;
              } else if (request.target) {
                el = findElement(request.target, request.nth || 1, { isInput: true });
              }
              // nodeId로 지목했으면 포커스를 강제해 키가 반드시 그 요소로 가게 한다.
              if (viaNode && el && typeof el.focus === 'function') {
                try { el.focus(); } catch (e) {}
              }
              if (el) showFeedback(el, `키: ${key}`);
              simulateKeyPress(el, key);
              sendResponse({
                ok: true,
                nodeId: el ? (__daonReg.ids.get(el) ?? null) : null,
                target: el ? `<${el.tagName.toLowerCase()}>` : '(activeElement)',
                message: `키 입력 완료: [${key}]${el ? ` (대상: <${el.tagName.toLowerCase()}>)` : ' (대상: 현재 포커스 요소)'}`
              });
            } catch (err) {
              sendResponse({ ok: false, error: err.message });
            }
          })();
          break;
        }

        case 'ACT_TYPE': {
          (async () => {
            try {
              let el = null;
              // ① nodeId 경로 (권장): 스냅샷 시점 노드를 guard 검증 후 입력
              //    covered(자동완성 드롭다운이 입력창을 덮은 경우)면 오버레이를 걷어내고 재판정.
              if (request.nodeId !== undefined && request.nodeId !== null) {
                const res = await resolveGuardedRecover(Number(request.nodeId));
                if (!res.ok) {
                  sendResponse({ ok: false, stale: true, reason: res.reason, error: res.error });
                  return;
                }
                el = res.el;
              } else {
                // ② 레거시 selector 경로 (하위 호환)
                el = findElement(request.target || request.selector, request.nth || 1, { isInput: true });
              }
              if (!el) {
                sendResponse({ ok: false, error: `입력 필드를 찾을 수 없습니다: "${request.target || request.selector}"` });
                return;
              }
              const visible = isElementVisible(el);
              showFeedback(el, `입력: "${request.text}"`);
              const verified = await simulateTyping(el, request.text);
              // ── ★ [4차] combobox 제안 대기 (jev 이식) ────────────────────────
              // 원본: "Editable ARIA comboboxes wait for visible options, capped at 200ms"
              // 입력 직후 자동완성이 뜨는 것을 기다려 준다. 그러면 다음 액션이
              // 'covered'(오버레이가 입력창을 덮음)로 막히는 상황이 애초에 안 생긴다.
              // → 우리의 사후 복구(resolveGuardedRecover)를 최후 수단으로 물러나게 한다.
              try { await waitForSuggestions(el, 200); } catch (e) {}
              // ── [2026-09-19 2차 수정] type 자기-stale 해소 ─────────────────────
              // 문제: guardOf()는 'value'/'aria-expanded'를 guard에 포함한다.
              //   그래서 type이 검색창 value를 바꾸는 순간 그 노드 자체가 stale이 되고,
              //   뒤따르는 press(Enter)/click이 "상태가 변경되었습니다"로 거부됐다.
              //   실측: type(nodeId=4) 성공 → press Enter(nodeId=4) → stale 거부.
              //   '입력 → Enter'는 검색의 기본 패턴이라 매번 재스냅샷을 요구하면 실사용 불가.
              // ── ★ [4차 확장] guard 뿐 아니라 pageKey 도 재캡처 ────────────────
              //   pageKey 에는 모든 폼 값이 들어가므로, type 은 pageKey 도 바꾼다.
              //   재캡처하지 않으면 4차에서 추가한 지문 비교가 같은 이유로 press 를 막는다.
              //   (type 이 변경한 상태는 '예상된 변경'이므로 새 baseline 으로 확정)
              //   gone/disconnected/hidden 검사는 그대로 유지되므로 위험은 낮다.
              try {
                let nid = (request.nodeId !== undefined && request.nodeId !== null)
                  ? Number(request.nodeId) : null;
                if (nid === null && __daonReg.ids) nid = __daonReg.ids.get(el) ?? null;
                if (nid !== null) {
                  const g = guardOf(el);
                  if (g) { __daonReg.guards.set(nid, g); __daonReg.nodes.set(nid, el); }
                }
                __daonReg.pageKey = pageKeyOf();   // ★ 4차: 지문도 갱신
              } catch (e) {}
              const val = ('value' in el && typeof el.value === 'string')
                ? el.value
                : ((el.innerText || el.textContent || '').trim().slice(0, 50));
              sendResponse({
                ok: true,
                nodeId: __daonReg.ids.get(el) ?? null,
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

        // ── ★ [4차] 네이티브 SELECT 옵션 선택 (jev 이식) ─────────────────────
        // 원본 browser.py L152~157:
        //   if (action.kind==='select') {
        //     if (e.tagName!=='SELECT' || ![options].some(o=>o.value===action.value
        //         && !o.disabled && !o.closest('optgroup[disabled]'))) return null;
        //     e.value=action.value;
        //     e.dispatchEvent(new Event('input',{bubbles:true}));
        //     e.dispatchEvent(new Event('change',{bubbles:true}));
        //   }
        // 핵심: 옵션을 '관찰된 것'에서만 고르고(모델이 임의 값 생성 불가),
        //       프레임워크가 반응하도록 input+change 를 함께 디스패치한다.
        case 'ACT_SELECT': {
          (async () => {
            try {
              let el = null;
              if (request.nodeId !== undefined && request.nodeId !== null) {
                const res = await resolveGuardedRecover(Number(request.nodeId));
                if (!res.ok) {
                  sendResponse({ ok: false, stale: true, reason: res.reason, error: res.error });
                  return;
                }
                el = res.el;
              } else {
                el = findElement(request.target || request.selector, request.nth || 1);
              }
              if (!el) {
                sendResponse({ ok: false, error: 'SELECT 요소를 찾을 수 없습니다.' });
                return;
              }
              if (el.tagName !== 'SELECT') {
                sendResponse({ ok: false, error: `요소 #${request.nodeId} 는 <select> 가 아닙니다 (${el.tagName}).` });
                return;
              }
              const want = String(request.value ?? '');
              // ★ 관찰된 옵션에서만 선택 — 모델이 만든 임의 문자열을 그대로 넣지 않는다
              const opt = Array.from(el.options).find(o =>
                (String(o.value) === want || String(o.label || o.text) === want) &&
                !o.disabled && !o.closest('optgroup[disabled]'));
              if (!opt) {
                sendResponse({
                  ok: false,
                  error: `선택할 수 없는 옵션입니다: "${want}" (비활성/미존재). 다시 스냅샷을 찍으세요.`,
                  available: Array.from(el.options)
                    .filter(o => !o.disabled && !o.closest('optgroup[disabled]'))
                    .map(o => ({ value: o.value, label: o.label || o.text }))
                });
                return;
              }
              showFeedback(el, `선택: ${opt.label || opt.text}`);
              el.value = opt.value;
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
              // 재캡처 — select 도 폼 값/guard 를 바꾸므로 자기-stale 을 해소한다
              try {
                let nid = (request.nodeId !== undefined && request.nodeId !== null)
                  ? Number(request.nodeId) : null;
                if (nid === null && __daonReg.ids) nid = __daonReg.ids.get(el) ?? null;
                if (nid !== null) {
                  const g = guardOf(el);
                  if (g) { __daonReg.guards.set(nid, g); __daonReg.nodes.set(nid, el); }
                }
                __daonReg.pageKey = pageKeyOf();
              } catch (e) {}
              sendResponse({
                ok: true,
                nodeId: __daonReg.ids.get(el) ?? null,
                selected: opt.value,
                label: opt.label || opt.text,
                message: `선택 완료: "${opt.label || opt.text}" (${opt.value})`
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
