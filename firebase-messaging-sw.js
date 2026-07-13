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
// (app.js 화면에 보이는 버전과는 완전히 별개로 갱신되니, 이것도 따로 확인할 수 있게 해둠)
const SW_VERSION = 'sw-2026.07.13-2';

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

// ---- 놓친 알림을 기억해두는 저장소 (IndexedDB) ----
// 서비스워커의 일반 변수는 브라우저가 아무 때나 서비스워커를 종료했다가 재시작하면
// 같이 사라짐 (특히 폰이 잠긴 채로 시간이 좀 지나면 이런 일이 흔함). 그래서 재시작돼도
// 안 사라지는 IndexedDB에 저장해둠 - 아이폰이 잠금 상태에서 알림을 눌러 postMessage가
// 씹히더라도, 나중에 앱이 화면에 다시 보일 때 "혹시 놓친 거 있어?"라고 물어보면 꺼내줌.
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
  } catch (e) { /* 무시 - 저장 실패해도 기존 postMessage 경로는 그대로 시도됨 */ }
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
// 앱이 이미 열려있으면 postMessage로 직접 "이 탭/게시글로 이동해" 라고 알려주고,
// 앱이 안 열려있으면 그냥 해시가 붙은 주소로 새로 열어.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  // Firebase SDK가 알림을 자동 표시할 때, data를 그대로 안 주고
  // FCM_MSG라는 키 아래에 원본 페이로드를 통째로 감싸서 주는 경우가 있어서 둘 다 확인함.
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
      // 플랫폼 상관없이 무조건 IndexedDB에도 남겨둠 - 안드로이드도 화면이 꺼진 채로
      // 오래 있으면 탭 자체가 통째로 정리(discard)됐다가 다시 켜지면서 메시지를
      // 놓치는 경우가 있는 것으로 보여서, 이제 아이폰만이 아니라 항상 저장해둠.
      await savePendingNotif(navPayload);

      const windowClients = await clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of windowClients) {
        if ('focus' in client) {
          // navigate()로 동시에 "새로고침"까지 강제로 시도했던 이전 버전은, 포커스 맞추는
          // 것과 새로고침 시도가 서로 부딪혀서 오히려 아무 반응도 없는 상태를 만드는 것으로
          // 의심돼서 제거함. 이제 postMessage + focus만 시도하고, 이게 실패해도 (엄격하게
          // 확인은 못 하지만) 아래 CHECK_PENDING_NOTIF 경로가 뒤늦게라도 확실히 채워줌.
          client.postMessage(navPayload);
          client.focus();
          return;
        }
      }
      return clients.openWindow(link);
    })()
  );
});

// 앱이 "혹시 자는 동안 놓친 알림 있어?"라고 물어보면(CHECK_PENDING_NOTIF),
// IndexedDB에 저장해둔 게 있으면 꺼내서 돌려줌.
// CLEAR_PENDING_NOTIF는, 위 postMessage가 이미 잘 처리된 경우에도 DB에는 그 기록이
// 남아있을 수 있어서(성공 여부를 서비스워커가 확인할 방법이 없음), 페이지 쪽에서
// "나 이미 처리했어"라고 알려주면 지워서 나중에 엉뚱한 시점에 같은 알림이 다시
// 튀어나오는 걸 막기 위한 것.
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
