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
// (이게 없으면 브라우저를 완전히 껐다 켜기 전까진 예전 버전이 계속 알림을 처리해서,
//  코드를 고쳐도 각자 기기에 그 수정이 안 들어간 것처럼 보일 수 있음)
self.addEventListener('install', () => {
  self.skipWaiting();
});
self.addEventListener('activate', (event) => {
  event.waitUntil(clients.claim());
});

const messaging = firebase.messaging();

// notification 필드는 삼성인터넷 등에서의 배송 안정성 때문에 계속 포함하지만,
// 표시 자체는 우리가 직접 해서 tab/itemId 등 이동 정보(data)가 확실히 알림에
// 붙도록 함 (브라우저 자동 표시에 맡기면 이 정보가 유실되는 게 확인됨).
messaging.onBackgroundMessage((payload) => {
  const notif = payload.notification || {};
  const data = payload.data || {};
  const title = notif.title || data.title || '백씨스터즈';
  const options = {
    body: notif.body || data.body || '',
    icon: 'icon-180.png',
    badge: 'favicon-32.png',
    data: {
      link: data.link || '/',
      tab: data.tab || '',
      itemId: data.itemId || '',
      commentTs: data.commentTs || '',
      replyTs: data.replyTs || ''
    }
  };
  self.registration.showNotification(title, options);
});

// 알림 클릭하면 해당 탭:게시글(:댓글:답글)로 이동.
// 앱이 이미 열려있으면 postMessage로 직접 "이 탭/게시글로 이동해" 라고 알려주고
// (URL 해시 변경에만 의존하면 백그라운드 탭에서 안정적으로 안 먹힐 때가 있어서),
// 앱이 안 열려있으면 그냥 해시가 붙은 주소로 새로 열어.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const link = data.link || '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if ('focus' in client) {
          // 최신 페이지면 이 메시지를 받아서 탭 이동+스크롤+펼치기까지 다 해줌
          client.postMessage({
            type: 'navigate',
            tab: data.tab,
            itemId: data.itemId,
            commentTs: data.commentTs,
            replyTs: data.replyTs
          });
          client.focus();
          // 혹시 페이지가 오래된 버전이라 위 메시지를 못 알아들어도,
          // 이 주소 이동만큼은 되도록 이중 안전장치. (완전한 탭+스크롤은 못 해줘도
          // 최소한 "안 열린다"는 느낌은 없어짐)
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
