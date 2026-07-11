import { initializeApp } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, addDoc, deleteDoc, onSnapshot,
  collection, query, where, orderBy, limit, getDocs, arrayUnion, arrayRemove, Timestamp
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js";
import {
  getStorage, ref, uploadBytes, getDownloadURL
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-storage.js";

const firebaseConfig = {
  apiKey: "AIzaSyDitp8XR42laZMI3egD86NJPhQJyJggeh8",
  authDomain: "baek-sisters.firebaseapp.com",
  projectId: "baek-sisters",
  storageBucket: "baek-sisters.firebasestorage.app",
  messagingSenderId: "446206353039",
  appId: "1:446206353039:web:d4e780fa2f8873dd2f5afa"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const ALLOWED_EMAILS = [
  "sjsj980415@gmail.com",
  "xkakak456456@gmail.com",
  "qordnsqls@gmail.com",
  "baekungyeong@gmail.com"
];

const NAME_BY_EMAIL = {
  "sjsj980415@gmail.com": { name: "소정", colorKey: "yellow" },
  "xkakak456456@gmail.com": { name: "지수", colorKey: "red" },
  "qordnsqls@gmail.com": { name: "운빈", colorKey: "green" },
  "baekungyeong@gmail.com": { name: "운경", colorKey: "blue" }
};

const STRONG_COLOR = { yellow: "#B8860B", red: "#C24040", green: "#3E8E52", blue: "#3B6EC2" };
const SOFT_COLOR = { yellow: "#FFF6D8", red: "#FFE0E0", green: "#E1F3E4", blue: "#E1EBFB" };

let currentUser = null; // { uid, name, colorKey, email }
let allProfiles = []; // [{ uid, name, colorKey, email }, ...] - 로그인 이력 있는 사람만 채워짐

// ---------- 탭 전환 ----------
document.querySelectorAll(".tab-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add("active");
  });
});

// ---------- 로그인 ----------
const identityChip = document.getElementById("identityChip");
identityChip.addEventListener("click", async () => {
  if (currentUser) { await signOut(auth); return; }
  const provider = new GoogleAuthProvider();
  try { await signInWithPopup(auth, provider); }
  catch (e) { console.error("로그인 실패", e); }
});

onAuthStateChanged(auth, async (user) => {
  if (user && ALLOWED_EMAILS.includes(user.email)) {
    const meta = NAME_BY_EMAIL[user.email];
    currentUser = { uid: user.uid, name: meta.name, colorKey: meta.colorKey, email: user.email };
    identityChip.textContent = `${meta.name} 🐾`;

    const profileRef = doc(db, "profiles", user.uid);
    const snap = await getDoc(profileRef);
    if (!snap.exists()) {
      await setDoc(profileRef, {
        name: meta.name, email: user.email, colorKey: meta.colorKey,
        status: { text: "", emoji: "", updatedAt: Timestamp.now() }
      });
    }

    initApp();
  } else if (user) {
    alert("백씨스터즈 멤버 계정으로만 로그인할 수 있어");
    await signOut(auth);
  } else {
    currentUser = null;
    identityChip.textContent = "로그인";
  }
});

// ---------- 공통 헬퍼 ----------
function stripTime(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
function diffDays(a, b) { return Math.round((b - a) / 86400000); }

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str || "";
  return div.innerHTML;
}

function colorKeyByName(name) {
  const entry = Object.values(NAME_BY_EMAIL).find(m => m.name === name);
  return entry ? entry.colorKey : "";
}

function authorBadge(name, colorKey) {
  const strong = STRONG_COLOR[colorKey] || "#8A8390";
  const soft = SOFT_COLOR[colorKey] || "#F0EEF2";
  return `<span style="font-family:'DungGeunMo',sans-serif;font-size:11.5px;padding:2px 8px;border-radius:8px;background:${soft};color:${strong};">${escapeHtml(name)}</span>`;
}

