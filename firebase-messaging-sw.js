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

// 서버(Cloud Functions)에서 data-only로 보내기 때문에, 브라우저가 알림을
// 자동으로 띄우지 않아. 그래서 여기서 딱 한 번만 직접 띄워.
messaging.onBackgroundMessage((payload) => {
  const data = payload.data || {};
  const title = data.title || '백씨스터즈';
  const options = {
    body: data.body || '',
    icon: 'icon-180.png',
    badge: 'favicon-32.png',
    data: { link: data.link || '/', tab: data.tab || '', itemId: data.itemId || '' }
  };
  self.registration.showNotification(title, options);
});

// 알림 클릭하면 해당 탭:게시글로 이동.
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
          client.postMessage({ type: 'navigate', tab: data.tab, itemId: data.itemId });
          return client.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(link);
    })
  );
});
