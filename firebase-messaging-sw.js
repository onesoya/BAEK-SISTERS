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

// 여기서 firebase.messaging()을 호출해두면 SDK가 백그라운드 푸시(notification 필드 있는 메시지)를
// 자동으로 인식하고 처리함.
const messaging = firebase.messaging();

// onBackgroundMessage를 "등록"은 해두되(삼성인터넷 등에서 서비스워커가 푸시에 반응해서
// 제대로 깨어나는 데 이게 필요한 것으로 확인됨), 여기서 showNotification()을 직접
// 호출하지는 않음. notification 필드가 있으면 SDK가 어차피 자기가 알아서 띄우기 때문에,
// 여기서 또 띄우면 알림이 두 번 뜸. 클릭 시 이동은 Cloud Functions에서 보낸
// webpush.fcmOptions.link를 SDK가 그대로 사용해서 처리함.
messaging.onBackgroundMessage(() => {
  // 의도적으로 아무것도 안 함 (SDK 자동 표시에 맡김)
});

// 알림 표시는 SDK가 자동으로 하지만(위), 클릭했을 때 이동시키는 건 SDK 내부 기능
// (fcmOptions.link)이 아이폰(사파리)에서는 되는데 삼성인터넷에서는 안 먹히는 게 확인돼서,
// 클릭 처리만 우리가 직접 함. notificationclick은 누가 띄운 알림이든 상관없이 항상 뜨는
// 이벤트라서, 이렇게 해도 표시 자체가 중복되진 않음.
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
          if ('navigate' in client) {
            try { client.navigate(link); } catch (e) { /* 무시 */ }
          }
          return;
        }
      }
      if (clients.openWindow) return clients.openWindow(link);
    })
  );
});
