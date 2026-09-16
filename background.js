/**
 * DAON Browser Agent - Background Service Worker (MV3)
 */

// 아이콘 클릭 시 사이드 패널이 바로 열리도록 설정
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error('SidePanel behavior 설정 오류:', error));

chrome.runtime.onInstalled.addListener(() => {
  console.log('[DAON Agent] 확장 프로그램이 설치되었습니다. (v1.0.0)');
});

// 탭 또는 사이드패널 간 메시지 라우팅 보조
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'PING') {
    sendResponse({ status: 'PONG', timestamp: Date.now() });
  }
  return true;
});
