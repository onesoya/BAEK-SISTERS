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

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if ('focus' in client) {
          client.postMessage({
            type: 'navigate',
            tab: data.tab,
            itemId: data.itemId,
            commentTs: data.commentTs,
            replyTs: data.replyTs
          });
          client.focus();
          // client.navigate(link)는 예전엔 안전장치로 넣어뒀는데, 이게 페이지를
          // 다시 불러오면서 postMessage로 막 끝낸 스크롤 위치를 초기화해버리는 것으로
          // 의심돼서(탭 이동/게시글 열기는 되는데 스크롤만 안 되는 증상) 제거함.
          return;
        }
      }
      if (clients.openWindow) return clients.openWindow(link);
    })
  );
});
