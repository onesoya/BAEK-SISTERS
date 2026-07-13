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
    replyTs: data.replyTs,
    // 잠금화면/알림창에서 바로 눌렀을 때도 앱이 이 알림을 "읽음" 처리할 수 있도록 ID를 같이 전달.
    // data에 notifId가 없으면(예전 버전 알림이거나 등) 태그 값으로라도 대체 시도.
    notifId: data.notifId || event.notification.tag
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
const SW_VERSION = 'sw-2026.07.13-10';

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
  // 앱에서 특정 알림을 읽음 처리했을 때, 잠금화면/알림창에 떠있는 그 알림도 같이 지움
  if (event.data && event.data.type === 'CLOSE_NOTIFICATION' && event.data.tag) {
    event.waitUntil(
      self.registration.getNotifications({ tag: event.data.tag }).then((notifs) => {
        notifs.forEach((n) => n.close());
      })
    );
  }
  // 알림함 "전체 삭제" 버튼을 눌렀을 때, 현재 기기의 잠금화면/알림창 알림을 전부 정리
  if (event.data && event.data.type === 'CLEAR_ALL_NOTIFICATIONS') {
    event.waitUntil(
      self.registration.getNotifications().then((notifs) => {
        notifs.forEach((n) => n.close());
      })
    );
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

// 알림 클릭(notificationclick)이 아이폰에서 아예 발생하지 않는 경우가 있음
// (Firebase 공식 Known Issues #7309 - WebKit 자체 버그. 홈 화면 아이콘으로 세션이
// 시작된 경우 서비스워커의 이벤트 리스너들이 안 터질 수 있다고 명시돼있음).
// 그래서 "클릭했을 때" 저장하는 것 외에, "알림이 도착한 순간"에도 미리 저장해둠.
// 클릭 이벤트 자체가 씹혀도, 앱이 어떤 식으로든(수동으로 아이콘 눌러서라도) 다시
// 열리면 handleAppResume()이 이 저장된 정보를 찾아서 이동시켜줄 수 있음.
messaging.onBackgroundMessage(async (payload) => {
  const data = (payload && payload.data) ? payload.data : {};
  if (!data.tab) return;

  // 앱이 완전히 꺼져있는 동안에도 배지 숫자를 갱신할 수 있게, 서버가 이 알림까지
  // 포함한 "현재 총 안 읽은 개수"를 같이 보내줌 - 그 값으로 바로 배지를 갱신함.
  // (앱이 켜져있을 때는 app.js의 Firestore 구독이 더 정확하게 실시간으로 갱신해주지만,
  // 앱이 꺼진 상태에서 새 알림이 온 순간엔 이게 유일한 갱신 경로임)
  const unreadCount = Number(data.unreadCount);
  if ('setAppBadge' in self.navigator && Number.isFinite(unreadCount)) {
    try {
      if (unreadCount > 0) await self.navigator.setAppBadge(unreadCount);
      else if ('clearAppBadge' in self.navigator) await self.navigator.clearAppBadge();
    } catch (e) { /* 무시 - 미지원 기기/브라우저일 수 있음 */ }
  }

  // 이 우회는 notificationclick이 아예 안 터지는 아이폰(iPhone/iPod)에만 적용함.
  // 아이패드는 원래도 notificationclick이 정상 작동하고, 안드로이드도 기존
  // postMessage/focus 경로가 잘 되고 있어서 - 여기서 다 같이 저장해두면
  // "알림을 안 눌렀는데 나중에 앱을 열었을 때 자동으로 그 게시글로 이동해버리는"
  // 부작용이 생길 수 있음. 그 위험을 정말 필요한 기기로만 좁힘.
  const userAgent = self.navigator.userAgent || '';
  const isIPhone = /iPhone|iPod/i.test(userAgent);
  if (!isIPhone) return;

  await savePendingNotif({
    type: 'navigate',
    tab: data.tab,
    itemId: data.itemId,
    commentTs: data.commentTs,
    replyTs: data.replyTs,
    notifId: data.notifId,
    receivedAt: Date.now()
  });
  // showNotification()은 호출하지 않음 - notification 필드가 있어서 브라우저가 알아서 띄움
});
