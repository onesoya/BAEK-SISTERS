// ---- 1. Firebase SDK를 불러오기 전에, 우리 클릭 처리 로직을 제일 먼저 등록함 ----
// (혹시 Firebase SDK가 내부적으로 자기만의 notificationclick 처리를 몰래 붙이는 경우를
//  대비해서, 우리 리스너를 먼저 등록해두고 stopImmediatePropagation으로 확실히 우리가
//  제어권을 갖도록 함. 이 이론이 틀렸더라도 이 순서 자체는 해가 되지 않음)

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

async function readAndClearPendingNotif() {
  try {
    const db = await openNotifDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(NOTIF_STORE, 'readwrite');
      const store = tx.objectStore(NOTIF_STORE);
      const getReq = store.get('latest');
      getReq.onsuccess = () => {
        const value = getReq.result;
        store.delete('latest');
        resolve(value || null);
      };
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

// 알림 클릭하면 해당 탭:게시글(:댓글:답글)로 이동.
self.addEventListener('notificationclick', (event) => {
  // 혹시 Firebase SDK가 나중에 자기 것도 등록하더라도, 그건 못 돌게 확실히 막음
  event.stopImmediatePropagation();
  event.notification.close();

  const raw = event.notification.data || {};
  const data = raw.FCM_MSG && raw.FCM_MSG.data ? raw.FCM_MSG.data : raw;
  const link = data.link || '/';

  const navPayload = {
    type: 'navigate',
    tab: data.tab,
    itemId: data.itemId,
    commentTs: data.commentTs,
    replyTs: data.replyTs
  };

  event.waitUntil(
    (async () => {
      // 플랫폼 상관없이 무조건 IndexedDB에도 남겨둠 (안드로이드/아이폰 둘 다 대응)
      await savePendingNotif(navPayload);

      const windowClients = await clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of windowClients) {
        if ('focus' in client) {
          await client.focus();
          client.postMessage(navPayload);
          return;
        }
      }
      return clients.openWindow(link);
    })()
  );
});

// 앱이 "혹시 자는 동안 놓친 알림 있어?"라고 물어보면(CHECK_PENDING_NOTIF) 꺼내서 돌려주고,
// "나 이미 처리했어"(CLEAR_PENDING_NOTIF)라고 하면 지워서 나중에 재발하지 않게 함
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'CHECK_PENDING_NOTIF') {
    event.waitUntil(
      readAndClearPendingNotif().then((pending) => {
        if (pending && event.source) {
          event.source.postMessage(pending);
        }
      })
    );
  }
  if (event.data && event.data.type === 'CLEAR_PENDING_NOTIF') {
    event.waitUntil(clearPendingNotif());
  }
  // 지금 실행 중인 서비스워커가 몇 버전인지 물어보면 바로 답해줌
  if (event.data && event.data.type === 'GET_SW_VERSION') {
    if (event.source) event.source.postMessage({ type: 'SW_VERSION', version: SW_VERSION });
  }
});

// ---- 2. 모든 통제권을 확보한 뒤에야 Firebase SDK를 불러옴 ----
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

// 이 서비스워커 파일 자체의 버전. 코드 고칠 때마다 이 값을 올림.
const SW_VERSION = 'sw-2026.07.13-3';

// 서비스워커 새 버전이 배포되면, 다른 탭을 안 닫아도 바로 이 버전으로 교체되게 함.
self.addEventListener('install', () => {
  self.skipWaiting();
});
self.addEventListener('activate', (event) => {
  event.waitUntil(clients.claim());
});

const messaging = firebase.messaging();

// notification 필드는 계속 포함해서 보내지만(배송 안정성), 여기서 직접
// showNotification()을 부르진 않음 - 그러면 SDK 자동 표시랑 겹쳐서 두 번 뜸.
// onBackgroundMessage는 "등록"만 해둬서 서비스워커가 푸시에 반응해 깨어있게 함.
messaging.onBackgroundMessage(() => {
  // 의도적으로 아무것도 안 함 (SDK 자동 표시에 맡김)
});
