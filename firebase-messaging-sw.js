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
