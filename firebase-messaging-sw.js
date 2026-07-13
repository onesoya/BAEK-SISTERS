// ============================================================================
// 1. 커스텀 알림 클릭 리스너 (반드시 Firebase 로드보다 최상단에 위치해야 함!)
// ============================================================================
self.addEventListener('notificationclick', (event) => {
  const raw = event.notification.data || {};
  const fcmPayload = raw.FCM_MSG || null;
  const data = (fcmPayload && fcmPayload.data) ? fcmPayload.data : raw;

  // 우리 앱의 이동용 알림이 아니면(혹시 모를 다른 알림), Firebase 기본 처리에 맡김
  const fcmLink = fcmPayload && fcmPayload.fcmOptions && fcmPayload.fcmOptions.link;
  if (!data.tab && !data.link && !fcmLink) {
    return;
  }

  // 뒤에서 로드되는 Firebase SDK의 기본 클릭 처리를 확실히 차단
  event.stopImmediatePropagation();
  event.notification.close();

  const navPayload = {
    type: 'navigate',
    tab: data.tab,
    itemId: data.itemId,
    commentTs: data.commentTs,
    replyTs: data.replyTs
  };

  const hashStr = [data.tab, data.itemId, data.commentTs, data.replyTs].filter(Boolean).join(':');
  // 주소 fallback은 self.registration.scope 기준으로 (GitHub Pages 하위 경로 /BAEK-SISTERS/ 정확히 포함되도록)
  const fallbackUrl = data.link || fcmLink || `${self.registration.scope}${hashStr ? '#' + hashStr : ''}`;

  event.waitUntil(
    (async () => {
      // IndexedDB에 저장 (앱이 놓쳤을 경우를 대비한 안전망)
      await savePendingNotif(navPayload);

      const windowClients = await clients.matchAll({ type: 'window', includeUncontrolled: true });
      // 아무 창이나 잡지 않고, 정확히 "우리 앱 범위 안의" 창인지 확인
      const appClient = windowClients.find((client) => client.url.startsWith(self.registration.scope));

      if (appClient) {
        // focus()가 실패하거나 늦어져도 메시지는 이미 전달되도록, postMessage를 먼저 보냄
        appClient.postMessage(navPayload);
        try {
          await appClient.focus();
        } catch (e) {
          // 앱 복귀 후 IndexedDB 확인(CHECK_PENDING_NOTIF)으로 복구됨
        }
        return;
      }

      if (clients.openWindow) {
        await clients.openWindow(fallbackUrl);
      }
    })()
  );
});

// ============================================================================
// 2. 서비스워커 갱신 및 상태 관리
// ============================================================================
const SW_VERSION = 'sw-2026.07.13-5';

self.addEventListener('install', () => {
  self.skipWaiting();
});
self.addEventListener('activate', (event) => {
  event.waitUntil(clients.claim());
});

// ============================================================================
// 3. 놓친 알림을 기억해두는 저장소 (IndexedDB) - 읽기와 삭제를 분리함
// ============================================================================
const NOTIF_DB_NAME = 'baek-sisters-notif';
const NOTIF_STORE = 'pending';

function openNotifDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(NOTIF_DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(NOTIF_STORE)) {
        req.result.createObjectStore(NOTIF_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function savePendingNotif(payload) {
  try {
    const db = await openNotifDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(NOTIF_STORE, 'readwrite');
      tx.objectStore(NOTIF_STORE).put(payload, 'latest');
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) { /* 무시 */ }
}

// 읽기만 하고 지우지는 않음 - 앱이 확실히 처리를 마쳤다고 알려줄 때(CLEAR_PENDING_NOTIF)만 지움.
// 이러면 앱이 메시지를 받고도 처리 도중 실패하는 경우, DB 기록이 사라지지 않고 남아있어서
// 다음 기회에 다시 시도할 수 있음.
async function readPendingNotif() {
  try {
    const db = await openNotifDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(NOTIF_STORE, 'readonly');
      const store = tx.objectStore(NOTIF_STORE);
      const getReq = store.get('latest');
      getReq.onsuccess = () => resolve(getReq.result || null);
      getReq.onerror = () => reject(getReq.error);
    });
  } catch (e) {
    return null;
  }
}

async function clearPendingNotif() {
  try {
    const db = await openNotifDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(NOTIF_STORE, 'readwrite');
      tx.objectStore(NOTIF_STORE).delete('latest');
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) { /* 무시 */ }
}

// ============================================================================
// 4. 앱(app.js)과의 통신
// ============================================================================
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'CHECK_PENDING_NOTIF') {
    event.waitUntil(
      readPendingNotif().then((pending) => {
        if (pending && event.source) {
          event.source.postMessage(pending);
        }
      })
    );
  }
  if (event.data && event.data.type === 'CLEAR_PENDING_NOTIF') {
    event.waitUntil(clearPendingNotif());
  }
  if (event.data && event.data.type === 'GET_SW_VERSION') {
    if (event.source) event.source.postMessage({ type: 'SW_VERSION', version: SW_VERSION });
  }
});

// ============================================================================
// 5. Firebase SDK 로드 및 초기화 (모든 커스텀 리스너 등록 후 가장 마지막에 실행)
// ============================================================================
importScripts('https://www.gstatic.com/firebasejs/12.15.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/12.15.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyDitp8XR42laZMI3egD86NJPhQJyJggeh8",
  authDomain: "baek-sisters.firebaseapp.com",
  projectId: "baek-sisters",
  storageBucket: "baek-sisters.firebasestorage.app",
  messagingSenderId: "446206353039",
  appId: "1:446206353039:web:d4e780fa2f8873dd2f5afa"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage(() => {
  // 의도적으로 아무것도 안 함 (SDK 자동 표시에 맡김)
});
