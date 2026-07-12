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
// 자동으로 인식하고 처리함. onBackgroundMessage나 notificationclick을 우리가 직접 등록하면
// - notification 필드가 있는 메시지는 브라우저가 어차피 우리 코드를 안 거치고 자체 처리하고
//   (이때 클릭 시 이동은 Cloud Functions에서 보낸 webpush.fcmOptions.link를 그대로 씀)
// - 거기에 우리 코드까지 끼어들면 오히려 화면 이동 정보가 꼬여서 엉뚱한 곳(홈)으로 가버리는
//   문제가 실제로 확인됐음.
// 그래서 여기서는 아무것도 커스텀하지 않고, SDK 기본 동작 + fcmOptions.link에만 맡김.
firebase.messaging();