function formatTimeAgo(date) {
  const mins = Math.floor((Date.now() - date.getTime()) / 60000);
  if (mins < 1) return "방금 전";
  if (mins < 60) return `${mins}분 전`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}시간 전`;
  return `${Math.floor(hours / 24)}일 전`;
}

async function loadAllProfiles() {
  const snap = await getDocs(collection(db, "profiles"));
  allProfiles = snap.docs.map(d => ({ uid: d.id, ...d.data() }));
}

function populateCheckboxGroup(container, cbClass) {
  container.innerHTML = allProfiles.map(p => `
    <label>
      <input type="checkbox" value="${p.uid}" data-name="${p.name}" class="${cbClass}" />
      ${escapeHtml(p.name)}
    </label>
  `).join("");
}

async function uploadPhotos(fileList, folder) {
  if (!fileList || fileList.length === 0) return [];
  const storage = getStorage(app);
  const urls = [];
  for (const file of fileList) {
    const path = `${folder}/${Date.now()}_${file.name}`;
    const sref = ref(storage, path);
    await uploadBytes(sref, file);
    urls.push(await getDownloadURL(sref));
  }
  return urls;
}

function renderPhotoGrid(photos) {
  if (!photos || photos.length === 0) return "";
  return `<div class="photo-grid">${photos.map(u => `<img src="${u}" />`).join("")}</div>`;
}

// ---------- 좋아요 / 댓글 공통 ----------
async function toggleLike(collectionName, docId, currentLikes) {
  if (!currentUser) return;
  const ref_ = doc(db, collectionName, docId);
  if (currentLikes.includes(currentUser.uid)) {
    await updateDoc(ref_, { likes: arrayRemove(currentUser.uid) });
  } else {
    await updateDoc(ref_, { likes: arrayUnion(currentUser.uid) });
  }
}

async function addComment(collectionName, docId, text) {
  if (!currentUser || !text.trim()) return;
  const ref_ = doc(db, collectionName, docId);
  await updateDoc(ref_, {
    comments: arrayUnion({ author: currentUser.name, authorUid: currentUser.uid, text: text.trim(), ts: Date.now() })
  });
}

async function deleteComment(collectionName, docId, commentObj) {
  const ref_ = doc(db, collectionName, docId);
  await updateDoc(ref_, { comments: arrayRemove(commentObj) });
}

function reactionRowHTML(collectionName, id, likes, comments) {
  const liked = currentUser && likes.includes(currentUser.uid);
  const commentsHTML = comments.map(c => `
    <div class="comment-item">
      ${authorBadge(c.author, colorKeyByName(c.author))}
      <span class="c-text">${escapeHtml(c.text)}</span>
      ${currentUser && c.authorUid === currentUser.uid
        ? `<button class="c-del" data-id="${id}" data-comment='${encodeURIComponent(JSON.stringify(c))}'>삭제</button>`
        : ""}
    </div>
  `).join("");
  return `
    <div class="reaction-row">
      <button class="like-btn ${liked ? "liked" : ""}" data-id="${id}" data-likes='${JSON.stringify(likes)}'>❤️ ${likes.length}</button>
      <button class="comment-btn" data-id="${id}">💬 ${comments.length}</button>
    </div>
    <div class="comment-section" data-id="${id}">
      <div class="comment-list">${commentsHTML}</div>
      <div class="comment-input-row">
        <input type="text" class="comment-input" data-id="${id}" placeholder="댓글 달기" />
        <button class="comment-send" data-id="${id}">등록</button>
      </div>
    </div>
  `;
}

// 좋아요/댓글/삭제 이벤트를 리스트 컨테이너 하나에 위임 (재렌더링해도 다시 붙일 필요 없음)
function attachInteractionDelegation(container, collectionName) {
  container.addEventListener("click", async (e) => {
    const likeBtn = e.target.closest(".like-btn");
    if (likeBtn) {
      toggleLike(collectionName, likeBtn.dataset.id, JSON.parse(likeBtn.dataset.likes || "[]"));
      return;
    }
    const commentBtn = e.target.closest(".comment-btn");
    if (commentBtn) {
      const section = container.querySelector(`.comment-section[data-id="${commentBtn.dataset.id}"]`);
      if (section) section.classList.toggle("active");
      return;
    }
    const delBtn = e.target.closest(".item-delete");
    if (delBtn) {
      if (confirm("삭제할까?")) await deleteDoc(doc(db, collectionName, delBtn.dataset.id));
      return;
    }
    const cDelBtn = e.target.closest(".c-del");
    if (cDelBtn) {
      const commentObj = JSON.parse(decodeURIComponent(cDelBtn.dataset.comment));
      await deleteComment(collectionName, cDelBtn.dataset.id, commentObj);
      return;
    }
    const sendBtn = e.target.closest(".comment-send");
    if (sendBtn) {
      const id = sendBtn.dataset.id;
      const input = container.querySelector(`.comment-input[data-id="${id}"]`);
      if (input && input.value.trim()) {
        await addComment(collectionName, id, input.value);
        input.value = "";
      }
      return;
    }
  });
}

// ---------- 참여 확인 모달 (홈 + 일정 탭 공용) ----------
let pendingJoinScheduleId = null;

function openJoinModal(scheduleId) {
  pendingJoinScheduleId = scheduleId;
  document.getElementById("joinModalSub").textContent = "참여 여부를 알려줘! 나중에 취소도 가능해.";
  document.getElementById("joinModal").classList.remove("hidden");
}

document.getElementById("joinYesBtn").addEventListener("click", async () => {
  if (!pendingJoinScheduleId || !currentUser) return;
  const ref_ = doc(db, "schedule", pendingJoinScheduleId);
  await updateDoc(ref_, {
    participants: arrayUnion({ uid: currentUser.uid, name: currentUser.name, joinedAt: Timestamp.now() })
  });
  document.getElementById("joinModal").classList.add("hidden");
  pendingJoinScheduleId = null;
  loadNextDateEvent();
});

document.getElementById("joinNoBtn").addEventListener("click", () => {
  document.getElementById("joinModal").classList.add("hidden");
  pendingJoinScheduleId = null;
});

// ================= 홈 =================
function renderToday() {
  const now = new Date();
  const days = ["일", "월", "화", "수", "목", "금", "토"];
  document.getElementById("homeToday").textContent =
    `${now.getMonth() + 1}월 ${now.getDate()}일 (${days[now.getDay()]})`;
}

async function loadNearestAnniversary() {
  const pill = document.getElementById("homeAnnivPill");
  const snap = await getDocs(collection(db, "anniversaries"));
  const today = stripTime(new Date());

  let nearest = null;
  snap.forEach(docSnap => {
    const d = docSnap.data();
    const occurrence = nextOccurrence(d, today);
    if (occurrence && (!nearest || occurrence.date < nearest.date)) {
      nearest = { date: occurrence.date, dday: occurrence.dday, title: d.title };
    }
  });

  if (!nearest) { pill.textContent = "등록된 기념일이 없어"; return; }
  pill.innerHTML = nearest.dday === 0
    ? `오늘! <b>${escapeHtml(nearest.title)}</b> 🎉`
    : `<b>D-${nearest.dday}</b> ${escapeHtml(nearest.title)}`;
}

function nextOccurrence(annivData, today) {
  const { month, day, recurring, year } = annivData;
  if (recurring === false) {
    if (!year) return null;
    const d = stripTime(new Date(year, month - 1, day));
    if (d < today) return null;
    return { date: d, dday: diffDays(today, d) };
  }
  let candidate = stripTime(new Date(today.getFullYear(), month - 1, day));
  if (candidate < today) candidate = stripTime(new Date(today.getFullYear() + 1, month - 1, day));
  return { date: candidate, dday: diffDays(today, candidate) };
}

let activeScheduleId = null;

async function loadNextDateEvent() {
  const titleEl = document.getElementById("nextDateTitle");
  const subEl = document.getElementById("nextDateSub");
  const partEl = document.getElementById("nextDateParticipants");
  const todayStr = new Date().toISOString().slice(0, 10);

  const q = query(
    collection(db, "schedule"),
    where("isDateEvent", "==", true),
    where("date", ">=", todayStr),
    orderBy("date", "asc"),
    limit(1)
  );
  const snap = await getDocs(q);

  if (snap.empty) {
    titleEl.textContent = "예정된 데이트가 없어";
    subEl.textContent = "";
    partEl.innerHTML = "";
    activeScheduleId = null;
    return;
  }

  const docSnap = snap.docs[0];
  const d = docSnap.data();
  activeScheduleId = docSnap.id;

  const dday = diffDays(stripTime(new Date()), stripTime(new Date(d.date)));
  titleEl.textContent = d.title;
  subEl.textContent = dday === 0 ? `오늘! ${d.time || ""}` : `D-${dday} · ${d.date} ${d.time || ""}`;

  partEl.innerHTML = (d.participants || []).map(p =>
    `<span class="participant-chip ${colorKeyByName(p.name)}">${escapeHtml(p.name)}</span>`
  ).join("");
}

document.getElementById("nextDateCard").addEventListener("click", () => {
  if (!activeScheduleId || !currentUser) return;
  openJoinModal(activeScheduleId);
});

function initStatusBoard() {
  const board = document.getElementById("statusBoard");
  onSnapshot(collection(db, "profiles"), (snap) => {
    board.innerHTML = "";
    snap.forEach(docSnap => {
      const d = docSnap.data();
      const card = document.createElement("div");
      card.className = `status-card ${d.colorKey}`;
      const timeAgo = d.status?.updatedAt ? formatTimeAgo(d.status.updatedAt.toDate()) : "";
      card.innerHTML = `
        <div class="s-name">${escapeHtml(d.name)}</div>
        <div class="s-emoji">${d.status?.emoji || "🙂"}</div>
        <div class="s-text">${escapeHtml(d.status?.text) || "상태 없음"}</div>
        <div class="s-time">${timeAgo}</div>
      `;
      if (currentUser && docSnap.id === currentUser.uid) {
        card.addEventListener("click", openStatusModal);
      }
      board.appendChild(card);
    });
  });
}

function openStatusModal() {
  document.getElementById("statusEmojiInput").value = "";
  document.getElementById("statusTextInput").value = "";
  document.getElementById("statusModal").classList.remove("hidden");
}

document.getElementById("statusCancelBtn").addEventListener("click", () => {
  document.getElementById("statusModal").classList.add("hidden");
});

document.getElementById("statusSaveBtn").addEventListener("click", async () => {
  if (!currentUser) return;
  const emoji = document.getElementById("statusEmojiInput").value.trim();
  const text = document.getElementById("statusTextInput").value.trim();
  await updateDoc(doc(db, "profiles", currentUser.uid), {
    status: { emoji, text, updatedAt: Timestamp.now() }
  });
  document.getElementById("statusModal").classList.add("hidden");
});

function initHome() {
  renderToday();
  loadNearestAnniversary();
  loadNextDateEvent();
  initStatusBoard();
}

// ================= 일정 =================
function initSchedule() {
  const list = document.getElementById("scheduleList");
  attachInteractionDelegation(list, "schedule");

  document.getElementById("scheduleAddBtn").addEventListener("click", async () => {
    const title = document.getElementById("scheduleTitleInput").value.trim();
    const date = document.getElementById("scheduleDateInput").value;
    const time = document.getElementById("scheduleTimeInput").value;
    const isDateEvent = document.getElementById("scheduleIsDateInput").checked;
    if (!title || !date || !currentUser) return;
    await addDoc(collection(db, "schedule"), {
      title, date, time, isDateEvent,
      author: currentUser.name, authorUid: currentUser.uid,
      participants: [], createdAt: Timestamp.now()
    });
    document.getElementById("scheduleTitleInput").value = "";
    document.getElementById("scheduleDateInput").value = "";
    document.getElementById("scheduleTimeInput").value = "";
    document.getElementById("scheduleIsDateInput").checked = false;
    loadNextDateEvent();
  });

  const q = query(collection(db, "schedule"), orderBy("date", "asc"));
  onSnapshot(q, (snap) => {
    list.innerHTML = "";
    snap.forEach(docSnap => {
      const d = docSnap.data();
      const id = docSnap.id;
      const joined = currentUser && (d.participants || []).some(p => p.uid === currentUser.uid);
      const card = document.createElement("div");
      card.className = "item-card";
      card.innerHTML = `
        ${d.authorUid === currentUser?.uid ? `<button class="item-delete" data-id="${id}">삭제</button>` : ""}
        <div class="item-title">${d.isDateEvent ? "💜 " : ""}${escapeHtml(d.title)}</div>
        <div class="item-meta">${authorBadge(d.author, colorKeyByName(d.author))}<span>${d.date} ${d.time || ""}</span></div>
        <div class="participant-row">
          ${(d.participants || []).map(p => `<span class="participant-chip ${colorKeyByName(p.name)}">${escapeHtml(p.name)}</span>`).join("")}
        </div>
        ${d.isDateEvent ? `<button class="btn ${joined ? "btn-outline" : "btn-primary"} join-toggle-btn" data-id="${id}" data-joined="${joined}" style="margin-top:10px;">${joined ? "참여 취소" : "참여할래"}</button>` : ""}
      `;
      list.appendChild(card);
    });
  });

  list.addEventListener("click", async (e) => {
    const btn = e.target.closest(".join-toggle-btn");
    if (!btn || !currentUser) return;
    const id = btn.dataset.id;
    const joined = btn.dataset.joined === "true";
    if (joined) {
      const ref_ = doc(db, "schedule", id);
      const snap = await getDoc(ref_);
      const entry = (snap.data().participants || []).find(p => p.uid === currentUser.uid);
      if (entry) await updateDoc(ref_, { participants: arrayRemove(entry) });
      loadNextDateEvent();
    } else {
      openJoinModal(id);
    }
  });
}

// ================= 위시 =================
function initWish() {
  const list = document.getElementById("wishList");
  attachInteractionDelegation(list, "wishlist");

  document.getElementById("wishAddBtn").addEventListener("click", async () => {
    const title = document.getElementById("wishTitleInput").value.trim();
    const memo = document.getElementById("wishMemoInput").value.trim();
    if (!title || !currentUser) return;
    await addDoc(collection(db, "wishlist"), {
      title, memo, author: currentUser.name, authorUid: currentUser.uid,
      likes: [], comments: [], createdAt: Timestamp.now()
    });
    document.getElementById("wishTitleInput").value = "";
    document.getElementById("wishMemoInput").value = "";
  });

  const q = query(collection(db, "wishlist"), orderBy("createdAt", "desc"));
  onSnapshot(q, (snap) => {
    list.innerHTML = "";
    snap.forEach(docSnap => {
      const d = docSnap.data();
      const id = docSnap.id;
      const card = document.createElement("div");
      card.className = "item-card";
      card.innerHTML = `
        ${d.authorUid === currentUser?.uid ? `<button class="item-delete" data-id="${id}">삭제</button>` : ""}
        <div class="item-title">${escapeHtml(d.title)}</div>
        <div class="item-meta">${authorBadge(d.author, colorKeyByName(d.author))}</div>
        ${d.memo ? `<div class="item-body">${escapeHtml(d.memo)}</div>` : ""}
        ${reactionRowHTML("wishlist", id, d.likes || [], d.comments || [])}
      `;
      list.appendChild(card);
    });
  });
}

// ================= 데이트기록 =================
function initDatelog() {
  const list = document.getElementById("datelogList");
  attachInteractionDelegation(list, "datelog");
  populateCheckboxGroup(document.getElementById("datelogParticipantCheckboxes"), "datelog-participant-cb");

  document.getElementById("datelogAddBtn").addEventListener("click", async () => {
    const title = document.getElementById("datelogTitleInput").value.trim();
    const date = document.getElementById("datelogDateInput").value;
    const body = document.getElementById("datelogBodyInput").value.trim();
    if (!title || !currentUser) return;
    const participants = [...document.querySelectorAll(".datelog-participant-cb:checked")]
      .map(cb => ({ uid: cb.value, name: cb.dataset.name }));
    const files = document.getElementById("datelogPhotoInput").files;
    const photos = await uploadPhotos(files, `datelog/${Date.now()}`);
    await addDoc(collection(db, "datelog"), {
      title, date, body, participants, photos,
      author: currentUser.name, authorUid: currentUser.uid,
      createdAt: Timestamp.now()
    });
    document.getElementById("datelogTitleInput").value = "";
    document.getElementById("datelogDateInput").value = "";
    document.getElementById("datelogBodyInput").value = "";
    document.getElementById("datelogPhotoInput").value = "";
    document.querySelectorAll(".datelog-participant-cb").forEach(cb => cb.checked = false);
  });

  const q = query(collection(db, "datelog"), orderBy("date", "desc"));
  onSnapshot(q, (snap) => {
    list.innerHTML = "";
    snap.forEach(docSnap => {
      const d = docSnap.data();
      const id = docSnap.id;
      const card = document.createElement("div");
      card.className = "item-card";
      card.innerHTML = `
        ${d.authorUid === currentUser?.uid ? `<button class="item-delete" data-id="${id}">삭제</button>` : ""}
        <div class="item-title">${escapeHtml(d.title)}</div>
        <div class="item-meta">${authorBadge(d.author, colorKeyByName(d.author))}<span>${d.date}</span></div>
        <div class="participant-row">${(d.participants || []).map(p => `<span class="participant-chip ${colorKeyByName(p.name)}">${escapeHtml(p.name)}</span>`).join("")}</div>
        ${renderPhotoGrid(d.photos)}
        <div class="item-body">${escapeHtml(d.body)}</div>
      `;
      list.appendChild(card);
    });
  });
}

// ================= 편지 =================
let letterFilterUid = null;
let latestLetterDocs = [];

function initLetter() {
  const list = document.getElementById("letterList");
  populateCheckboxGroup(document.getElementById("letterRecipientCheckboxes"), "letter-recipient-cb");

  document.getElementById("letterAllRecipientsBox").addEventListener("change", (e) => {
    document.querySelectorAll(".letter-recipient-cb").forEach(cb => cb.checked = e.target.checked);
  });

  document.getElementById("letterLockToggle").addEventListener("change", (e) => {
    document.getElementById("letterUnlockDateInput").classList.toggle("hidden", !e.target.checked);
  });

  document.getElementById("letterAddBtn").addEventListener("click", async () => {
    const title = document.getElementById("letterTitleInput").value.trim();
    const body = document.getElementById("letterBodyInput").value.trim();
    if (!title || !body || !currentUser) return;

    let recipients = [...document.querySelectorAll(".letter-recipient-cb:checked")].map(cb => cb.value);
    if (recipients.length === 0) recipients = allProfiles.map(p => p.uid); // 아무도 안 골랐으면 전체로 처리

    const locked = document.getElementById("letterLockToggle").checked;
    const unlockDateVal = document.getElementById("letterUnlockDateInput").value;
    const unlockAt = locked && unlockDateVal ? Timestamp.fromDate(new Date(unlockDateVal)) : null;

    const letterRef = await addDoc(collection(db, "letters"), {
      previewTitle: title, author: currentUser.name, authorUid: currentUser.uid,
      recipients, unlockAt, createdAt: Timestamp.now()
    });
    await setDoc(doc(db, "letters", letterRef.id, "private", "content"), { body });

    document.getElementById("letterTitleInput").value = "";
    document.getElementById("letterBodyInput").value = "";
    document.getElementById("letterAllRecipientsBox").checked = false;
    document.getElementById("letterLockToggle").checked = false;
    document.getElementById("letterUnlockDateInput").value = "";
    document.getElementById("letterUnlockDateInput").classList.add("hidden");
    document.querySelectorAll(".letter-recipient-cb").forEach(cb => cb.checked = false);
  });

  renderLetterFilterRow();

  list.addEventListener("click", async (e) => {
    const del = e.target.closest(".item-delete");
    if (del) {
      if (confirm("편지를 삭제할까?")) {
        await deleteDoc(doc(db, "letters", del.dataset.id));
        await deleteDoc(doc(db, "letters", del.dataset.id, "private", "content")).catch(() => {});
      }
    }
  });

  const q = query(collection(db, "letters"), orderBy("createdAt", "desc"));
  onSnapshot(q, (snap) => {
    latestLetterDocs = snap.docs;
    renderLetterList();
  });
}

function renderLetterFilterRow() {
  const row = document.getElementById("letterFilterRow");
  row.innerHTML = `<button class="filter-chip active" data-uid="">전체</button>` +
    allProfiles.map(p => `<button class="filter-chip" data-uid="${p.uid}">${escapeHtml(p.name)}</button>`).join("");
  row.addEventListener("click", (e) => {
    const chip = e.target.closest(".filter-chip");
    if (!chip) return;
    row.querySelectorAll(".filter-chip").forEach(c => c.classList.remove("active"));
    chip.classList.add("active");
    letterFilterUid = chip.dataset.uid || null;
    renderLetterList();
  });
}

function renderLetterList() {
  const list = document.getElementById("letterList");
  list.innerHTML = "";
  latestLetterDocs.forEach(docSnap => {
    const d = docSnap.data();
    const id = docSnap.id;
    if (letterFilterUid && !(d.recipients || []).includes(letterFilterUid)) return;

    const isUnlocked = !d.unlockAt || d.unlockAt.toDate() <= new Date() || d.authorUid === currentUser?.uid;
    const card = document.createElement("div");
    card.className = "item-card";
    card.innerHTML = `
      ${d.authorUid === currentUser?.uid ? `<button class="item-delete" data-id="${id}">삭제</button>` : ""}
      <div class="item-title">${isUnlocked ? "" : "🔒 "}${escapeHtml(d.previewTitle)}</div>
      <div class="item-meta">
        ${authorBadge(d.author, colorKeyByName(d.author))} →
        ${(d.recipients || []).map(uid => {
          const p = allProfiles.find(pr => pr.uid === uid);
          return p ? `<span class="participant-chip ${p.colorKey}">${escapeHtml(p.name)}</span>` : "";
        }).join("")}
      </div>
      ${!isUnlocked
        ? `<div class="lock-badge">🔒 ${formatUnlockDate(d.unlockAt)}에 열려</div>`
        : `<div class="item-body letter-content" data-id="${id}">불러오는 중...</div>`}
    `;
    list.appendChild(card);
    if (isUnlocked) loadLetterContent(id, card.querySelector(".letter-content"));
  });
}

async function loadLetterContent(id, el) {
  try {
    const snap = await getDoc(doc(db, "letters", id, "private", "content"));
    el.textContent = snap.exists() ? snap.data().body : "";
  } catch (e) {
    el.textContent = "아직 볼 수 없어";
  }
}

function formatUnlockDate(ts) {
  const d = ts.toDate();
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

// ================= 자유게시판 =================
function initBoard() {
  const list = document.getElementById("boardList");
  attachInteractionDelegation(list, "board");

  document.getElementById("boardAddBtn").addEventListener("click", async () => {
    const title = document.getElementById("boardTitleInput").value.trim();
    const body = document.getElementById("boardBodyInput").value.trim();
    if (!title || !currentUser) return;
    const files = document.getElementById("boardPhotoInput").files;
    const photos = await uploadPhotos(files, `board/${Date.now()}`);
    await addDoc(collection(db, "board"), {
      title, body, photos, author: currentUser.name, authorUid: currentUser.uid,
      likes: [], comments: [], createdAt: Timestamp.now()
    });
    document.getElementById("boardTitleInput").value = "";
    document.getElementById("boardBodyInput").value = "";
    document.getElementById("boardPhotoInput").value = "";
  });

  const q = query(collection(db, "board"), orderBy("createdAt", "desc"));
  onSnapshot(q, (snap) => {
    list.innerHTML = "";
    snap.forEach(docSnap => {
      const d = docSnap.data();
      const id = docSnap.id;
      const card = document.createElement("div");
      card.className = "item-card";
      card.innerHTML = `
        ${d.authorUid === currentUser?.uid ? `<button class="item-delete" data-id="${id}">삭제</button>` : ""}
        <div class="item-title">${escapeHtml(d.title)}</div>
        <div class="item-meta">${authorBadge(d.author, colorKeyByName(d.author))}</div>
        ${renderPhotoGrid(d.photos)}
        <div class="item-body">${escapeHtml(d.body)}</div>
        ${reactionRowHTML("board", id, d.likes || [], d.comments || [])}
      `;
      list.appendChild(card);
    });
  });
}

// ================= 초기화 =================
async function initApp() {
  await loadAllProfiles();
  initHome();
  initSchedule();
  initWish();
  initDatelog();
  initLetter();
  initBoard();
}

renderToday();
