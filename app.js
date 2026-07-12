(function(){
  // iOS 사파리는 이게 없으면 버튼 :active(눌림) CSS가 탭 했을 때 거의 안 켜짐
  document.addEventListener('touchstart', function(){}, {passive:true});

  const genId = () => Date.now().toString(36) + Math.random().toString(36).slice(2,7);

  const firebaseConfig = {
    apiKey: "AIzaSyDitp8XR42laZMI3egD86NJPhQJyJggeh8",
    authDomain: "baek-sisters.firebaseapp.com",
    projectId: "baek-sisters",
    storageBucket: "baek-sisters.firebasestorage.app",
    messagingSenderId: "446206353039",
    appId: "1:446206353039:web:d4e780fa2f8873dd2f5afa"
  };
  firebase.initializeApp(firebaseConfig);
  const db = firebase.firestore();
  const storage = firebase.storage();

db.enablePersistence()
    .catch((err) => {
      if (err.code == 'failed-precondition') {
        console.warn('여러 탭이 열려 있어 오프라인 모드를 켤 수 없어.');
      } else if (err.code == 'unimplemented') {
        console.warn('이 브라우저는 오프라인 모드를 지원하지 않아.');
      }
    });
  
  let identity = null;
  let schedule = [], wishes = [], dateLogs = [], letters = [], boards = [], anniversaries = [];
  let profiles = {}; // { name: { colorKey, status:{text,emoji,updatedAt} } }
  let pendingWishPhotos = [], pendingDateLogPhotos = [], pendingLetterPhotos = [], pendingBoardPhotos = [];
  let pendingDateLogGeo = null;
  let searchQuery = '';

  // 4인 신원 체계
  const PERSON_COLOR = { '소정':'yellow', '지수':'red', '운빈':'green', '운경':'blue' };
  const ALL_NAMES = ['소정','지수','운빈','운경'];
  // 코드 새로 줄 때마다 이 값 올림 - 홈 화면 맨 아래에 표시돼서, 최신 버전이 실제로
  // 적용됐는지 앱만 열어봐도 바로 확인할 수 있게 해둠.
  const APP_VERSION = '2026.07.13-4';
  function colorKeyOf(name){ return PERSON_COLOR[name] || 'yellow'; }
  
  async function searchLocations(query){
    if(!query) return [];
    try{
      const callable = firebase.app().functions('asia-northeast3').httpsCallable('geocodePlace');
      const result = await callable({ query });
      return (result.data && result.data.results) || [];
    }catch(e){ console.error('위치 검색 실패', e); return []; }
  }

function resizeImage(file){
    return new Promise((resolve, reject)=>{
      const reader = new FileReader();
      reader.onload = (e)=>{
        const img = new Image();
        img.onload = ()=>{
          let w = img.width, h = img.height;
          const maxDim = 900;
          if(w > maxDim || h > maxDim){
            if(w > h){ h = Math.round(h * maxDim / w); w = maxDim; }
            else { w = Math.round(w * maxDim / h); h = maxDim; }
          }
          const canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, w, h);
          
          // 파일 원본이 PNG인지 확인!
          const isPng = file.type === 'image/png';
          
          // PNG면 투명도 유지를 위해 PNG로, 아니면 용량을 위해 JPEG로 설정
          const outputType = isPng ? 'image/png' : 'image/jpeg';
          const outputQuality = isPng ? undefined : 0.55; // PNG는 화질 옵션이 무시됨

          canvas.toBlob((blob) => {
            if(!blob) return reject('이미지 변환 실패');
            resolve({
              url: URL.createObjectURL(blob), // 화면 미리보기용 가짜 URL
              blob: blob // Storage 업로드용 진짜 파일 데이터
            });
          }, outputType, outputQuality);
        };
        img.onerror = reject;
        img.src = e.target.result;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }
  
  function revokePendingPhotoUrls(photosArray){
    (photosArray || []).forEach(p => {
      if(p && typeof p !== 'string' && p.url) URL.revokeObjectURL(p.url);
    });
  }

  function renderPhotoPreviewGrid(wrapId, getPhotos, setPhotos){
    const wrap = document.getElementById(wrapId);
    const photos = getPhotos();
    if(!photos || photos.length === 0){
      wrap.innerHTML = '';
      wrap.classList.add('hidden');
      return;
    }
    wrap.classList.remove('hidden');
    wrap.innerHTML = photos.map((p,i)=>{
      const src = typeof p === 'string' ? p : p.url; // 기존 사진은 string, 새 사진은 object
      return `
        <div class="photo-thumb">
          <img src="${src}">
          <button type="button" class="rm-photo-thumb" data-idx="${i}">✕</button>
        </div>
      `;
    }).join('');
    
    wrap.querySelectorAll('.rm-photo-thumb').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        const idx = Number(btn.dataset.idx);
        const updated = getPhotos().slice();
        const removed = updated.splice(idx, 1)[0];
        
        // 브라우저 메모리 누수 방지
        if(typeof removed !== 'string' && removed.url) URL.revokeObjectURL(removed.url); 
        
        setPhotos(updated);
        renderPhotoPreviewGrid(wrapId, getPhotos, setPhotos);
      });
    });
  }

async function uploadPhotos(photosArray, onProgress) {
    const newPhotos = photosArray.filter(p => p && p.blob);
    const totalBytes = newPhotos.reduce((sum, p) => sum + p.blob.size, 0);
    const transferredMap = new Map();

    function reportProgress(){
      if(!onProgress || totalBytes === 0) return;
      let transferred = 0;
      transferredMap.forEach(v => transferred += v);
      onProgress(Math.min(100, Math.round((transferred / totalBytes) * 100)));
    }

    const uploadPromises = photosArray.map(async (p) => {
      if (typeof p === 'string') {
        // 이미 저장되어 있던 기존 사진 (수정 모드일 때)
        return p;
      } else if (p && p.blob) {
        // 새로 등록하는 사진 -> Storage 업로드
        // 파일 타입이 image/png면 확장자를 png로, 아니면 jpg로 설정!
        const ext = p.blob.type === 'image/png' ? 'png' : 'jpg';
        const fileName = `images/${identity || 'user'}_${Date.now()}_${Math.random().toString(36).substr(2,5)}.${ext}`;

        const ref = storage.ref().child(fileName);
        const task = ref.put(p.blob);
        task.on('state_changed', (snap)=>{
          transferredMap.set(p, snap.bytesTransferred);
          reportProgress();
        });
        await task;
        transferredMap.set(p, p.blob.size);
        reportProgress();
        return await ref.getDownloadURL();
      }
      return null;
    });
    const results = await Promise.all(uploadPromises);
    return results.filter(url => url !== null);
  }
  
// Storage에서 실제 이미지 파일 삭제하는 함수
  async function deletePhotosFromStorage(photosArray) {
    if (!photosArray || photosArray.length === 0) return;
    for (const url of photosArray) {
      try {
        // Firebase Storage URL인 경우에만 삭제 시도
        if (typeof url === 'string' && url.includes('firebasestorage')) {
          const ref = storage.refFromURL(url); // URL로 파일 위치 바로 찾기
          await ref.delete(); // 실제 파일 삭제!
        }
      } catch (e) {
        console.error('Storage 이미지 삭제 실패:', e);
      }
    }
  }
  
  function setupPhotoPicker(inputId, btnId, wrapId, getPhotos, setPhotos){
    const input = document.getElementById(inputId);
    document.getElementById(btnId).addEventListener('click', ()=> input.click());
    input.addEventListener('change', async ()=>{
      if(!input.files || !input.files.length) return;
      showLoadingOverlay('사진 처리 중이야...<br>잠시만 기다려줘');
      try{
        const files = Array.from(input.files);
        const newPhotos = await Promise.all(files.map(f=>resizeImage(f)));
        setPhotos(getPhotos().concat(newPhotos));
        renderPhotoPreviewGrid(wrapId, getPhotos, setPhotos);
      }catch(e){ console.error('사진 처리 실패', e); }
      finally{ hideLoadingOverlay(); }
      input.value = '';
    });
  }

  function setupAutoGrow(textareaId, maxHeight){
    const el = document.getElementById(textareaId);
    if(!el) return;
    const maxH = maxHeight || 240;
    function resize(){
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, maxH) + 'px';
    }
    el.addEventListener('input', resize);
    el._autoGrowResize = resize;
    resize();
  }

  function localDateStr(d){
    d = d || new Date();
    const y = d.getFullYear(), m = String(d.getMonth()+1).padStart(2,'0'), day = String(d.getDate()).padStart(2,'0');
    return `${y}-${m}-${day}`;
  }
  function fmtDate(d){
    if(!d) return {day:'-', mon:''};
    const dt = new Date(d + 'T00:00:00');
    return { day: dt.getDate(), mon: (dt.getMonth()+1) + '월' };
  }
  function fmtShortDate(d){
    if(!d) return '';
    const dt = new Date(d + 'T00:00:00');
    return `${dt.getMonth()+1}.${dt.getDate()}`;
  }
  // 타임스탬프 -> "7.20 15:30" 형태 (편지 잠금 해제 시각 표시용)
  function fmtShortDateTime(ts){
    if(!ts) return '';
    const d = new Date(ts);
    const hh = String(d.getHours()).padStart(2,'0');
    const mm = String(d.getMinutes()).padStart(2,'0');
    return `${d.getMonth()+1}.${d.getDate()} ${hh}:${mm}`;
  }
  // 타임스탬프 -> <input type="datetime-local"> 값 형태 ("YYYY-MM-DDTHH:mm", 로컬 시간 기준)
  function toDateTimeLocalValue(ts){
    if(!ts) return '';
    const d = new Date(ts);
    const y = d.getFullYear(), m = String(d.getMonth()+1).padStart(2,'0'), day = String(d.getDate()).padStart(2,'0');
    const hh = String(d.getHours()).padStart(2,'0'), mm = String(d.getMinutes()).padStart(2,'0');
    return `${y}-${m}-${day}T${hh}:${mm}`;
  }
  function isPast(item){
    const d = item && item.endDate ? item.endDate : (item && item.date);
    if(!d) return false;
    const today = new Date(); today.setHours(0,0,0,0);
    return new Date(d + 'T00:00:00') < today;
  }
  function itemCoversDate(item, dateStr){
    const end = item.endDate || item.date;
    return dateStr >= item.date && dateStr <= end;
  }
  function formatTimeKR(t){
    if(!t) return '';
    const [h,m] = t.split(':').map(Number);
    const period = h < 12 ? '오전' : '오후';
    let h12 = h % 12; if(h12 === 0) h12 = 12;
    return `${period} ${h12}:${String(m).padStart(2,'0')}`;
  }
  function formatScheduleRange(item){
    const startLabel = fmtShortDate(item.date) + (item.time ? ` ${formatTimeKR(item.time)}` : '');
    if(item.endDate && item.endDate !== item.date){
      const endLabel = fmtShortDate(item.endDate) + (item.endTime ? ` ${formatTimeKR(item.endTime)}` : '');
      return `${startLabel} ~ ${endLabel}`;
    }
    if(item.endTime && item.endTime !== item.time){
      return `${startLabel} ~ ${formatTimeKR(item.endTime)}`;
    }
    return startLabel;
  }
  function formatDateTimeKR(ts){
    const dt = new Date(ts);
    const y = dt.getFullYear(), m = String(dt.getMonth()+1).padStart(2,'0'), d = String(dt.getDate()).padStart(2,'0');
    let h = dt.getHours(); const mm = String(dt.getMinutes()).padStart(2,'0');
    const period = h < 12 ? '오전' : '오후'; let h12 = h % 12; if(h12 === 0) h12 = 12;
    return `${y}.${m}.${d} ${period} ${h12}:${mm}`;
  }
  function authorTagHTML(author){
    if(!author || !PERSON_COLOR[author]) return '';
    return `<span class="author-tag color-${colorKeyOf(author)}">${author}</span>`;
  }
  function escapeHTML(s){
    return (s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  // 댓글 버튼 옆 숫자용 - 댓글 개수 + 그 안의 답글 개수까지 다 합쳐서 셈
  // (단, "삭제된 댓글이야"로 표시되는 소프트 삭제된 댓글 자체는 개수에서 빠짐 - 그 밑의 답글은 그대로 셈)
  function totalCommentCount(comments){
    const list = comments || [];
    return list.reduce((sum, c) => sum + (c.deleted ? 0 : 1) + ((c.replies || []).length), 0);
  }
  function pixelHeartSVG(filled, size, colorOverride){
    size = size || 15;
    const c = colorOverride || (filled ? '#9B7FE0' : '#D8C7CE');
    return `<svg viewBox="0 0 7 6" width="${size}" height="${size*6/7}" shape-rendering="crispEdges" style="display:inline-block;vertical-align:middle;"><rect x="1" y="0" width="2" height="1" fill="${c}"/><rect x="4" y="0" width="2" height="1" fill="${c}"/><rect x="0" y="1" width="7" height="1" fill="${c}"/><rect x="0" y="2" width="7" height="1" fill="${c}"/><rect x="1" y="3" width="5" height="1" fill="${c}"/><rect x="2" y="4" width="3" height="1" fill="${c}"/><rect x="3" y="5" width="1" height="1" fill="${c}"/></svg>`;
  }
  function pixelChatSVG(){
    return `<svg viewBox="0 0 7 6" width="15" height="13" shape-rendering="crispEdges" style="display:inline-block;vertical-align:middle;"><rect x="1" y="0" width="5" height="1" fill="currentColor"/><rect x="0" y="1" width="1" height="1" fill="currentColor"/><rect x="6" y="1" width="1" height="1" fill="currentColor"/><rect x="0" y="2" width="1" height="1" fill="currentColor"/><rect x="2" y="2" width="1" height="1" fill="currentColor"/><rect x="4" y="2" width="1" height="1" fill="currentColor"/><rect x="6" y="2" width="1" height="1" fill="currentColor"/><rect x="0" y="3" width="1" height="1" fill="currentColor"/><rect x="6" y="3" width="1" height="1" fill="currentColor"/><rect x="1" y="4" width="5" height="1" fill="currentColor"/><rect x="2" y="5" width="1" height="1" fill="currentColor"/></svg>`;
  }
  function pixelEditSVG(){
    return `<svg viewBox="0 0 7 7" width="15" height="15" shape-rendering="crispEdges" style="display:inline-block;vertical-align:middle;"><rect x="5" y="0" width="2" height="1" fill="#FFB3C6"/><rect x="4" y="1" width="2" height="1" fill="#4A3548"/><rect x="3" y="2" width="2" height="1" fill="#FFC94C"/><rect x="2" y="3" width="2" height="1" fill="#FFC94C"/><rect x="1" y="4" width="2" height="1" fill="#FFC94C"/><rect x="0" y="5" width="2" height="1" fill="#4A3548"/><rect x="0" y="6" width="1" height="1" fill="#4A3548"/></svg>`;
  }
  function linkHost(url){
    try{ return new URL(url).hostname.replace('www.',''); }catch(e){ return url; }
  }
  function isMine(item){
    if(item.author === undefined || item.author === null) return true;
    return item.author === identity;
  }
  function getItemPhotos(item){
    if(item.photos && item.photos.length) return item.photos;
    if(item.photo) return [item.photo];
    return [];
  }
  function cardPhotosHTML(item){
    const photos = getItemPhotos(item);
    if(photos.length === 0) return '';
    return `<div class="card-photos">${photos.map(p=>`<img src="${p}" loading="lazy">`).join('')}</div>`;
  }

// 열려 있는 댓글창 ID를 기억하는 공간 (새로고침 시 닫힘 방지)
  let openCommentSections = new Set();
  let openPostDetails = new Set();
  let openReplyInputs = new Set(); // "col-itemId-commentTs" 형태로 답글 입력창 열림 상태 기억

  // 알림 클릭으로 들어왔을 때 "여기로 스크롤해야 함"을 기억해두는 상태.
  // 한 번 시도하고 끝내는 게 아니라, 화면이 다시 그려질 때마다(데이터 갱신, 탭 전환,
  // 화면이 다시 보이게 될 때 등) 계속 확인해서, 목표를 찾으면 그때 스크롤하고 지움.
  // 재시도 횟수/타이밍에 기대는 것보다 훨씬 끈질기게 작동함.
  let pendingScrollTarget = null; // { itemId, commentTs, replyTs }
  let scrollPollInterval = null; // 폴링 타이머 추적 (성공하면 바로 꺼주기 위함)

  function scrollToEl(el){
    setTimeout(() => {
      el.getBoundingClientRect(); // 스크롤 직전에 강제로 레이아웃 계산을 끝내게 함 (모바일에서 위치 계산이 덜 끝난 채로 스크롤되는 것 방지)
      el.scrollIntoView({behavior:'smooth', block:'center'});
      el.classList.add('search-flash');
      setTimeout(()=> el.classList.remove('search-flash'), 1600);
    }, 200);
  }

  // 스크롤 목표를 찾았을 때(성공) 상태와 폴링 타이머를 한 번에 깔끔하게 정리
  function clearScrollState(){
    pendingScrollTarget = null;
    if(scrollPollInterval){
      clearInterval(scrollPollInterval);
      scrollPollInterval = null;
    }
  }

  function tryConsumePendingScroll(){
    if(!pendingScrollTarget) return;
    const { tab, itemId, commentTs, replyTs } = pendingScrollTarget;
    const card = document.querySelector(`[data-item-id="${itemId}"]`);
    if(!card) return; // 아직 카드가 화면에 없음 - 다음 기회에 다시 확인됨

    const detail = card.querySelector('.post-detail');
    if(detail) detail.classList.remove('hidden');

    if(!commentTs){
      clearScrollState();
      scrollToEl(card);
      return;
    }

    const section = card.querySelector('.comment-section');
    if(section) section.classList.add('active');

    // 답글 알림으로 들어온 거면, 답장하기 편하게 그 댓글의 답글 입력창도 같이 열어줌
    if(replyTs && tab && TAB_TO_COL[tab]){
      const replyKey = `${TAB_TO_COL[tab]}-${itemId}-${commentTs}`;
      const replyRow = document.getElementById(`reply-row-${replyKey}`);
      if(replyRow){
        replyRow.classList.add('active');
        openReplyInputs.add(replyKey);
      }
    }

    const anchorTs = replyTs || commentTs;
    const anchorEl = card.querySelector(`[data-comment-anchor="${anchorTs}"]`);
    if(anchorEl){
      clearScrollState();
      scrollToEl(anchorEl);
    }
    // 특정 댓글/답글을 아직 못 찾았으면 pendingScrollTarget을 그대로 둬서 다음 기회에 재시도
  }

  // 화면이 다시 보이게 되는 걸 알려주는 이벤트들 - 여러 번 호출부에서 등록하지 않고
  // 여기서 한 번만 전역으로 등록해둠 (기명 함수라 중복 등록은 원래도 안 됐지만, 구조상 더 깔끔하게)
  document.addEventListener('visibilitychange', tryConsumePendingScroll);
  window.addEventListener('focus', tryConsumePendingScroll);
  window.addEventListener('pageshow', tryConsumePendingScroll);

  // 댓글창 HTML을 그려주는 공통 함수
  function renderCommentsHTML(item, colName) {
    const comments = item.comments || [];
    const isOpen = openCommentSections.has(`${colName}-${item.id}`);

    const commentListHTML = comments.map(c => {
      const replies = c.replies || [];
      const replyKey = `${colName}-${item.id}-${c.ts}`;
      const isReplyOpen = openReplyInputs.has(replyKey);

      const repliesHTML = replies.map(r => `
        <div class="comment-item reply-item" data-comment-anchor="${r.ts}">
          <span class="c-author color-${colorKeyOf(r.author)}">${r.author}</span>
          <span class="c-text">${escapeHTML(r.text)}</span>
          ${r.author === identity ? `<button class="r-del" data-comment-col="${colName}" data-comment-id="${item.id}" data-parent-ts="${c.ts}" data-reply-ts="${r.ts}">✕</button>` : ''}
          <div class="c-time">${formatDateTimeKR(r.ts)}</div>
        </div>
      `).join('');

      // 삭제된 댓글 - 답글은 그대로 살려두고, 댓글 자리엔 안내 문구만
      if (c.deleted) {
        return `
        <div class="comment-item comment-deleted" data-comment-anchor="${c.ts}">
          <span class="c-text c-deleted-text">삭제된 댓글이야</span>
          ${replies.length > 0 ? `<div class="reply-list">${repliesHTML}</div>` : ''}
        </div>
      `;
      }

      return `
      <div class="comment-item" data-comment-anchor="${c.ts}">
        <span class="c-author color-${colorKeyOf(c.author)}">${c.author}</span>
        <span class="c-text">${escapeHTML(c.text)}</span>
        ${c.author === identity ? `<button class="c-del" data-comment-col="${colName}" data-comment-id="${item.id}" data-comment-ts="${c.ts}">✕</button>` : ''}
        <div class="c-time">
          ${formatDateTimeKR(c.ts)}
          <button type="button" class="reply-toggle-btn" data-reply-toggle-col="${colName}" data-reply-toggle-id="${item.id}" data-reply-toggle-ts="${c.ts}">답글 달기</button>
        </div>
        ${replies.length > 0 ? `<div class="reply-list">${repliesHTML}</div>` : ''}
        <div class="reply-input-row ${isReplyOpen ? 'active' : ''}" id="reply-row-${colName}-${item.id}-${c.ts}">
          <input type="text" placeholder="답글을 입력해 봐" id="r-input-${colName}-${item.id}-${c.ts}" onkeypress="if(event.key==='Enter') document.getElementById('r-btn-${colName}-${item.id}-${c.ts}').click();">
          <button id="r-btn-${colName}-${item.id}-${c.ts}" class="r-submit" data-reply-submit-col="${colName}" data-reply-submit-id="${item.id}" data-reply-submit-parent-ts="${c.ts}">작성</button>
        </div>
      </div>
    `;
    }).join('');

    return `
      <div class="comment-section ${isOpen ? 'active' : ''}" id="comments-${colName}-${item.id}">
        <div class="comment-list">
          ${comments.length > 0 ? commentListHTML : '<div style="font-size:11px; color:#8A7A86; text-align:center; padding: 4px 0;">첫 번째 댓글을 남겨봐! 🐶</div>'}
        </div>
        <div class="comment-input-row">
          <input type="text" placeholder="댓글을 입력해 봐" id="c-input-${colName}-${item.id}" onkeypress="if(event.key==='Enter') document.getElementById('c-btn-${colName}-${item.id}').click();">
          <button id="c-btn-${colName}-${item.id}" class="c-submit" data-comment-submit-col="${colName}" data-comment-submit-id="${item.id}">작성</button>
        </div>
      </div>
    `;
  }
  
  // ---- 연/월별 그룹 정리 (데이트기록/편지/스탬프 공용) ----
  function renderGroupedByTime(containerId, items, getTs, cardRenderer, expandedSet, emptyHTML){
    const container = document.getElementById(containerId);
    if(items.length === 0){
      container.innerHTML = emptyHTML;
      return;
    }
    const now = new Date();
    const curYear = now.getFullYear(), curMonth = now.getMonth();
    const currentMonthItems = [];
    const monthGroups = {};
    const yearGroups = {};

    items.forEach(item=>{
      const d = new Date(getTs(item));
      const y = d.getFullYear(), m = d.getMonth();
      if(y === curYear){
        if(m === curMonth) currentMonthItems.push(item);
        else { (monthGroups[m] = monthGroups[m] || []).push(item); }
      } else {
        (yearGroups[y] = yearGroups[y] || []).push(item);
      }
    });

    let html = currentMonthItems.map(cardRenderer).join('');

    Object.keys(monthGroups).map(Number).sort((a,b)=>b-a).forEach(m=>{
      const key = `month-${m}`;
      const isOpen = expandedSet.has(key);
      html += `<button class="group-toggle" data-group-key="${key}" data-container="${containerId}">${m+1}월 <span class="group-count">${monthGroups[m].length}개</span> ${isOpen?'▲':'▼'}</button>`;
      html += `<div class="group-content ${isOpen?'':'hidden'}" data-group-content="${key}">${monthGroups[m].map(cardRenderer).join('')}</div>`;
    });

    Object.keys(yearGroups).map(Number).sort((a,b)=>b-a).forEach(y=>{
      const key = `year-${y}`;
      const isOpen = expandedSet.has(key);
      html += `<button class="group-toggle" data-group-key="${key}" data-container="${containerId}">${y}년 <span class="group-count">${yearGroups[y].length}개</span> ${isOpen?'▲':'▼'}</button>`;
      html += `<div class="group-content ${isOpen?'':'hidden'}" data-group-content="${key}">${yearGroups[y].map(cardRenderer).join('')}</div>`;
    });

    container.innerHTML = html;

    container.querySelectorAll('[data-group-key]').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        const key = btn.dataset.groupKey;
        const content = container.querySelector(`[data-group-content="${key}"]`);
        const isOpen = expandedSet.has(key);
        if(isOpen){ expandedSet.delete(key); content.classList.add('hidden'); }
        else { expandedSet.add(key); content.classList.remove('hidden'); }
        btn.innerHTML = btn.innerHTML.replace(isOpen ? '▲' : '▼', isOpen ? '▼' : '▲');
      });
    });
  }
  let dateLogExpandedGroups = new Set();
  let letterExpandedGroups = new Set();
  let boardExpandedGroups = new Set();

  // ---- 사진 확대뷰 (핀치줌 / 팬 / 스와이프 넘기기 / 더블탭) ----
  (function(){
    const lightbox = document.getElementById('photoLightbox');
    const stage = document.getElementById('lightboxStage');
    const img = document.getElementById('lightboxImg');
    const closeBtn = document.getElementById('lightboxClose');
    const prevBtn = document.getElementById('lightboxPrev');
    const nextBtn = document.getElementById('lightboxNext');
    const counter = document.getElementById('lightboxCounter');

    let scale = 1, panX = 0, panY = 0;
    let startScale = 1, startDist = 0;
    let startTouchX = 0, startTouchY = 0;
    let isPanning = false, isPinching = false;
    let lastTapTime = 0;
    let swipeStartX = 0, swipeStartY = 0, swipeActive = false;

    let currentPhotos = [];
    let currentIndex = 0;

    function applyTransform(){
      img.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
    }
    function resetTransform(){
      scale = 1; panX = 0; panY = 0; applyTransform();
    }
    function updateNav(){
      const multi = currentPhotos.length > 1;
      prevBtn.classList.toggle('hidden', !multi || currentIndex === 0);
      nextBtn.classList.toggle('hidden', !multi || currentIndex === currentPhotos.length - 1);
      counter.classList.toggle('hidden', !multi);
      if(multi) counter.textContent = `${currentIndex + 1} / ${currentPhotos.length}`;
    }
    function showCurrentPhoto(){
      img.src = currentPhotos[currentIndex];
      resetTransform();
      updateNav();
    }
    function goNext(){
      if(currentIndex < currentPhotos.length - 1){ currentIndex++; showCurrentPhoto(); }
    }
    function goPrev(){
      if(currentIndex > 0){ currentIndex--; showCurrentPhoto(); }
    }
    function openLightbox(photos, index){
      currentPhotos = photos;
      currentIndex = index;
      showCurrentPhoto();
      lightbox.classList.remove('hidden');
    }
    function closeLightbox(){
      lightbox.classList.add('hidden');
      img.src = '';
    }
    closeBtn.addEventListener('click', closeLightbox);
    prevBtn.addEventListener('click', goPrev);
    nextBtn.addEventListener('click', goNext);
    stage.addEventListener('click', (e)=>{
      if(e.target === stage) closeLightbox();
    });

    function touchDist(touches){
      const dx = touches[0].clientX - touches[1].clientX;
      const dy = touches[0].clientY - touches[1].clientY;
      return Math.sqrt(dx*dx + dy*dy);
    }

    stage.addEventListener('touchstart', (e)=>{
      if(e.touches.length === 2){
        isPinching = true; isPanning = false; swipeActive = false;
        startDist = touchDist(e.touches);
        startScale = scale;
      } else if(e.touches.length === 1){
        const now = Date.now();
        if(now - lastTapTime < 300){
          if(scale > 1){ resetTransform(); } else { scale = 2.5; applyTransform(); }
          lastTapTime = 0;
          swipeActive = false;
          return;
        }
        lastTapTime = now;
        isPinching = false;
        if(scale > 1){
          isPanning = true; swipeActive = false;
          startTouchX = e.touches[0].clientX - panX;
          startTouchY = e.touches[0].clientY - panY;
        } else {
          isPanning = false; swipeActive = true;
          swipeStartX = e.touches[0].clientX;
          swipeStartY = e.touches[0].clientY;
        }
      }
    }, {passive:true});

    stage.addEventListener('touchmove', (e)=>{
      if(isPinching && e.touches.length === 2){
        e.preventDefault();
        const newDist = touchDist(e.touches);
        scale = Math.min(4, Math.max(1, startScale * (newDist / startDist)));
        applyTransform();
      } else if(isPanning && e.touches.length === 1){
        e.preventDefault();
        panX = e.touches[0].clientX - startTouchX;
        panY = e.touches[0].clientY - startTouchY;
        applyTransform();
      } else if(swipeActive && e.touches.length === 1){
        e.preventDefault();
      }
    }, {passive:false});

    stage.addEventListener('touchend', (e)=>{
      if(e.touches.length === 0){
        if(isPanning){
          isPanning = false;
          if(scale <= 1) resetTransform();
        } else if(isPinching){
          isPinching = false;
          if(scale <= 1) resetTransform();
        } else if(swipeActive){
          const t = e.changedTouches[0];
          const dx = t.clientX - swipeStartX;
          const dy = t.clientY - swipeStartY;
          if(Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)){
            if(dx < 0) goNext(); else goPrev();
          }
        }
        swipeActive = false;
      }
    });

    document.addEventListener('click', (e)=>{
      const target = e.target.closest('.card-photos img');
      if(target){
        const container = target.closest('.card-photos');
        const imgs = Array.from(container.querySelectorAll('img'));
        openLightbox(imgs.map(i=>i.src), imgs.indexOf(target));
      }
    });
  })();

  // ---- 데이트기록 지도 ----
  let dateLogMapInstance = null;
  let dateLogMarkersLayer = null;
  function heartMarkerIcon(){
    return L.divIcon({
      className: '',
      html: `<div style="font-size:26px;line-height:1;filter:drop-shadow(0 2px 3px rgba(74,53,72,0.45));">❤️</div>`,
      iconSize: [26, 26],
      iconAnchor: [13, 24],
      popupAnchor: [0, -22]
    });
  }
  function openDateMap(){
    document.getElementById('dateMapModal').classList.remove('hidden');
    setTimeout(()=>{
      if(!dateLogMapInstance){
        dateLogMapInstance = L.map('dateMapContainer', { attributionControl: true });
        L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
          attribution: '&copy; OpenStreetMap &copy; CARTO',
          maxZoom: 20,
          subdomains: 'abcd'
        }).addTo(dateLogMapInstance);
      }
      const pts = dateLogs.filter(d => typeof d.lat === 'number' && typeof d.lng === 'number');
      if(dateLogMarkersLayer) dateLogMapInstance.removeLayer(dateLogMarkersLayer);
      dateLogMarkersLayer = L.layerGroup();
      pts.forEach(item=>{
        const photo = getItemPhotos(item)[0];
        const marker = L.marker([item.lat, item.lng], { icon: heartMarkerIcon() });
        marker.bindPopup(
          `<b>${escapeHTML(item.title)}</b><br><span style="color:#8A7A86;font-size:11px;">${fmtShortDate(item.date)} · ${item.author||''}</span>` +
          (photo ? `<br><img src="${photo}" style="width:110px;border-radius:8px;margin-top:4px;">` : '')
        );
        marker.addTo(dateLogMarkersLayer);
      });
      dateLogMarkersLayer.addTo(dateLogMapInstance);
      dateLogMapInstance.invalidateSize();
      if(pts.length > 0){
        const bounds = L.latLngBounds(pts.map(p=>[p.lat, p.lng]));
        dateLogMapInstance.fitBounds(bounds, { padding:[40,40], maxZoom:15 });
      } else {
        dateLogMapInstance.setView([37.5665, 126.9780], 11);
      }
    }, 50);
  }
  document.getElementById('dateMapOpenBtn').addEventListener('click', openDateMap);
  document.getElementById('dateMapClose').addEventListener('click', ()=>{
    document.getElementById('dateMapModal').classList.add('hidden');
  });


  function scheduleCardHTML(item){
    const d = fmtDate(item.date);
    const extraLabel = formatScheduleRange(item);
    const hasExtra = extraLabel !== fmtShortDate(item.date);
    const participants = item.participants || [];
    const joined = identity && participants.includes(identity);
    return `<div class="item-card ${isPast(item)?'past':''} ${item.isDate?'date-plan-card':''}" data-item-id="${item.id}">
      <div class="date-badge"><div class="day">${d.day}</div><div class="mon">${d.mon}</div></div>
      <div class="item-body">
        <div class="item-title">${escapeHTML(item.title)}${item.isDate ? ' ' + pixelHeartSVG(true, 16) : ''}</div>
        ${hasExtra ? `<div class="item-memo">${extraLabel}</div>` : ''}
        ${item.memo ? `<div class="item-memo">${escapeHTML(item.memo)}</div>` : ''}
        <div class="item-meta">${authorTagHTML(item.author)}</div>
        ${item.isDate ? `
          <div class="home-next-participants">
            ${participants.map(p => `<span class="recipient-chip color-${colorKeyOf(p)}">${p}</span>`).join('')}
          </div>
          ${!isPast(item) ? `<button type="button" class="date-plan-toggle ${joined?'active':''}" data-join-schedule="${item.id}" data-joined="${joined}" style="margin-top:8px;">${joined ? '참여 취소' : '참여할래'}</button>` : ''}
        ` : ''}
      </div>
      ${isMine(item) ? `<button class="edit-btn" data-edit-schedule="${item.id}">${pixelEditSVG()}</button>
      <button class="del-btn" data-del-schedule="${item.id}">✕</button>` : ''}
    </div>`;
  }
  let showPastSchedule = false;
  let calendarMonth = new Date();
  let calendarFilterDate = null;
  let scheduleFilterNames = []; // 다중선택 (비어있으면 전체 보기)
  let homeNextDateId = null; // 홈 화면 "다음 데이트" 카드가 가리키는 일정 id
  let wishAuthorFilter = 'all';
  let dateLogAuthorFilter = 'all';
  let boardAuthorFilter = 'all';

function renderCalendar(){
    const y = calendarMonth.getFullYear(), m = calendarMonth.getMonth();
    const firstDay = new Date(y, m, 1);
    const startWeekday = firstDay.getDay();
    const daysInMonth = new Date(y, m+1, 0).getDate();
    const todayStr = localDateStr();

    // 이번 달 달력에 표시되는 날짜 범위 (1일 ~ 말일)
    const startDateStr = `${y}-${String(m+1).padStart(2,'0')}-01`;
    const endDateStr = `${y}-${String(m+1).padStart(2,'0')}-${String(daysInMonth).padStart(2,'0')}`;

    // 화면에 그릴 일정만 필터링하고 정렬 (시작일이 빠른 순 -> 기간이 긴 순)
    const monthEvents = schedule.filter(item => {
      if (scheduleFilterNames.length > 0 && !scheduleFilterNames.includes(item.author)) return false;
      const itemStart = item.date;
      const itemEnd = item.endDate || item.date;
      return itemStart <= endDateStr && itemEnd >= startDateStr;
    }).sort((a, b) => {
      if (a.date !== b.date) return a.date.localeCompare(b.date);
      const aEnd = a.endDate || a.date;
      const bEnd = b.endDate || b.date;
      return bEnd.localeCompare(aEnd); 
    });

    // 다일 일정이 단차 없이 한 줄로 이어지게 '슬롯(slot)'을 배정
    const slotOccupied = {};
    monthEvents.forEach(ev => {
      const start = ev.date;
      const end = ev.endDate || ev.date;
      let slot = 0;
      
      while (true) { // 빈 층(슬롯) 찾기
        let isFree = true;
        let curr = new Date(start + 'T00:00:00');
        const endDt = new Date(end + 'T00:00:00');
        while (curr <= endDt) {
          const dStr = localDateStr(curr);
          if (slotOccupied[dStr] && slotOccupied[dStr][slot]) {
            isFree = false;
            break;
          }
          curr.setDate(curr.getDate() + 1);
        }
        if (isFree) break;
        slot++;
      }
      
      // 빈 슬롯에 해당 일정 점유시키기
      let curr = new Date(start + 'T00:00:00');
      const endDt = new Date(end + 'T00:00:00');
      while (curr <= endDt) {
        const dStr = localDateStr(curr);
        if (!slotOccupied[dStr]) slotOccupied[dStr] = [];
        slotOccupied[dStr][slot] = ev;
        curr.setDate(curr.getDate() + 1);
      }
    });

    let cells = '';
    for(let i=0;i<startWeekday;i++) cells += `<div class="calendar-day empty"></div>`;
    
    // 1일부터 말일까지 달력 셀 그리기
    for(let day=1; day<=daysInMonth; day++){
      const dateStr = `${y}-${String(m+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
      const dayOfWeek = new Date(y, m, day - 1).getDay() + 1 === 7 ? 0 : new Date(y, m, day).getDay();
      const classes = ['calendar-day'];
      if(dateStr === todayStr) classes.push('today');
      if(dateStr === calendarFilterDate) classes.push('selected');

      let eventsHTML = '';
      const slotsForDay = slotOccupied[dateStr] || [];
      const MAX_SLOTS = 2; // 각 날짜 칸에 표시할 최대 일정 줄 수
      
      for (let i = 0; i < MAX_SLOTS; i++) {
        const ev = slotsForDay[i];
        if (ev) {
          const personClass = ev.isDate ? 'date-plan-event' : `color-${colorKeyOf(ev.author)}`;
          const isActualStart = ev.date === dateStr;
          const evEnd = ev.endDate || ev.date;

          // 이 날짜가 '띠'를 새로 그리기 시작하는 지점인지 판단:
          // 실제 시작일이거나 / 이번 달 보기의 1일(지난달에서 이어짐)이거나 / 이번 주의 첫 날(일요일, 지난 주에서 이어짐)
          const isMonthContinuation = dateStr === startDateStr && ev.date < startDateStr;
          const isWeekContinuation = dayOfWeek === 0 && ev.date < dateStr;
          const isSegmentStart = isActualStart || isMonthContinuation || isWeekContinuation;
          // 글자는 실제 시작일 / 달이 바뀌며 이어질 때만 다시 써주고, 그냥 주만 넘어갈 땐 색만 이어감
          const shouldShowLabel = isActualStart || isMonthContinuation;

          if (isSegmentStart) {
            // 이번 주(토요일까지) / 이번 달 말일까지 / 일정 종료일까지 중 가장 빨리 끝나는 지점까지 span 계산
            const daysLeftInRow = 6 - dayOfWeek;
            const daysLeftInMonth = daysInMonth - day;
            let span = 1;
            while (span <= daysLeftInRow && span <= daysLeftInMonth) {
              const nextDateStr = `${y}-${String(m+1).padStart(2,'0')}-${String(day+span).padStart(2,'0')}`;
              if (nextDateStr > evEnd) break;
              span++;
            }
            const segEndDateStr = `${y}-${String(m+1).padStart(2,'0')}-${String(day+span-1).padStart(2,'0')}`;
            const isSegEnd = evEnd <= segEndDateStr;

            const shapeClass = [];
            if (isActualStart) shapeClass.push('ev-start'); else shapeClass.push('ev-mid-left');
            if (isSegEnd && evEnd === segEndDateStr) shapeClass.push('ev-end');

            const label = shouldShowLabel ? `${ev.isDate ? pixelHeartSVG(true, 13, '#ffffff') + ' ' : ''}${escapeHTML(ev.title)}` : '';
            // span이 1이어도 항상 너비를 명시해야 함 (안 그러면 절대위치 특성상 글자 길이만큼 밖으로 튀어나감)
            const widthCss = `width:calc(${span * 100}% + ${Math.max(0, span - 1) * 3}px);`;

            eventsHTML += `<div class="cal-slot-row"><div class="cal-event-pill ${personClass} ${shapeClass.join(' ')}" style="position:absolute;left:0;top:0;height:100%;${widthCss}">${label}</div></div>`;
          } else {
            // 띠가 이어지는 중간 날짜: 이미 시작점에서 그려진 띠가 이 칸까지 덮어주므로, 자리만 확보(투명)
            eventsHTML += `<div class="cal-slot-row"></div>`;
          }
        } else {
          // 일정이 없지만 위쪽 슬롯의 단차를 유지하기 위한 투명한 빈 공간
          if (i < slotsForDay.length) { 
            eventsHTML += `<div class="cal-slot-row"></div>`;
          }
        }
      }
      
      // 가려진 일정 개수 (+N) 표시
      let moreCount = 0;
      for (let i = MAX_SLOTS; i < slotsForDay.length; i++) {
        if (slotsForDay[i]) moreCount++;
      }
      if (moreCount > 0) eventsHTML += `<div class="cal-event-more">+${moreCount}</div>`;

      cells += `<div class="${classes.join(' ')}" data-cal-date="${dateStr}">
        <div class="cal-daynum">${day}</div>
        <div class="cal-events">${eventsHTML}</div>
      </div>`;
    }

    const cal = document.getElementById('scheduleCalendar');
    cal.innerHTML = `
      <div class="calendar-header">
        <button class="calendar-nav-btn" id="calPrevBtn" type="button">‹</button>
        <div class="calendar-month-label">${y}년 ${m+1}월</div>
        <button class="calendar-nav-btn" id="calNextBtn" type="button">›</button>
      </div>
      <div class="calendar-grid">
        <div class="calendar-weekday">일</div><div class="calendar-weekday">월</div><div class="calendar-weekday">화</div>
        <div class="calendar-weekday">수</div><div class="calendar-weekday">목</div><div class="calendar-weekday">금</div>
        <div class="calendar-weekday">토</div>
        ${cells}
      </div>`;
      
    document.getElementById('calPrevBtn').addEventListener('click', ()=>{ calendarMonth = new Date(y, m-1, 1); renderCalendar(); });
    document.getElementById('calNextBtn').addEventListener('click', ()=>{ calendarMonth = new Date(y, m+1, 1); renderCalendar(); });
    cal.querySelectorAll('[data-cal-date]').forEach(cell=>{
      cell.addEventListener('click', ()=>{
        const d = cell.dataset.calDate;
        calendarFilterDate = (calendarFilterDate === d) ? null : d;
        renderCalendar();
        renderSchedule();
      });
    });
  }

  function renderSchedule(){
    const list = document.getElementById('scheduleList');
    const toggleBtn = document.getElementById('togglePastBtn');
    const pastSection = document.getElementById('pastScheduleSection');
    const filterNotice = document.getElementById('scheduleFilterNotice');

    const scheduleData = scheduleFilterNames.length > 0
      ? schedule.filter(item => scheduleFilterNames.includes(item.author))
      : schedule;

    if(calendarFilterDate){
      const filtered = scheduleData.filter(item => itemCoversDate(item, calendarFilterDate));
      filterNotice.classList.remove('hidden');
      filterNotice.querySelector('span').textContent = `${fmtShortDate(calendarFilterDate)} 일정만 보는 중`;
      list.innerHTML = filtered.length
        ? filtered.map(scheduleCardHTML).join('')
        : '<div class="empty-state">이 날짜엔 일정이 없어.</div>';
      toggleBtn.classList.add('hidden');
      pastSection.classList.add('hidden');
      tryConsumePendingScroll();
      return;
    }
    filterNotice.classList.add('hidden');

    if(scheduleData.length === 0){
      list.innerHTML = '<div class="empty-state"><span class="empty-emoji">🗓️</span>아직 등록된 일정이 없어.<br>첫 일정을 추가해볼까?</div>';
      toggleBtn.classList.add('hidden');
      pastSection.classList.add('hidden');
      tryConsumePendingScroll();
      return;
    }

    const upcoming = scheduleData.filter(item => !isPast(item));
    const past = [...scheduleData.filter(item => isPast(item))].reverse();

    list.innerHTML = upcoming.length === 0
      ? '<div class="empty-state"><span class="empty-emoji">✅</span>다가오는 일정이 없어.</div>'
      : upcoming.map(scheduleCardHTML).join('');

    if(past.length > 0){
      toggleBtn.classList.remove('hidden');
      toggleBtn.textContent = showPastSchedule ? '지난 일정 숨기기' : `지난 일정 ${past.length}개 보기`;
      pastSection.classList.toggle('hidden', !showPastSchedule);
      pastSection.innerHTML = past.map(scheduleCardHTML).join('');
    } else {
      toggleBtn.classList.add('hidden');
      pastSection.classList.add('hidden');
    }
    tryConsumePendingScroll();
  }


  function wishCardHTML(item){
    const dt = new Date(item.createdAt || Date.now());
    const dateStr = `${dt.getFullYear()}.${String(dt.getMonth()+1).padStart(2,'0')}.${String(dt.getDate()).padStart(2,'0')}`;
    const likes = item.likes || [];
    const isLiked = identity && likes.includes(identity);
    const likeIcon = pixelHeartSVG(isLiked);
    const commentCount = totalCommentCount(item.comments);
    return `<div class="wish-card ${item.done?'wish-done':''}" data-item-id="${item.id}">
      <div class="wish-content">
        <div class="post-summary" data-post-toggle="${item.id}">
          <div class="post-summary-title">${escapeHTML(item.title)}</div>
          <div class="post-summary-meta">${authorTagHTML(item.author)}<span>${dateStr}</span><span class="post-summary-arrow">▾</span></div>
        </div>
        <div class="post-detail ${openPostDetails.has(item.id) ? '' : 'hidden'}">
          ${item.body ? `<div class="wish-body">${escapeHTML(item.body)}</div>` : ''}
          ${cardPhotosHTML(item)}
          ${item.link ? `<a class="wish-link" href="${escapeHTML(item.link)}" target="_blank" rel="noopener">🔗 ${escapeHTML(linkHost(item.link))}</a>` : ''}
          <div class="wish-footer">
            <div style="display:flex;align-items:center;gap:6px;justify-content:flex-end;width:100%;">
              <button class="wish-check ${item.done?'checked':''}" data-check-wish="${item.id}">${item.done ? '✓ 완료함' : '완료로 표시'}</button>
              ${isMine(item) ? `<button class="edit-btn" data-edit-wish="${item.id}">${pixelEditSVG()}</button>
              <button class="del-btn" data-del-wish="${item.id}">✕</button>` : ''}
            </div>
          </div>
          <div class="reaction-row">
            <div style="display:flex; gap:10px;">
              <button class="like-btn ${isLiked ? 'liked' : ''}" data-like-col="wishlist" data-like-id="${item.id}">
                <span class="heart-icon">${likeIcon}</span> ${likes.length > 0 ? likes.length : ''}
              </button>
              <button class="comment-btn" data-toggle-comment="wishlist" data-toggle-id="${item.id}">
                <span class="chat-icon">${pixelChatSVG()}</span> ${commentCount > 0 ? commentCount : ''}
              </button>
            </div>
          </div>
          ${renderCommentsHTML(item, 'wishlist')}
        </div>
      </div>
    </div>`;
  }
  function renderWish(){
    const list = document.getElementById('wishList');
    const toggleBtn = document.getElementById('toggleDoneWishBtn');
    const doneSection = document.getElementById('doneWishSection');

    const wishData = wishAuthorFilter === 'all' ? wishes : wishes.filter(w => w.author === wishAuthorFilter);

    if(wishData.length === 0){
      list.innerHTML = wishAuthorFilter === 'all'
        ? '<div class="empty-state"><span class="empty-emoji">💭</span>아직 하고 싶은 일이 없어.<br>버킷리스트를 적어볼까?</div>'
        : '<div class="empty-state"><span class="empty-emoji">💭</span>해당하는 위시가 없어.</div>';
      toggleBtn.classList.add('hidden');
      doneSection.classList.add('hidden');
      tryConsumePendingScroll();
      return;
    }
    const active = wishData.filter(w=>!w.done);
    const done = wishData.filter(w=>w.done);

    list.innerHTML = active.length === 0
      ? '<div class="empty-state"><span class="empty-emoji">🎉</span>다 완료했어! 새로운 위시를 적어볼까?</div>'
      : active.map(wishCardHTML).join('');

    if(done.length > 0){
      toggleBtn.classList.remove('hidden');
      toggleBtn.textContent = showDoneWishes ? '완료한 위시 숨기기' : `완료한 위시 ${done.length}개 보기`;
      doneSection.classList.toggle('hidden', !showDoneWishes);
      doneSection.innerHTML = done.map(wishCardHTML).join('');
    } else {
      toggleBtn.classList.add('hidden');
      doneSection.classList.add('hidden');
    }
    tryConsumePendingScroll();
  }

// 1. 데이트 기록
  function dateLogCardHTML(item){
    const d = fmtDate(item.date);
    const extraLabel = formatScheduleRange(item);
    const hasExtra = extraLabel !== fmtShortDate(item.date);
    
    const likes = item.likes || [];
    const isLiked = likes.includes(identity);
    const likeIcon = pixelHeartSVG(isLiked);
    const commentCount = totalCommentCount(item.comments);

    return `<div class="item-card" data-item-id="${item.id}">
      <div class="date-badge" style="background:var(--yellow-soft);"><div class="day">${d.day}</div><div class="mon">${d.mon}</div></div>
      <div class="item-body">
        <div class="post-summary" data-post-toggle="${item.id}">
          <div class="post-summary-title">${escapeHTML(item.title)}</div>
          <div class="post-summary-meta">${authorTagHTML(item.author)}<span>${(item.endDate && item.endDate !== item.date) ? `${fmtShortDate(item.date)}~${fmtShortDate(item.endDate)}` : fmtShortDate(item.date)} 데이트</span><span class="post-summary-arrow">▾</span></div>
          <div class="post-summary-sub">올린 날짜 · ${item.createdAt ? formatDateTimeKR(item.createdAt) : '-'}</div>
        </div>
        <div class="post-detail ${openPostDetails.has(item.id) ? '' : 'hidden'}">
          ${item.location ? `<div class="item-location">📍 ${escapeHTML(item.location)}</div>` : ''}
          ${hasExtra ? `<div class="item-memo">${extraLabel}</div>` : ''}
          ${(item.participants && item.participants.length) ? `<div class="letter-recipients" style="margin-top:6px;">${item.participants.map(p=>`<span class="recipient-chip color-${colorKeyOf(p)}">${p}</span>`).join('')}</div>` : ''}
          ${item.memo ? `<div class="item-memo">${escapeHTML(item.memo)}</div>` : ''}
          ${cardPhotosHTML(item)}

          <div class="reaction-row">
            <div style="display:flex; gap:10px;">
              <button class="like-btn ${isLiked ? 'liked' : ''}" data-like-col="datelog" data-like-id="${item.id}">
                <span class="heart-icon">${likeIcon}</span> ${likes.length > 0 ? likes.length : ''}
              </button>
              <button class="comment-btn" data-toggle-comment="datelog" data-toggle-id="${item.id}">
                <span class="chat-icon">${pixelChatSVG()}</span> ${commentCount > 0 ? commentCount : ''}
              </button>
            </div>
            <div class="reaction-row-right">
              ${isMine(item) ? `<button class="edit-btn" data-edit-datelog="${item.id}">${pixelEditSVG()}</button>
              <button class="del-btn" data-del-datelog="${item.id}">✕</button>` : ''}
            </div>
          </div>
          ${renderCommentsHTML(item, 'datelog')}
        </div>
      </div>
    </div>`;
  }
function renderDateLog() {
  const dateLogData = dateLogAuthorFilter === 'all' ? dateLogs : dateLogs.filter(d => d.author === dateLogAuthorFilter);
  renderGroupedByTime(
    'dateLogList',
    dateLogData,
    item => item.date + 'T00:00:00',
    dateLogCardHTML,
    dateLogExpandedGroups,
    dateLogAuthorFilter === 'all'
      ? '<div class="empty-state"><span class="empty-emoji">💜</span>우리의 첫 데이트를<br>기록해봐.</div>'
      : '<div class="empty-state"><span class="empty-emoji">💜</span>해당하는 기록이 없어.</div>'
  );
  tryConsumePendingScroll();
}

// 2. 자유게시판
  function boardCardHTML(item){
    const dt = new Date(item.createdAt || Date.now());
    const dateStr = `${dt.getFullYear()}.${String(dt.getMonth()+1).padStart(2,'0')}.${String(dt.getDate()).padStart(2,'0')}`;
    const likes = item.likes || [];
    const isLiked = identity && likes.includes(identity);
    const likeIcon = pixelHeartSVG(isLiked);
    const commentCount = totalCommentCount(item.comments);
    return `<div class="wish-card ${item.pinned?'pinned-card':''}" data-item-id="${item.id}">
      <div class="wish-content">
        <div class="post-summary" data-post-toggle="${item.id}">
          ${item.pinned ? `<div class="pinned-badge">📌 공지</div>` : ''}
          <div class="post-summary-title">${escapeHTML(item.title)}</div>
          <div class="post-summary-meta">${authorTagHTML(item.author)}<span>${dateStr}</span><span class="post-summary-arrow">▾</span></div>
        </div>
        <div class="post-detail ${openPostDetails.has(item.id) ? '' : 'hidden'}">
          ${item.body ? `<div class="wish-body">${escapeHTML(item.body)}</div>` : ''}
          ${cardPhotosHTML(item)}
          <div class="wish-footer">
            <div style="display:flex;align-items:center;gap:6px;justify-content:flex-end;width:100%;">
              ${isMine(item) ? `<button class="edit-btn" data-edit-board="${item.id}">${pixelEditSVG()}</button>
              <button class="del-btn" data-del-board="${item.id}">✕</button>` : ''}
            </div>
          </div>
          <div class="reaction-row">
            <div style="display:flex; gap:10px;">
              <button class="like-btn ${isLiked ? 'liked' : ''}" data-like-col="board" data-like-id="${item.id}">
                <span class="heart-icon">${likeIcon}</span> ${likes.length > 0 ? likes.length : ''}
              </button>
              <button class="comment-btn" data-toggle-comment="board" data-toggle-id="${item.id}">
                <span class="chat-icon">${pixelChatSVG()}</span> ${commentCount > 0 ? commentCount : ''}
              </button>
            </div>
          </div>
          ${renderCommentsHTML(item, 'board')}
        </div>
      </div>
    </div>`;
  }
function renderBoard() {
  const list = document.getElementById('boardList');
  const boardData = boardAuthorFilter === 'all' ? boards : boards.filter(b => b.author === boardAuthorFilter);
  if(boardData.length === 0){
    list.innerHTML = boardAuthorFilter === 'all'
      ? '<div class="empty-state"><span class="empty-emoji">📋</span>아직 게시글이 없어.<br>자유롭게 남겨봐!</div>'
      : '<div class="empty-state"><span class="empty-emoji">📋</span>해당하는 게시글이 없어.</div>';
    tryConsumePendingScroll();
    return;
  }
  const pinned = boardData.filter(b => b.pinned);
  const regular = boardData.filter(b => !b.pinned);

  renderGroupedByTime(
    'boardList',
    regular,
    item => item.createdAt || Date.now(),
    boardCardHTML,
    boardExpandedGroups,
    ''
  );

  if(pinned.length > 0){
    list.insertAdjacentHTML('afterbegin', pinned.map(boardCardHTML).join(''));
  }
  tryConsumePendingScroll();
}

// 3. 편지
  function letterCardHTML(item){
    const dateStr = formatDateTimeKR(item.createdAt || Date.now());
    const recipients = item.recipients || [];
    const isLocked = item.unlockAt && item.unlockAt > Date.now() && !isMine(item);
    const likes = item.likes || [];
    const isLiked = identity && likes.includes(identity);
    const likeIcon = pixelHeartSVG(isLiked);
    const commentCount = totalCommentCount(item.comments);

    return `<div class="wish-card" data-item-id="${item.id}">
      <div class="wish-content">
        <div class="post-summary" data-post-toggle="${item.id}">
          <div class="post-summary-title">${isLocked ? '🔒 ' : ''}${escapeHTML(item.title)}</div>
          <div class="post-summary-meta"><span class="letter-from color-${colorKeyOf(item.author)}">From. ${item.author||''}</span><span>${dateStr}</span><span class="post-summary-arrow">▾</span></div>
          <div class="letter-recipients" style="margin-top:6px;">${recipients.map(r=>`<span class="recipient-chip color-${colorKeyOf(r)}">To. ${r}</span>`).join('')}</div>
        </div>
        <div class="post-detail ${openPostDetails.has(item.id) ? '' : 'hidden'}">
          ${isLocked
            ? `<div class="lock-badge">🔒 ${fmtShortDateTime(item.unlockAt)}에 열려</div>`
            : `<div class="wish-body">${escapeHTML(item.body)}</div>${cardPhotosHTML(item)}`
          }
          <div class="wish-footer">
            <div style="display:flex; align-items:center; gap:8px; justify-content:flex-end; width:100%;">
              ${isMine(item) ? `<button class="edit-btn" data-edit-letter="${item.id}">${pixelEditSVG()}</button><button class="del-btn" data-del-letter="${item.id}">✕</button>` : ''}
            </div>
          </div>
          ${!isLocked ? `
          <div class="reaction-row">
            <div style="display:flex; gap:10px;">
              <button class="like-btn ${isLiked ? 'liked' : ''}" data-like-col="letters" data-like-id="${item.id}">
                <span class="heart-icon">${likeIcon}</span> ${likes.length > 0 ? likes.length : ''}
              </button>
              <button class="comment-btn" data-toggle-comment="letters" data-toggle-id="${item.id}">
                <span class="chat-icon">${pixelChatSVG()}</span> ${commentCount > 0 ? commentCount : ''}
              </button>
            </div>
          </div>
          ${renderCommentsHTML(item, 'letters')}
          ` : ''}
        </div>
      </div>
    </div>`;
  }
let letterFilterTarget = 'all';
function renderLetters() {
  const filteredLetters = letterFilterTarget === 'all' ? letters : letters.filter(item => (item.recipients||[]).includes(letterFilterTarget));
  renderGroupedByTime(
    'letterList',
    filteredLetters,
    item => item.createdAt || Date.now(),
    letterCardHTML,
    letterExpandedGroups,
    letterFilterTarget === 'all'
      ? '<div class="empty-state"><span class="empty-emoji">💌</span>아직 편지가 없어.<br>짧은 편지 한 통 써볼까?</div>'
      : '<div class="empty-state"><span class="empty-emoji">💌</span>해당하는 편지가 없어.</div>'
  );
  tryConsumePendingScroll();
}

  function findNextSchedule(){
    const upcoming = schedule.filter(item => !isPast(item)).sort((a,b)=> a.date.localeCompare(b.date));
    return upcoming[0] || null;
  }
  function findNextDatePlan(){
    const upcoming = schedule.filter(item => item.isDate && !isPast(item)).sort((a,b)=> a.date.localeCompare(b.date));
    return upcoming[0] || null;
  }
  function formatTodayKR(){
    const days = ['일','월','화','수','목','금','토'];
    const d = new Date();
    const y = d.getFullYear(), m = String(d.getMonth()+1).padStart(2,'0'), day = String(d.getDate()).padStart(2,'0');
    return `${y}-${m}-${day}<br>${days[d.getDay()]}요일`;
  }
  // 등록된 기념일(생일 등) 중 오늘부터 가장 가까운 것 찾기
  function nearestAnniversary(){
    const today = new Date(); today.setHours(0,0,0,0);
    let nearest = null;
    anniversaries.forEach(a=>{
      let candidate;
      if(a.recurring === false){
        if(!a.year) return;
        candidate = new Date(a.year, a.month - 1, a.day);
        if(candidate < today) return; // 지난 1회성 이벤트는 제외
      } else {
        candidate = new Date(today.getFullYear(), a.month - 1, a.day);
        if(candidate < today) candidate = new Date(today.getFullYear() + 1, a.month - 1, a.day);
      }
      const diffDays = Math.round((candidate - today) / 86400000);
      if(!nearest || diffDays < nearest.diffDays){
        nearest = { title: a.title, diffDays };
      }
    });
    return nearest;
  }

  function findThrowback(){
    const today = new Date();
    const mm = today.getMonth(), dd = today.getDate(), curYear = today.getFullYear();
    const candidates = [];
    dateLogs.forEach(item=>{
      if(!item.date) return;
      const d = new Date(item.date + 'T00:00:00');
      if(d.getMonth() === mm && d.getDate() === dd && d.getFullYear() < curYear){
        candidates.push({ type:'datelog', yearsAgo: curYear - d.getFullYear(), item });
      }
    });
    letters.forEach(item=>{
      const d = new Date(item.createdAt || 0);
      if(d.getMonth() === mm && d.getDate() === dd && d.getFullYear() < curYear && d.getFullYear() > 2000){
        candidates.push({ type:'letter', yearsAgo: curYear - d.getFullYear(), item });
      }
    });
    if(candidates.length === 0) return null;
    candidates.sort((a,b)=> a.yearsAgo - b.yearsAgo);
    return candidates[0];
  }

  function relativeTimeKR(ts){
    if(!ts) return '';
    const diffMs = Date.now() - ts;
    const diffMin = Math.floor(diffMs / 60000);
    if(diffMin < 1) return '방금 전';
    if(diffMin < 60) return `${diffMin}분 전`;
    const diffHour = Math.floor(diffMin / 60);
    if(diffHour < 24) return `${diffHour}시간 전`;
    const diffDay = Math.floor(diffHour / 24);
    if(diffDay < 7) return `${diffDay}일 전`;
    const d = new Date(ts);
    return `${d.getMonth()+1}.${d.getDate()}`;
  }

  function buildActivityFeed(){
    const items = [];
    schedule.forEach(it=>{
      if(!it.createdAt) return;
      items.push({ id: it.id, ts: it.createdAt, author: it.author, label:'일정', text: it.title, tab:'schedule' });
    });
    wishes.forEach(it=>{
      items.push({ id: it.id, ts: it.createdAt || 0, author: it.author, label:'위시', text: it.title, tab:'wish' });
    });
    dateLogs.forEach(it=>{
      if(!it.createdAt) return;
      items.push({ id: it.id, ts: it.createdAt, author: it.author, label:'데이트기록', text: it.title, tab:'datelog' });
    });
    boards.forEach(it=>{
      items.push({ id: it.id, ts: it.createdAt || 0, author: it.author, label:'게시판', text: it.title, tab:'board' });
    });
    letters.forEach(it=>{
      items.push({ id: it.id, ts: it.createdAt || 0, author: it.author, label:'편지', text: it.title || it.body, tab:'letter' });
    });
    return items.sort((a,b)=> b.ts - a.ts).slice(0, 2);
  }

  let renderHomeDebounceTimer = null;
  function renderHome(){
    clearTimeout(renderHomeDebounceTimer);
    renderHomeDebounceTimer = setTimeout(renderHomeImmediate, 120);
  }
  function renderHomeImmediate(){
    const todayEl = document.getElementById('homeToday');
    if(todayEl) todayEl.innerHTML = formatTodayKR();

    const annivMini = document.getElementById('homeAnnivMini');
    if(annivMini){
      const anv = nearestAnniversary();
      if(!anv){
        annivMini.innerHTML = `등록된 기념일이 없어`;
      } else {
        annivMini.innerHTML = anv.diffDays === 0
          ? `🎉 오늘은<br><b>${escapeHTML(anv.title)}</b>이야!`
          : `${escapeHTML(anv.title)}까지<br><b>D-${anv.diffDays}</b>`;
      }
    }

    const nextDateCard = document.getElementById('homeNextDateCard');
    if(nextDateCard){
      const nextDate = findNextDatePlan();
      const today = new Date(); today.setHours(0,0,0,0);
      if(nextDate){
        const dDiff = Math.round((new Date(nextDate.date+'T00:00:00') - today) / 86400000);
        const participants = nextDate.participants || [];
        homeNextDateId = nextDate.id;
        nextDateCard.innerHTML = `
          <div class="home-next-label">💜 다음 데이트</div>
          <div class="home-next-title">${dDiff === 0 ? '오늘이야!' : 'D-' + dDiff} · ${escapeHTML(nextDate.title)}</div>
          <div class="home-next-participants">
            ${participants.map(p=>`<span class="recipient-chip color-${colorKeyOf(p)}">${p}</span>`).join('')}
          </div>
        `;
      } else {
        homeNextDateId = null;
        nextDateCard.innerHTML = `<div class="home-next-label">💜 다음 데이트</div><div class="home-next-sub">예정된 데이트가 없어</div>`;
      }
    }

    renderStatusBoard();

    const feedCard = document.getElementById('homeFeedCard');
    if(feedCard){
      const feed = buildActivityFeed();
      if(feed.length === 0){
        feedCard.innerHTML = `<div class="home-next-label">🕓 최근 활동</div><div class="home-next-sub">아직 활동이 없어</div>`;
      } else {
        const authorClass = a => `color-${colorKeyOf(a)}`;
        feedCard.innerHTML = `
          <div class="home-next-label">🕓 최근 활동</div>
          ${feed.map(f => `<div class="home-feed-item" data-tab-target="${f.tab}" data-item-target="${f.id}">
            <span class="home-feed-author ${authorClass(f.author)}">${f.author||''}</span>
            <span class="home-feed-text">${f.label} · ${escapeHTML((f.text||'').slice(0,24))}</span>
            <span class="home-feed-time">${relativeTimeKR(f.ts)}</span>
          </div>`).join('')}
        `;
        feedCard.querySelectorAll('.home-feed-item').forEach(el=>{
          el.addEventListener('click', ()=> navigateToItem(el.dataset.tabTarget, el.dataset.itemTarget));
        });
      }
    }

    const throwbackCard = document.getElementById('homeThrowbackCard');
    if(throwbackCard){
      const tb = findThrowback();
      if(tb){
        const photo = getItemPhotos(tb.item)[0];
        const title = tb.type === 'datelog' ? tb.item.title : (tb.item.title || tb.item.body.slice(0,20));
        throwbackCard.classList.remove('hidden');
        throwbackCard.dataset.tabTarget = tb.type === 'datelog' ? 'datelog' : 'letter';
        throwbackCard.innerHTML = `
          ${photo ? `<img class="home-throwback-photo" src="${photo}" loading="lazy">` : '<div style="font-size:28px;">💭</div>'}
          <div>
            <div class="home-throwback-label">${tb.yearsAgo}년 전 오늘</div>
            <div class="home-throwback-title">${escapeHTML(title)}</div>
          </div>
        `;
      } else {
        throwbackCard.classList.add('hidden');
      }
    }
  }

  function renderStatusBoard(){
    const board = document.getElementById('statusBoard');
    if(!board) return;
    board.innerHTML = ALL_NAMES.map(name=>{
      const p = profiles[name];
      const colorKey = colorKeyOf(name);
      const emoji = (p && p.status && p.status.emoji) || '🙂';
      const text = (p && p.status && p.status.text) || '상태 없음';
      const updatedAt = p && p.status && p.status.updatedAt;
      const timeAgo = updatedAt ? relativeTimeKR(updatedAt) : '';
      const clickable = identity === name;
      return `<div class="status-card color-${colorKey}" ${clickable ? `data-status-edit="1"` : ''}>
        <div class="s-name">${name}</div>
        <div class="s-emoji">${escapeHTML(emoji)}</div>
        <div class="s-text">${escapeHTML(text)}</div>
        <div class="s-time">${timeAgo}</div>
      </div>`;
    }).join('');
    board.querySelectorAll('[data-status-edit]').forEach(el=>{
      el.addEventListener('click', openStatusModal);
    });
  }
  function openStatusModal(){
    const p = profiles[identity];
    document.getElementById('statusEmojiInput').value = (p && p.status && p.status.emoji) || '';
    document.getElementById('statusTextInput').value = (p && p.status && p.status.text) || '';
    document.getElementById('statusModal').classList.remove('hidden');
  }
  document.getElementById('statusCancelBtn').addEventListener('click', ()=>{
    document.getElementById('statusModal').classList.add('hidden');
  });
  document.getElementById('statusClearBtn').addEventListener('click', ()=>{
    document.getElementById('statusEmojiInput').value = '';
    document.getElementById('statusTextInput').value = '';
    document.getElementById('statusTextInput').focus();
  });

  // ---- 게시글 작성 폼의 지우기(X) 버튼 공통 처리 (본문/textarea 제외) ----
  document.querySelectorAll('[data-clear-input]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const input = document.getElementById(btn.dataset.clearInput);
      if(!input) return;
      input.value = '';
      input.dispatchEvent(new Event('input', {bubbles:true}));
      input.focus();
    });
  });
  document.getElementById('statusSaveBtn').addEventListener('click', async ()=>{
    if(!identity) return;
    const emoji = document.getElementById('statusEmojiInput').value.trim();
    const text = document.getElementById('statusTextInput').value.trim();
    try{
      await db.collection('profiles').doc(identity).set({
        colorKey: colorKeyOf(identity),
        status: { emoji, text, updatedAt: Date.now() }
      }, { merge: true });
    }catch(e){ console.error('상태 저장 실패', e); }
    document.getElementById('statusModal').classList.add('hidden');
  });

  function getCurrentActiveTab(){
    const activePanel = document.querySelector('.tab-panel.active');
    return activePanel ? activePanel.id.replace('panel-','') : null;
  }
  function hasUnsavedDraft(tabName){
    switch(tabName){
      case 'schedule': return document.getElementById('schedTitle').value.trim() !== '';
      case 'wish': return document.getElementById('wishTitle').value.trim() !== '' || document.getElementById('wishBody').value.trim() !== '';
      case 'datelog': return document.getElementById('dateLogTitle').value.trim() !== '';
      case 'letter': return document.getElementById('letterBody').value.trim() !== '';
      case 'board': return document.getElementById('boardTitle').value.trim() !== '' || document.getElementById('boardBody').value.trim() !== '';
      default: return false;
    }
  }
  function resetDraftForTab(tabName){
    switch(tabName){
      case 'schedule': resetScheduleForm(); break;
      case 'wish': resetWishForm(); break;
      case 'datelog': resetDatelogForm(); break;
      case 'letter': resetLetterForm(); break;
      case 'board': resetBoardForm(); break;
    }
  }
  function activateTab(tabName){
    const panel = document.getElementById('panel-'+tabName);
    if(!panel) return;
    const currentTab = getCurrentActiveTab();
    if(currentTab && currentTab !== tabName && hasUnsavedDraft(currentTab)){
      const proceed = confirm('작성 중인 내용이 있어.\n다른 탭으로 이동하면 지금 쓴 내용이 사라져.\n\n그래도 이동할까?');
      if(!proceed) return;
      resetDraftForTab(currentTab);
    }
    // 떠나는 탭에서 펼쳐뒀던 게시물/댓글창/답글창은 상태까지 완전히 초기화해서,
    // 다음에 다시 왔을 때 항상 깔끔하게 다 접힌 채로 시작하도록 함
    if(currentTab && currentTab !== tabName){
      const oldPanel = document.getElementById('panel-'+currentTab);
      if(oldPanel){
        oldPanel.querySelectorAll('.post-detail:not(.hidden)').forEach(d => d.classList.add('hidden'));
        oldPanel.querySelectorAll('.comment-section.active').forEach(s => s.classList.remove('active'));
        oldPanel.querySelectorAll('.reply-input-row.active').forEach(r => r.classList.remove('active'));
      }
      openPostDetails.clear();
      openCommentSections.clear();
      openReplyInputs.clear();
      // 편지 탭을 나가면 받는사람 필터도 "전체"로 되돌림 (새로고침한 느낌으로)
      if(currentTab === 'letter' && letterFilterTarget !== 'all'){
        letterFilterTarget = 'all';
        document.querySelectorAll('#letterFilterRow .filter-chip').forEach(b=>{
          b.classList.toggle('active', b.dataset.letterFilter === 'all');
        });
        renderLetters();
      }
      // 편지 탭을 나가면 "특정 날짜까지 잠그기" 선택도 눌리지 않은 상태로 되돌림
      if(currentTab === 'letter'){
        setLetterLockToggleState(false);
      }
    }
    document.querySelectorAll('.tab-panel').forEach(p=>p.classList.remove('active'));
    panel.classList.add('active');
    window.scrollTo(0, 0);
    document.querySelectorAll('.tab-btn').forEach(b=>{
      b.classList.toggle('active', b.dataset.tab === tabName);
    });
    if(typeof startCollectionWatcher === 'function') startCollectionWatcher(tabName);
  }
  function activateTabFromHash(){
    const hash = window.location.hash.replace('#','');
    if(!hash) return;
    const [tab, itemId, commentTs, replyTs] = hash.split(':');
    if(!tab) return;
    if(itemId) navigateToItem(tab, itemId, commentTs, replyTs);
    else activateTab(tab);
  }
  document.querySelectorAll('.tab-btn').forEach(btn=>{
    btn.addEventListener('click', ()=> activateTab(btn.dataset.tab));
  });
  document.getElementById('homeThrowbackCard').addEventListener('click', ()=>{
    const target = document.getElementById('homeThrowbackCard').dataset.tabTarget;
    if(target) activateTab(target);
  });
  document.getElementById('homeNextDateCard').addEventListener('click', ()=>{
    if(homeNextDateId) navigateToItem('schedule', homeNextDateId);
    else activateTab('schedule');
  });
  window.addEventListener('hashchange', activateTabFromHash);
  if('serviceWorker' in navigator){
    navigator.serviceWorker.addEventListener('message', (event)=>{
      if(event.data && event.data.type === 'navigate' && event.data.tab){
        if(event.data.itemId) navigateToItem(event.data.tab, event.data.itemId, event.data.commentTs, event.data.replyTs);
        else activateTab(event.data.tab);
      }
    });
  }

  function updateIdentityChip(){
    document.getElementById('identityChip').textContent = identity ? `나는 ${identity}` : '나는 ...';
  }
  document.getElementById('identityChip').addEventListener('click', ()=>{
    if(confirm('로그아웃할까?')) firebase.auth().signOut();
  });
  let loginInProgress = false;
  document.getElementById('googleLoginBtn').addEventListener('click', ()=>{
    loginInProgress = true;
    showGate('로그인 중이야...', true);
    const provider = new firebase.auth.GoogleAuthProvider();
    firebase.auth().signInWithPopup(provider).catch(err=>{
      console.error('로그인 실패', err);
      loginInProgress = false;
      if(err.code !== 'auth/popup-closed-by-user'){
        alert('로그인에 실패했어. 다시 시도해줘.');
      }
      showGate('백씨스터즈 멤버만 쓸 수 있는 앱이야.<br>구글 계정으로 로그인해줘.');
    });
  });

  // ---- 삭제 확인 모달 ----
  let pendingDeleteAction = null;
  function askDeleteConfirm(action){
    pendingDeleteAction = action;
    document.getElementById('confirmModal').classList.remove('hidden');
  }
  document.getElementById('confirmCancelBtn').addEventListener('click', ()=>{
    pendingDeleteAction = null;
    document.getElementById('confirmModal').classList.add('hidden');
  });
  document.getElementById('confirmDeleteBtn').addEventListener('click', async ()=>{
    const action = pendingDeleteAction;
    pendingDeleteAction = null;
    document.getElementById('confirmModal').classList.add('hidden');
    if(action){ try{ await action(); }catch(err){ console.error(err); } }
  });

  // ---- 저장 실패시 쓴 내용을 지키면서 사진 없이 재시도 ----
  function showLoadingOverlay(message){
    document.querySelector('#loadingOverlay .loading-text').innerHTML = message || '게시 중이야...<br>사진이 있으면 조금 걸릴 수 있어';
    document.getElementById('loadingOverlay').classList.remove('hidden');
  }
  function hideLoadingOverlay(){
    document.getElementById('loadingOverlay').classList.add('hidden');
  }
  async function saveWithPhotoFallback(doSave, onSuccess){
    showLoadingOverlay();
    try{
      try{
        await doSave(true);
        onSuccess();
      }catch(e){
        console.error('저장 실패', e);
        hideLoadingOverlay();
        const retry = confirm('저장에 실패했어. 사진이 너무 크면 실패할 수 있어.\n\n사진 없이 다시 저장할까? (쓴 내용은 그대로 남아있어)');
        if(retry){
          showLoadingOverlay();
          try{
            await doSave(false);
            onSuccess();
            alert('사진 없이 저장했어. 사진은 조금 작은 걸로 다시 추가해봐도 좋아.');
          }catch(e2){
            console.error('재시도도 실패', e2);
            alert('다시 시도했는데도 실패했어. 인터넷 연결을 확인해줘. 쓴 내용은 그대로 남아있어.');
          }
        }
      }
    } finally {
      hideLoadingOverlay();
    }
  }

  // ---- 일정 ----
  let editingScheduleId = null;
  function renderScheduleFilterRow(){
    const row = document.getElementById('scheduleFilterRow');
    row.innerHTML = `<button type="button" class="chip-toggle ${scheduleFilterNames.length===0?'active':''}" data-schedule-filter-all="1">전체</button>` +
      ALL_NAMES.map(name => `
      <button type="button" class="chip-toggle color-${colorKeyOf(name)} ${scheduleFilterNames.includes(name)?'active':''}" data-schedule-filter-name="${name}">${name}</button>
    `).join('');
    row.querySelector('[data-schedule-filter-all]').addEventListener('click', ()=>{
      scheduleFilterNames = [];
      renderScheduleFilterRow();
      renderCalendar();
      renderSchedule();
    });
    row.querySelectorAll('[data-schedule-filter-name]').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        const name = btn.dataset.scheduleFilterName;
        const idx = scheduleFilterNames.indexOf(name);
        if(idx === -1) scheduleFilterNames.push(name); else scheduleFilterNames.splice(idx,1);
        renderScheduleFilterRow();
        renderCalendar();
        renderSchedule();
      });
    });
  }
  renderScheduleFilterRow();
  let schedIsDatePlan = false;
  function setDatePlanToggle(v){
    schedIsDatePlan = v;
    document.getElementById('schedDatePlanToggle').classList.toggle('active', v);
  }
  document.getElementById('schedDatePlanToggle').addEventListener('click', ()=>{
    setDatePlanToggle(!schedIsDatePlan);
  });
  function setRangeToggleState(rowId, btnId, show){
    document.getElementById(rowId).classList.toggle('hidden', !show);
    document.getElementById(btnId).textContent = show ? '- 종료일 제거' : '+ 종료일 추가 (선택)';
  }
  document.getElementById('schedRangeToggleBtn').addEventListener('click', ()=>{
    const row = document.getElementById('schedEndDateRow');
    const willShow = row.classList.contains('hidden');
    setRangeToggleState('schedEndDateRow', 'schedRangeToggleBtn', willShow);
    if(willShow){
      if(!document.getElementById('schedEndDate').value){
        document.getElementById('schedEndDate').value = document.getElementById('schedDate').value;
      }
    } else {
      document.getElementById('schedEndDate').value = '';
      document.getElementById('schedEndTime').value = '';
    }
  });
  function startEditSchedule(item){
    editingScheduleId = item.id;
    document.getElementById('schedDate').value = item.date;
    document.getElementById('schedTime').value = item.time || '';
    document.getElementById('schedTitle').value = item.title;
    document.getElementById('schedMemo').value = item.memo || '';
    setDatePlanToggle(!!item.isDate);
    if(item.endDate && item.endDate !== item.date){
      document.getElementById('schedEndDate').value = item.endDate;
      document.getElementById('schedEndTime').value = item.endTime || '';
      setRangeToggleState('schedEndDateRow', 'schedRangeToggleBtn', true);
    } else {
      document.getElementById('schedEndDate').value = '';
      document.getElementById('schedEndTime').value = '';
      setRangeToggleState('schedEndDateRow', 'schedRangeToggleBtn', false);
    }
    document.getElementById('schedAddBtn').textContent = '수정 완료';
    document.getElementById('schedCancelBtn').classList.remove('hidden');
    document.getElementById('schedAddBtn').closest('.add-card').scrollIntoView({behavior:'smooth', block:'start'});
  }
  function resetScheduleForm(){
    editingScheduleId = null;
    document.getElementById('schedTitle').value='';
    document.getElementById('schedMemo').value='';
    document.getElementById('schedTime').value='';
    document.getElementById('schedEndDate').value='';
    document.getElementById('schedEndTime').value='';
    setRangeToggleState('schedEndDateRow', 'schedRangeToggleBtn', false);
    setDatePlanToggle(false);
    document.getElementById('schedDate').value = localDateStr();
    document.getElementById('schedAddBtn').textContent = '추가하기';
    document.getElementById('schedCancelBtn').classList.add('hidden');
  }
  document.getElementById('schedCancelBtn').addEventListener('click', resetScheduleForm);
  document.getElementById('schedAddBtn').addEventListener('click', async ()=>{
    const date = document.getElementById('schedDate').value;
    const title = document.getElementById('schedTitle').value.trim();
    if(!date || !title) return;
    const memo = document.getElementById('schedMemo').value.trim();
    const time = document.getElementById('schedTime').value || null;
    let endDate = document.getElementById('schedEndDate').value || null;
    if(endDate && endDate < date) endDate = date;
    const endTime = endDate ? (document.getElementById('schedEndTime').value || null) : null;
    const isDate = schedIsDatePlan;
    try{
      if(editingScheduleId){
        await db.collection('schedule').doc(editingScheduleId).update({ date, endDate, time, endTime, title, memo, isDate });
        resetScheduleForm();
      } else {
        await db.collection('schedule').doc(genId()).set({ date, endDate, time, endTime, title, memo, isDate, participants: [], author: identity, createdAt: Date.now() });
        document.getElementById('schedTitle').value='';
        document.getElementById('schedMemo').value='';
        document.getElementById('schedTime').value='';
        document.getElementById('schedEndDate').value='';
        document.getElementById('schedEndTime').value='';
        setRangeToggleState('schedEndDateRow', 'schedRangeToggleBtn', false);
        setDatePlanToggle(false);
      }
    }catch(e){ console.error('일정 저장 실패', e); alert('저장에 실패했어. 인터넷 연결을 확인해줘.'); }
  });
  function handleScheduleClick(e){
    const editBtn = e.target.closest('[data-edit-schedule]');
    const delBtn = e.target.closest('[data-del-schedule]');
    const editId = editBtn && editBtn.dataset.editSchedule;
    const delId = delBtn && delBtn.dataset.delSchedule;
    const joinBtn = e.target.closest('[data-join-schedule]');
    if(editId){
      const item = schedule.find(s=>s.id===editId);
      if(item) startEditSchedule(item);
    } else if(delId){
      askDeleteConfirm(async ()=>{ await db.collection('schedule').doc(delId).delete(); });
    } else if(joinBtn){
      const id = joinBtn.dataset.joinSchedule;
      const joined = joinBtn.dataset.joined === 'true';
      if(!identity) return;
      if(joined){
        db.collection('schedule').doc(id).update({
          participants: firebase.firestore.FieldValue.arrayRemove(identity)
        }).catch(err=>console.error('참여 취소 실패', err));
      } else {
        openJoinModal(id);
      }
    }
  }
  let pendingJoinScheduleId = null;
  function openJoinModal(scheduleId){
    pendingJoinScheduleId = scheduleId;
    document.getElementById('joinModal').classList.remove('hidden');
  }
  document.getElementById('joinYesBtn').addEventListener('click', ()=>{
    if(pendingJoinScheduleId && identity){
      db.collection('schedule').doc(pendingJoinScheduleId).update({
        participants: firebase.firestore.FieldValue.arrayUnion(identity)
      }).catch(err=>console.error('참여 등록 실패', err));
    }
    pendingJoinScheduleId = null;
    document.getElementById('joinModal').classList.add('hidden');
  });
  document.getElementById('joinNoBtn').addEventListener('click', ()=>{
    pendingJoinScheduleId = null;
    document.getElementById('joinModal').classList.add('hidden');
  });
  document.getElementById('scheduleList').addEventListener('click', handleScheduleClick);
  document.getElementById('pastScheduleSection').addEventListener('click', handleScheduleClick);
  document.getElementById('togglePastBtn').addEventListener('click', ()=>{
    showPastSchedule = !showPastSchedule;
    renderSchedule();
  });
  document.getElementById('clearCalFilterBtn').addEventListener('click', ()=>{
    calendarFilterDate = null;
    renderCalendar();
    renderSchedule();
  });


  // ---- 하고 싶은 일 ----
  let editingWishId = null;
  let showDoneWishes = false;
  setupPhotoPicker('wishPhotoInput','wishPhotoBtn','wishPhotoPreviewWrap', ()=>pendingWishPhotos, (v)=>{ pendingWishPhotos = v; });
  setupAuthorFilterRow('wishFilterRow', ()=>wishAuthorFilter, (v)=>{ wishAuthorFilter = v; }, renderWish);
  function startEditWish(item){
    editingWishId = item.id;
    document.getElementById('wishTitle').value = item.title;
    document.getElementById('wishBody').value = item.body || '';
    document.getElementById('wishLink').value = item.link || '';
    if(document.getElementById('wishBody')._autoGrowResize) document.getElementById('wishBody')._autoGrowResize();
    pendingWishPhotos = getItemPhotos(item).slice();
    renderPhotoPreviewGrid('wishPhotoPreviewWrap', ()=>pendingWishPhotos, (v)=>{ pendingWishPhotos = v; });
// 게시하기 / 수정 완료 버튼
    document.getElementById('wishAddBtn').textContent = '수정 완료';
    document.getElementById('wishCancelBtn').classList.remove('hidden');
    document.getElementById('wishAddBtn').closest('.add-card').scrollIntoView({behavior:'smooth', block:'start'});
  }
  function resetWishForm(){
    editingWishId = null;
    document.getElementById('wishTitle').value = '';
    document.getElementById('wishBody').value = '';
    document.getElementById('wishLink').value = '';
    if(document.getElementById('wishBody')._autoGrowResize) document.getElementById('wishBody')._autoGrowResize();
    revokePendingPhotoUrls(pendingWishPhotos);
    pendingWishPhotos = [];
    renderPhotoPreviewGrid('wishPhotoPreviewWrap', ()=>pendingWishPhotos, (v)=>{ pendingWishPhotos = v; });
    document.getElementById('wishAddBtn').textContent = '게시하기';
    document.getElementById('wishCancelBtn').classList.add('hidden');
  }
  document.getElementById('wishCancelBtn').addEventListener('click', resetWishForm);
    document.getElementById('wishAddBtn').addEventListener('click', async () => {
      const title = document.getElementById('wishTitle').value.trim();
      if (!title) return;

      const data = {
        title,
        body: document.getElementById('wishBody').value.trim(),
        link: document.getElementById('wishLink').value.trim(),
        done: false
      };
      if(!editingWishId){ data.likes = []; data.comments = []; }

      await saveItem(
        'wishlist',
        !!editingWishId,
        editingWishId,
        data,
        pendingWishPhotos,
        resetWishForm
      );
    });

  // 클릭 이벤트 (수정/삭제/체크)
  function handleWishListClick(e) {
    const editBtn = e.target.closest('[data-edit-wish]');
    const delBtn = e.target.closest('[data-del-wish]');
    const checkBtn = e.target.closest('[data-check-wish]');
    const editId = editBtn && editBtn.dataset.editWish;
    const delId = delBtn && delBtn.dataset.delWish;
    const checkId = checkBtn && checkBtn.dataset.checkWish;

    if (editId) startEditWish(wishes.find(s => s.id === editId));
    else if (delId) deleteItem('wishlist', delId, wishes.find(s => s.id === delId));
    else if (checkId) {
      const wishItem = wishes.find(s => s.id === checkId);
      if(!wishItem) return;
      const willBeDone = !wishItem.done;
      if(willBeDone && !confirm('이 위시를 완료로 표시할까?')) return;
      db.collection('wishlist').doc(checkId).update({ done: willBeDone }).catch(err=>console.error(err));
    }
  }
  document.getElementById('wishList').addEventListener('click', handleWishListClick);
  document.getElementById('doneWishSection').addEventListener('click', handleWishListClick);
  document.getElementById('toggleDoneWishBtn').addEventListener('click', ()=>{
    showDoneWishes = !showDoneWishes;
    renderWish();
  });

  // ---- 데이트 기록 ----
  let editingDatelogId = null;
  let dateLogSelectedParticipants = [];
  function renderParticipantChips(containerId, selectedArr){
    const row = document.getElementById(containerId);
    row.innerHTML = ALL_NAMES.map(name => `
      <button type="button" class="chip-toggle color-${colorKeyOf(name)} ${selectedArr.includes(name)?'active':''}" data-chip-name="${name}">${name}</button>
    `).join('');
    row.querySelectorAll('.chip-toggle').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        const name = btn.dataset.chipName;
        const idx = selectedArr.indexOf(name);
        if(idx === -1) selectedArr.push(name); else selectedArr.splice(idx,1);
        btn.classList.toggle('active');
      });
    });
  }
  renderParticipantChips('dateLogParticipantRow', dateLogSelectedParticipants);
  setupPhotoPicker('dateLogPhotoInput','dateLogPhotoBtn','dateLogPhotoPreviewWrap', ()=>pendingDateLogPhotos, (v)=>{ pendingDateLogPhotos = v; });

  // 위시/데이트/게시판 공용: 이름 누르면 그 사람 글만, 이미 눌려있으면 다시 눌러서 전체로
  function setupAuthorFilterRow(rowId, getFilter, setFilter, onChange){
    const row = document.getElementById(rowId);
    row.addEventListener('click', (e)=>{
      const btn = e.target.closest('[data-author-filter]');
      if(!btn) return;
      const val = btn.dataset.authorFilter;
      if(val === 'all'){
        setFilter('all');
      } else if(getFilter() === val){
        setFilter('all');
      } else {
        setFilter(val);
      }
      const current = getFilter();
      row.querySelectorAll('[data-author-filter]').forEach(b=>{
        b.classList.toggle('active', b.dataset.authorFilter === current);
      });
      onChange();
    });
  }
  setupAuthorFilterRow('dateLogFilterRow', ()=>dateLogAuthorFilter, (v)=>{ dateLogAuthorFilter = v; }, renderDateLog);
  document.getElementById('dateLogRangeToggleBtn').addEventListener('click', ()=>{
    const row = document.getElementById('dateLogEndDateRow');
    const willShow = row.classList.contains('hidden');
    setRangeToggleState('dateLogEndDateRow', 'dateLogRangeToggleBtn', willShow);
    if(willShow){
      if(!document.getElementById('dateLogEndDate').value){
        document.getElementById('dateLogEndDate').value = document.getElementById('dateLogDate').value;
      }
    } else {
      document.getElementById('dateLogEndDate').value = '';
      document.getElementById('dateLogEndTime').value = '';
    }
  });
  function startEditDatelog(item){
    editingDatelogId = item.id;
    document.getElementById('dateLogDate').value = item.date;
    document.getElementById('dateLogTime').value = item.time || '';
    document.getElementById('dateLogTitle').value = item.title;
    document.getElementById('dateLogLocation').value = item.location || '';
    document.getElementById('dateLogLocationResults').classList.add('hidden');
    const statusEl0 = document.getElementById('dateLogLocationStatus');
    if(typeof item.lat === 'number' && typeof item.lng === 'number'){
      pendingDateLogGeo = { lat: item.lat, lng: item.lng };
      statusEl0.classList.remove('hidden');
      statusEl0.textContent = '✅ 저장된 위치가 있어';
      statusEl0.style.color = '#4A9B6E';
    } else {
      pendingDateLogGeo = null;
      statusEl0.classList.add('hidden');
    }
    document.getElementById('dateLogMemo').value = item.memo || '';
    if(document.getElementById('dateLogMemo')._autoGrowResize) document.getElementById('dateLogMemo')._autoGrowResize();
    if(item.endDate && item.endDate !== item.date){
      document.getElementById('dateLogEndDate').value = item.endDate;
      document.getElementById('dateLogEndTime').value = item.endTime || '';
      setRangeToggleState('dateLogEndDateRow', 'dateLogRangeToggleBtn', true);
    } else {
      document.getElementById('dateLogEndDate').value = '';
      document.getElementById('dateLogEndTime').value = '';
      setRangeToggleState('dateLogEndDateRow', 'dateLogRangeToggleBtn', false);
    }
    pendingDateLogPhotos = getItemPhotos(item).slice();
    renderPhotoPreviewGrid('dateLogPhotoPreviewWrap', ()=>pendingDateLogPhotos, (v)=>{ pendingDateLogPhotos = v; });
    dateLogSelectedParticipants = (item.participants || []).slice();
    renderParticipantChips('dateLogParticipantRow', dateLogSelectedParticipants);
    document.getElementById('dateLogAddBtn').textContent = '수정 완료';
    document.getElementById('dateLogCancelBtn').classList.remove('hidden');
    document.getElementById('dateLogAddBtn').closest('.add-card').scrollIntoView({behavior:'smooth', block:'start'});
  }
  function resetDatelogForm(){
    editingDatelogId = null;
    document.getElementById('dateLogTitle').value='';
    document.getElementById('dateLogLocation').value='';
    document.getElementById('dateLogLocationStatus').classList.add('hidden');
    document.getElementById('dateLogLocationResults').classList.add('hidden');
    pendingDateLogGeo = null;
    document.getElementById('dateLogMemo').value='';
    if(document.getElementById('dateLogMemo')._autoGrowResize) document.getElementById('dateLogMemo')._autoGrowResize();
    document.getElementById('dateLogTime').value='';
    document.getElementById('dateLogEndDate').value='';
    document.getElementById('dateLogEndTime').value='';
    setRangeToggleState('dateLogEndDateRow', 'dateLogRangeToggleBtn', false);
    document.getElementById('dateLogDate').value = localDateStr();
    revokePendingPhotoUrls(pendingDateLogPhotos);
    pendingDateLogPhotos = [];
    renderPhotoPreviewGrid('dateLogPhotoPreviewWrap', ()=>pendingDateLogPhotos, (v)=>{ pendingDateLogPhotos = v; });
    dateLogSelectedParticipants = [];
    renderParticipantChips('dateLogParticipantRow', dateLogSelectedParticipants);
    document.getElementById('dateLogAddBtn').textContent = '기록하기';
    document.getElementById('dateLogCancelBtn').classList.add('hidden');
  }
  document.getElementById('dateLogLocation').addEventListener('input', ()=>{
    pendingDateLogGeo = null;
    document.getElementById('dateLogLocationStatus').classList.add('hidden');
  });
  document.getElementById('dateLogLocation').addEventListener('keydown', (e)=>{
    if(e.key === 'Enter'){
      e.preventDefault();
      e.target.blur();
      setTimeout(()=>{ document.activeElement && document.activeElement.blur(); }, 0);
      document.getElementById('dateLogLocationSearchBtn').click();
    }
  });
  document.getElementById('dateLogLocationSearchBtn').addEventListener('click', async ()=>{
    const query = document.getElementById('dateLogLocation').value.trim();
    if(!query) return;
    const resultsEl = document.getElementById('dateLogLocationResults');
    document.getElementById('dateLogLocationStatus').classList.add('hidden');
    resultsEl.classList.remove('hidden');
    resultsEl.innerHTML = '';
    showLoadingOverlay('위치 찾는 중이야...');
    let results;
    try{
      results = await searchLocations(query);
    } finally {
      hideLoadingOverlay();
    }
    if(results.length === 0){
      resultsEl.innerHTML = `
        <div class="location-result-item">검색 결과가 없어. 다른 이름으로 시도해봐.</div>
        <button type="button" class="location-cancel-btn" id="dateLogLocationCancelBtn">✕ 취소</button>
      `;
      document.getElementById('dateLogLocationCancelBtn').addEventListener('click', ()=>{
        resultsEl.classList.add('hidden');
        resultsEl.innerHTML = '';
        document.getElementById('dateLogLocation').value = '';
      });
      return;
    }
    resultsEl.innerHTML = results.map((r,i)=>`
      <div class="location-result-item" data-idx="${i}">
        <div class="location-result-name">${escapeHTML(r.name)}</div>
        <div class="location-result-addr">${escapeHTML(r.address || '')}</div>
      </div>
    `).join('') + `<button type="button" class="location-cancel-btn" id="dateLogLocationCancelBtn">✕ 취소</button>`;
    document.getElementById('dateLogLocationCancelBtn').addEventListener('click', ()=>{
      resultsEl.classList.add('hidden');
      resultsEl.innerHTML = '';
      document.getElementById('dateLogLocation').value = '';
    });
    resultsEl.querySelectorAll('.location-result-item[data-idx]').forEach(el=>{
      el.addEventListener('click', ()=>{
        const r = results[Number(el.dataset.idx)];
        pendingDateLogGeo = { lat: r.lat, lng: r.lng };
        document.getElementById('dateLogLocation').value = r.name;
        resultsEl.classList.add('hidden');
        resultsEl.innerHTML = '';
        const statusEl = document.getElementById('dateLogLocationStatus');
        statusEl.classList.remove('hidden');
        statusEl.textContent = `✅ 이 위치로 선택했어: ${r.name}`;
        statusEl.style.color = '#4A9B6E';
      });
    });
  });
  document.getElementById('dateLogCancelBtn').addEventListener('click', resetDatelogForm);
// 1. 기록하기 / 수정 완료 버튼
  document.getElementById('dateLogAddBtn').addEventListener('click', async () => {
    const title = document.getElementById('dateLogTitle').value.trim();
    const date = document.getElementById('dateLogDate').value;
    const location = document.getElementById('dateLogLocation').value.trim();
    
    if (!title || !date) return;

    // 위치 검색 로직 (기존 거 그대로!)
    let geo = pendingDateLogGeo;
    if (!geo && location) {
      showLoadingOverlay('위치 확인 중이야...');
      try{
        const results = await searchLocations(location);
        geo = results[0] ? { lat: results[0].lat, lng: results[0].lng } : null;
      } finally {
        hideLoadingOverlay();
      }
    }
    
    // 이제 saveItem 하나로 끝!
    await saveItem(
      'datelog',
      !!editingDatelogId,
      editingDatelogId,
      { 
        title, 
        date,
        memo: document.getElementById('dateLogMemo').value.trim(),
        location: location,
        time: document.getElementById('dateLogTime').value || null,
        endDate: document.getElementById('dateLogEndDate').value || null,
        endTime: document.getElementById('dateLogEndTime').value || null,
        lat: geo ? geo.lat : null,
        lng: geo ? geo.lng : null,
        participants: dateLogSelectedParticipants.slice()
      },
      pendingDateLogPhotos,
      resetDatelogForm
    );
  });
  
// 2. 클릭 이벤트 (수정/삭제)
  document.getElementById('dateLogList').addEventListener('click', (e) => {
    const editBtn = e.target.closest('[data-edit-datelog]');
    const delBtn = e.target.closest('[data-del-datelog]');
    const editId = editBtn && editBtn.dataset.editDatelog;
    const delId = delBtn && delBtn.dataset.delDatelog;

    if (editId) startEditDatelog(dateLogs.find(s => s.id === editId));
    else if (delId) deleteItem('datelog', delId, dateLogs.find(s => s.id === delId));
  });

  // ---- 자유게시판 ----
  let editingBoardId = null;
  let boardPinEnabled = false;
  setupPhotoPicker('boardPhotoInput','boardPhotoBtn','boardPhotoPreviewWrap', ()=>pendingBoardPhotos, (v)=>{ pendingBoardPhotos = v; });
  setupAuthorFilterRow('boardFilterRow', ()=>boardAuthorFilter, (v)=>{ boardAuthorFilter = v; }, renderBoard);
  document.getElementById('boardPinToggle').addEventListener('click', ()=>{
    boardPinEnabled = !boardPinEnabled;
    document.getElementById('boardPinToggle').classList.toggle('active', boardPinEnabled);
  });

  function startEditBoard(item){
    editingBoardId = item.id;
    document.getElementById('boardTitle').value = item.title || '';
    document.getElementById('boardBody').value = item.body || '';
    if(document.getElementById('boardBody')._autoGrowResize) document.getElementById('boardBody')._autoGrowResize();
    pendingBoardPhotos = getItemPhotos(item).slice();
    renderPhotoPreviewGrid('boardPhotoPreviewWrap', ()=>pendingBoardPhotos, (v)=>{ pendingBoardPhotos = v; });
    boardPinEnabled = !!item.pinned;
    document.getElementById('boardPinToggle').classList.toggle('active', boardPinEnabled);

    document.getElementById('boardAddBtn').textContent = '수정 완료';
    document.getElementById('boardCancelBtn').classList.remove('hidden');
    document.getElementById('boardAddBtn').closest('.add-card').scrollIntoView({behavior:'smooth', block:'start'});
  }
  function resetBoardForm(){
    editingBoardId = null;
    document.getElementById('boardTitle').value = '';
    document.getElementById('boardBody').value = '';
    if(document.getElementById('boardBody')._autoGrowResize) document.getElementById('boardBody')._autoGrowResize();
    revokePendingPhotoUrls(pendingBoardPhotos);
    pendingBoardPhotos = [];
    renderPhotoPreviewGrid('boardPhotoPreviewWrap', ()=>pendingBoardPhotos, (v)=>{ pendingBoardPhotos = v; });
    boardPinEnabled = false;
    document.getElementById('boardPinToggle').classList.remove('active');
    document.getElementById('boardAddBtn').textContent = '게시하기';
    document.getElementById('boardCancelBtn').classList.add('hidden');
  }
  document.getElementById('boardCancelBtn').addEventListener('click', resetBoardForm);

  document.getElementById('boardAddBtn').addEventListener('click', async () => {
    const title = document.getElementById('boardTitle').value.trim();
    if (!title) return;
    const data = { title, body: document.getElementById('boardBody').value.trim(), pinned: boardPinEnabled };
    if(!editingBoardId){ data.likes = []; data.comments = []; }
    await saveItem('board', !!editingBoardId, editingBoardId, data, pendingBoardPhotos, resetBoardForm);
  });

  document.getElementById('boardList').addEventListener('click', (e) => {
    const editBtn = e.target.closest('[data-edit-board]');
    const delBtn = e.target.closest('[data-del-board]');
    const editId = editBtn && editBtn.dataset.editBoard;
    const delId = delBtn && delBtn.dataset.delBoard;
    if (editId) startEditBoard(boards.find(s => s.id === editId));
    else if (delId) deleteItem('board', delId, boards.find(s => s.id === delId));
  });


  // ---- 편지 ----
  let editingLetterId = null;
  let letterSelectedRecipients = [];
  renderParticipantChips('letterRecipientRow', letterSelectedRecipients);
  setupPhotoPicker('letterPhotoInput','letterPhotoBtn','letterPhotoPreviewWrap', ()=>pendingLetterPhotos, (v)=>{ pendingLetterPhotos = v; });

  function setLetterLockToggleState(show){
    document.getElementById('letterUnlockDateRow').classList.toggle('hidden', !show);
    document.getElementById('letterLockToggle').textContent = show ? '- 잠금 해제일 제거' : '+ 특정 날짜까지 잠그기 (선택)';
    if(!show){
      document.getElementById('letterUnlockDate').value = '';
      document.getElementById('letterUnlockTime').value = '';
    }
  }
  document.getElementById('letterLockToggle').addEventListener('click', ()=>{
    const row = document.getElementById('letterUnlockDateRow');
    const willShow = row.classList.contains('hidden');
    setLetterLockToggleState(willShow);
  });

  function startEditLetter(item){
    editingLetterId = item.id;
    document.getElementById('letterTitle').value = item.title || '';
    document.getElementById('letterBody').value = item.body || '';
    if(document.getElementById('letterBody')._autoGrowResize) document.getElementById('letterBody')._autoGrowResize();
    pendingLetterPhotos = getItemPhotos(item).slice();
    renderPhotoPreviewGrid('letterPhotoPreviewWrap', ()=>pendingLetterPhotos, (v)=>{ pendingLetterPhotos = v; });
    letterSelectedRecipients = (item.recipients || []).slice();
    renderParticipantChips('letterRecipientRow', letterSelectedRecipients);

    if(item.unlockAt){
      const [datePart, timePart] = toDateTimeLocalValue(item.unlockAt).split('T');
      document.getElementById('letterUnlockDate').value = datePart;
      document.getElementById('letterUnlockTime').value = timePart;
      setLetterLockToggleState(true);
    } else {
      setLetterLockToggleState(false);
    }

    document.getElementById('letterAddBtn').textContent = '수정 완료';
    document.getElementById('letterCancelBtn').classList.remove('hidden');
    document.getElementById('letterAddBtn').closest('.add-card').scrollIntoView({behavior:'smooth', block:'start'});
  }
  function resetLetterForm(){
    editingLetterId = null;
    document.getElementById('letterTitle').value = '';
    document.getElementById('letterBody').value = '';
    if(document.getElementById('letterBody')._autoGrowResize) document.getElementById('letterBody')._autoGrowResize();
    revokePendingPhotoUrls(pendingLetterPhotos);
    pendingLetterPhotos = [];
    renderPhotoPreviewGrid('letterPhotoPreviewWrap', ()=>pendingLetterPhotos, (v)=>{ pendingLetterPhotos = v; });
    letterSelectedRecipients = [];
    renderParticipantChips('letterRecipientRow', letterSelectedRecipients);
    setLetterLockToggleState(false);
    document.getElementById('letterAddBtn').textContent = '편지 보내기';
    document.getElementById('letterCancelBtn').classList.add('hidden');
  }
  document.getElementById('letterCancelBtn').addEventListener('click', resetLetterForm);
    
// 버튼 이벤트는 함수 바깥에!
  document.getElementById('letterAddBtn').addEventListener('click', async () => {
    const title = document.getElementById('letterTitle').value.trim();
    const body = document.getElementById('letterBody').value.trim();
    if (!title || !body) return;
    const recipients = letterSelectedRecipients.length ? letterSelectedRecipients.slice() : ALL_NAMES.slice();
    const lockOn = !document.getElementById('letterUnlockDateRow').classList.contains('hidden');
    const unlockDateVal = document.getElementById('letterUnlockDate').value;
    const unlockTimeVal = document.getElementById('letterUnlockTime').value || '00:00';
    const unlockAt = (lockOn && unlockDateVal) ? new Date(`${unlockDateVal}T${unlockTimeVal}`).getTime() : null;
    const data = { title, body, recipients, unlockAt };
    data.unlockNotified = unlockAt ? false : null;
    if(!editingLetterId){ data.likes = []; data.comments = []; }
    await saveItem('letters', !!editingLetterId, editingLetterId, data, pendingLetterPhotos, resetLetterForm);
  });

  document.getElementById('letterList').addEventListener('click', (e) => {
    const editBtn = e.target.closest('[data-edit-letter]');
    const delBtn = e.target.closest('[data-del-letter]');
    const editId = editBtn && editBtn.dataset.editLetter;
    const delId = delBtn && delBtn.dataset.delLetter;
    if (editId) startEditLetter(letters.find(s => s.id === editId));
    else if (delId) deleteItem('letters', delId, letters.find(s => s.id === delId));
  });


function watch(query, collectionName, onData){
    query.onSnapshot(snap=>{
      const items = [];
      snap.forEach(doc=> items.push({ id: doc.id, ...doc.data() }));
      onData(items);
    }, err=>{ console.error(collectionName+' 구독 오류', err); });
  }

  let watchersStarted = false;

  const EMAIL_MAP = {
    'sjsj980415@gmail.com': '소정',
    'xkakak456456@gmail.com': '지수',
    'qordnsqls@gmail.com': '운빈',
    'baekungyeong@gmail.com': '운경'
  };


  function showGate(message, hideLoginBtn){
    document.getElementById('loginGateMsg').innerHTML = message;
    document.getElementById('googleLoginBtn').classList.toggle('hidden', !!hideLoginBtn);
    document.getElementById('loginGate').classList.remove('hidden');
    document.querySelector('.app-shell').style.visibility = 'hidden';
  }
  function hideGate(){
    document.getElementById('loginGate').classList.add('hidden');
    document.querySelector('.app-shell').style.visibility = 'visible';
  }

  const VAPID_KEY = 'BIpLnOAlb1-74XAbEGzbxDkL0aSaFJD5MPxgDtI-oYtJLgvM9AQakApw157oC9pia6aHfxYmuR-xh_0-TXh0D7s';
  let pushToastTimer = null;
  let pushToastTab = null;
  let pushToastItemId = null;
  let pushToastCommentTs = null;
  let pushToastReplyTs = null;
  function showPushToast(title, tab, itemId, commentTs, replyTs){
    pushToastTab = tab || null;
    pushToastItemId = itemId || null;
    pushToastCommentTs = commentTs || null;
    pushToastReplyTs = replyTs || null;
    document.getElementById('pushToastTitle').textContent = title || '';
    document.getElementById('pushToastBody').textContent = '';
    const toast = document.getElementById('pushToast');
    toast.classList.remove('hidden');
    clearTimeout(pushToastTimer);
    pushToastTimer = setTimeout(()=>{ toast.classList.add('hidden'); }, 5000);
  }
  document.getElementById('pushToast').addEventListener('click', ()=>{
    document.getElementById('pushToast').classList.add('hidden');
    clearTimeout(pushToastTimer);
    if(pushToastItemId && pushToastTab) navigateToItem(pushToastTab, pushToastItemId, pushToastCommentTs, pushToastReplyTs);
    else if(pushToastTab) activateTab(pushToastTab);
  });

  async function setupPushNotifications(){
    try{
      if(!('serviceWorker' in navigator) || !('Notification' in window)) return;
      const registration = await navigator.serviceWorker.register('firebase-messaging-sw.js');
      const permission = await Notification.requestPermission();
      if(permission !== 'granted') return;
      const messaging = firebase.messaging();
      const token = await messaging.getToken({ vapidKey: VAPID_KEY, serviceWorkerRegistration: registration });
      if(token){
        await db.collection('fcmTokens').doc(identity).set({ token, updatedAt: Date.now() });
      }
      messaging.onMessage((payload)=>{
        showPushToast(
          payload.data && payload.data.title,
          payload.data && payload.data.tab,
          payload.data && payload.data.itemId,
          payload.data && payload.data.commentTs,
          payload.data && payload.data.replyTs
        );
      });
    }catch(e){
      console.error('푸시 알림 설정 실패', e);
    }
  }
  function maybeShowNotifPrompt(){
    if('Notification' in window && Notification.permission === 'default'){
      document.getElementById('notifPrompt').classList.remove('hidden');
    }
  }
  document.getElementById('notifEnableBtn').addEventListener('click', async ()=>{
    document.getElementById('notifPrompt').classList.add('hidden');
    showLoadingOverlay('알림 설정 중이야...');
    try{
      await setupPushNotifications();
    } finally {
      hideLoadingOverlay();
    }
  });
  document.getElementById('notifDismissBtn').addEventListener('click', ()=>{
    document.getElementById('notifPrompt').classList.add('hidden');
  });

function startWatchers(){
    if(watchersStarted) return;
    watchersStarted = true;

    // [일정/기념일/프로필] 홈 화면에 바로 필요해서 즉시 불러옴
    startCollectionWatcher('schedule');
    watchAnniversaries();
    watchProfiles();

    // [나머지 3개] 앱을 처음 켤 때 다 같이 무겁게 불러오지 않고,
    // 그 탭을 처음 열 때 그때 불러오도록 지연시킴 (아래 startCollectionWatcher 참고).
    // 다만 홈 화면의 "최근 활동/1년 전 오늘" 기능을 위해, 잠깐 쉬는 시간(유휴시간)에
    // 백그라운드로 조용히 불러와 두기는 함 (탭을 누르면 그 즉시 당겨서 불러옴).
    const lazyCollections = ['wish', 'datelog', 'letter', 'board'];
    const loadRestInBackground = () => lazyCollections.forEach(startCollectionWatcher);
    if('requestIdleCallback' in window){
      requestIdleCallback(loadRestInBackground, {timeout: 2000});
    } else {
      setTimeout(loadRestInBackground, 1200);
    }
  }

  function watchAnniversaries(){
    db.collection('anniversaries').onSnapshot(snap=>{
      anniversaries = [];
      snap.forEach(doc=> anniversaries.push({ id: doc.id, ...doc.data() }));
      renderHome();
      renderAnnivExistingList();
    }, err=>console.error('기념일 구독 실패', err));
  }

  // ---- 기념일 관리 모달 ----
  function renderAnnivExistingList(){
    const wrap = document.getElementById('annivExistingList');
    if(!wrap) return;
    if(anniversaries.length === 0){
      wrap.innerHTML = `<div style="font-size:13px; color:var(--plum-soft); padding:8px 0;">등록된 기념일이 없어</div>`;
      return;
    }
    wrap.innerHTML = anniversaries.map(a => `
      <div style="display:flex; align-items:center; justify-content:space-between; padding:8px 0; border-bottom:1px solid #F5EBEE;">
        <div style="font-size:14px;">
          ${escapeHTML(a.title)}
          <span style="font-size:11.5px; color:var(--plum-soft);">
            ${a.recurring===false ? `${a.year}.${a.month}.${a.day}` : `매년 ${a.month}/${a.day}`}
          </span>
        </div>
        <button type="button" class="del-btn" data-del-anniv="${a.id}">✕</button>
      </div>
    `).join('');
    wrap.querySelectorAll('[data-del-anniv]').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        if(confirm('이 기념일을 삭제할까?')){
          db.collection('anniversaries').doc(btn.dataset.delAnniv).delete().catch(e=>console.error(e));
        }
      });
    });
  }
  document.getElementById('annivAddBtn').addEventListener('click', ()=>{
    renderAnnivExistingList();
    document.getElementById('annivModal').classList.remove('hidden');
  });
  document.getElementById('annivCloseBtn').addEventListener('click', ()=>{
    document.getElementById('annivModal').classList.add('hidden');
  });
  document.getElementById('annivAddSaveBtn').addEventListener('click', async ()=>{
    const title = document.getElementById('annivTitleInput').value.trim();
    const dateVal = document.getElementById('annivDateInput').value;
    const recurring = document.getElementById('annivRecurringInput').checked;
    if(!title || !dateVal) return;
    const [y, m, d] = dateVal.split('-').map(Number);
    try{
      await db.collection('anniversaries').add({
        title, month: m, day: d,
        recurring,
        year: recurring ? null : y,
        createdBy: identity, createdAt: Date.now()
      });
      document.getElementById('annivTitleInput').value = '';
      document.getElementById('annivDateInput').value = '';
      document.getElementById('annivRecurringInput').checked = true;
    }catch(e){ console.error('기념일 추가 실패', e); alert('추가에 실패했어.'); }
  });

  function watchProfiles(){
    db.collection('profiles').onSnapshot(snap=>{
      profiles = {};
      snap.forEach(doc=>{ profiles[doc.id] = doc.data(); });
      renderStatusBoard();
    }, err=>console.error('프로필 구독 실패', err));
  }

  async function ensureMyProfile(){
    if(!identity) return;
    const ref = db.collection('profiles').doc(identity);
    const snap = await ref.get();
    if(!snap.exists){
      await ref.set({ colorKey: colorKeyOf(identity), status: { text:'', emoji:'', updatedAt: 0 } });
    }
  }

  const collectionWatchersStarted = { schedule:false, wish:false, datelog:false, letter:false, board:false };
  function startCollectionWatcher(tabName){
    if(collectionWatchersStarted[tabName]) return;
    collectionWatchersStarted[tabName] = true;

    if(tabName === 'schedule'){
      const threeMonthsAgo = new Date();
      threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
      const pastDateStr = localDateStr(threeMonthsAgo);
      const scheduleQuery = db.collection('schedule')
                              .where('date', '>=', pastDateStr)
                              .orderBy('date', 'asc');
      watch(scheduleQuery, 'schedule', items=>{ schedule = items; renderSchedule(); renderCalendar(); renderHome(); });
    } else if(tabName === 'wish'){
      const wishQuery = db.collection('wishlist').orderBy('createdAt', 'desc').limit(100);
      watch(wishQuery, 'wishlist', items=>{ wishes = items; renderWish(); renderHome(); });
    } else if(tabName === 'datelog'){
      const dateLogQuery = db.collection('datelog').orderBy('date', 'desc').limit(100);
      watch(dateLogQuery, 'datelog', items=>{ dateLogs = items; renderDateLog(); renderHome(); });
    } else if(tabName === 'board'){
      const boardQuery = db.collection('board').orderBy('createdAt', 'desc').limit(100);
      watch(boardQuery, 'board', items=>{ boards = items; renderBoard(); renderHome(); });
    } else if(tabName === 'letter'){
      const letterQuery = db.collection('letters').orderBy('createdAt', 'desc').limit(100);
      watch(letterQuery, 'letters', items=>{ letters = items; renderLetters(); renderHome(); });
    }
  }
  
// ---- 좋아요 버튼 클릭 이벤트 ----
  // ---- 게시물 요약 탭하면 펼치기/접기 ----
  document.querySelector('main').addEventListener('click', (e) => {
    const summary = e.target.closest('.post-summary');
    if (!summary) return;
    const card = summary.closest('[data-item-id]');
    const detail = card ? card.querySelector('.post-detail') : null;
    if (!detail) return;
    const id = card.dataset.itemId;
    if (openPostDetails.has(id)) {
      openPostDetails.delete(id);
      detail.classList.add('hidden');
      // 게시글을 닫으면 그 안의 댓글창 + 답글창 열림 상태도 같이 초기화
      const commentSection = detail.querySelector('.comment-section');
      if (commentSection) {
        const sectionKey = commentSection.id.replace(/^comments-/, '');
        openCommentSections.delete(sectionKey);
        commentSection.classList.remove('active');
        [...openReplyInputs].forEach(key => {
          if (key.startsWith(sectionKey + '-')) openReplyInputs.delete(key);
        });
        commentSection.querySelectorAll('.reply-input-row.active').forEach(row => row.classList.remove('active'));
      }
    } else {
      openPostDetails.add(id);
      detail.classList.remove('hidden');
    }
  });

  document.querySelector('main').addEventListener('click', (e) => {
    const likeBtn = e.target.closest('.like-btn');
    if (!likeBtn) return;
    
    // 눌린 버튼의 컬렉션(datelog, wishlist, board, letters)과 문서 ID 가져오기
    const col = likeBtn.dataset.likeCol;
    const id = likeBtn.dataset.likeId;
    
    // 현재 눌린 게시물 데이터 찾기
    let list = [];
    if (col === 'datelog') list = dateLogs;
    else if (col === 'letters') list = letters;
    else if (col === 'wishlist') list = wishes;
    else if (col === 'board') list = boards;
    
    const item = list.find(x => x.id === id);
    if (!item || !identity) return; // 로그인 안 되어 있으면 무시
    
    const currentLikes = item.likes || [];
    const hasLiked = currentLikes.includes(identity);
    
    // 1. 화면상에서 먼저 하트를 칠하고 통통 튀게 만들기 (미리 보여주기)
    likeBtn.classList.add('like-pop');
    if (!hasLiked) {
      likeBtn.classList.add('liked');
      likeBtn.querySelector('.heart-icon').innerHTML = pixelHeartSVG(true);
    }
    
    // 2. 0.3초(300ms) 동안 애니메이션이 끝나길 기다렸다가 DB에 저장!
    setTimeout(async () => {
      likeBtn.classList.remove('like-pop');
      try {
        if (hasLiked) {
          // 이미 눌렀으면 '내 이름' 빼기 (좋아요 취소)
          await db.collection(col).doc(id).update({ 
            likes: firebase.firestore.FieldValue.arrayRemove(identity) 
          });
        } else {
          // 안 눌렀으면 '내 이름' 추가 (좋아요)
          await db.collection(col).doc(id).update({ 
            likes: firebase.firestore.FieldValue.arrayUnion(identity) 
          });
        }
      } catch(err) {
        console.error('좋아요 업데이트 실패:', err);
      }
    }, 300);
  });

  // ---- 댓글 버튼 이벤트 (열기 / 작성 / 삭제) ----
  document.querySelector('main').addEventListener('click', (e) => {
    // 1. 댓글창 열기/닫기 토글
    const toggleBtn = e.target.closest('.comment-btn');
    if (toggleBtn) {
      const col = toggleBtn.dataset.toggleComment;
      const id = toggleBtn.dataset.toggleId;
      const sectionKey = `${col}-${id}`;
      
      if (openCommentSections.has(sectionKey)) {
        openCommentSections.delete(sectionKey);
        // 댓글창을 닫으면 그 안의 답글창들도 같이 초기화
        [...openReplyInputs].forEach(key => {
          if (key.startsWith(sectionKey + '-')) openReplyInputs.delete(key);
        });
        const section2 = document.getElementById(`comments-${sectionKey}`);
        if (section2) section2.querySelectorAll('.reply-input-row.active').forEach(row => row.classList.remove('active'));
      } else {
        openCommentSections.add(sectionKey);
      }
      
      const section = document.getElementById(`comments-${sectionKey}`);
      if (section) section.classList.toggle('active');
      return;
    }

    // 2. 댓글 작성
    const submitBtn = e.target.closest('.c-submit');
    if (submitBtn) {
      const col = submitBtn.dataset.commentSubmitCol;
      const id = submitBtn.dataset.commentSubmitId;
      const input = document.getElementById(`c-input-${col}-${id}`);
      const text = input.value.trim();
      if (!text || !identity) return;
      
      const newComment = {
        author: identity,
        text: text,
        ts: Date.now() // 고유 ID 역할
      };
      
      db.collection(col).doc(id).update({
        comments: firebase.firestore.FieldValue.arrayUnion(newComment)
      }).catch(err => console.error('댓글 작성 실패:', err));
      return;
    }

    // 3. 내 댓글 삭제
    const delBtn = e.target.closest('.c-del');
    if (delBtn) {
      const col = delBtn.dataset.commentCol;
      const id = delBtn.dataset.commentId;
      const ts = Number(delBtn.dataset.commentTs);
      
      // 어느 리스트에 있는지 찾기
      let list = [];
      if (col === 'datelog') list = dateLogs;
      else if (col === 'letters') list = letters;
      else if (col === 'wishlist') list = wishes;
      else if (col === 'board') list = boards;
      
      const item = list.find(x => x.id === id);
      if (!item) return;
      
      // 삭제할 정확한 댓글 객체 찾기 (시간과 작성자가 동일한 것)
      const targetComment = (item.comments || []).find(c => c.ts === ts && c.author === identity);
      if (!targetComment) return;

      const hasReplies = (targetComment.replies || []).length > 0;
      const confirmMsg = hasReplies
        ? '답글은 삭제되지 않아. 이 댓글을 지울까?'
        : '이 댓글을 지울까?';
      if (!confirm(confirmMsg)) return;

      if (hasReplies) {
        // 답글이 있으면 완전히 지우지 않고, 자리만 "삭제된 댓글이야"로 남겨서 답글을 보존
        (async () => {
          try {
            const ref = db.collection(col).doc(id);
            const snap = await ref.get();
            const comments = (snap.data().comments || []).map(c => {
              if (c.ts === ts && c.author === identity) {
                return { ts: c.ts, author: c.author, deleted: true, replies: c.replies || [] };
              }
              return c;
            });
            await ref.update({ comments });
          } catch (err) {
            console.error('댓글 삭제 실패:', err);
          }
        })();
      } else {
        db.collection(col).doc(id).update({
          comments: firebase.firestore.FieldValue.arrayRemove(targetComment)
        }).catch(err => console.error('댓글 삭제 실패:', err));
      }
      return;
    }

    // 4. 답글 입력창 열기/닫기
    const replyToggleBtn = e.target.closest('.reply-toggle-btn');
    if (replyToggleBtn) {
      const col = replyToggleBtn.dataset.replyToggleCol;
      const id = replyToggleBtn.dataset.replyToggleId;
      const ts = replyToggleBtn.dataset.replyToggleTs;
      const key = `${col}-${id}-${ts}`;
      if (openReplyInputs.has(key)) openReplyInputs.delete(key);
      else openReplyInputs.add(key);
      const row = document.getElementById(`reply-row-${col}-${id}-${ts}`);
      if (row) row.classList.toggle('active');
      return;
    }

    // 5. 답글 작성 (댓글 하나에 딱 1단계까지만)
    const replySubmitBtn = e.target.closest('.r-submit');
    if (replySubmitBtn) {
      const col = replySubmitBtn.dataset.replySubmitCol;
      const id = replySubmitBtn.dataset.replySubmitId;
      const parentTs = Number(replySubmitBtn.dataset.replySubmitParentTs);
      const input = document.getElementById(`r-input-${col}-${id}-${parentTs}`);
      const text = input ? input.value.trim() : '';
      if (!text || !identity) return;

      (async () => {
        try {
          const ref = db.collection(col).doc(id);
          const snap = await ref.get();
          const comments = (snap.data().comments || []).map(c => {
            if (c.ts === parentTs) {
              const replies = c.replies || [];
              return { ...c, replies: [...replies, { author: identity, text, ts: Date.now() }] };
            }
            return c;
          });
          await ref.update({ comments });
          if (input) input.value = '';
        } catch (err) {
          console.error('답글 작성 실패:', err);
        }
      })();
      return;
    }

    // 6. 내 답글 삭제
    const replyDelBtn = e.target.closest('.r-del');
    if (replyDelBtn) {
      if (!confirm('이 답글을 지울까?')) return;
      const col = replyDelBtn.dataset.commentCol;
      const id = replyDelBtn.dataset.commentId;
      const parentTs = Number(replyDelBtn.dataset.parentTs);
      const replyTs = Number(replyDelBtn.dataset.replyTs);

      (async () => {
        try {
          const ref = db.collection(col).doc(id);
          const snap = await ref.get();
          const comments = (snap.data().comments || [])
            .map(c => {
              if (c.ts === parentTs) {
                const newReplies = (c.replies || []).filter(r => !(r.ts === replyTs && r.author === identity));
                return { ...c, replies: newReplies };
              }
              return c;
            })
            // 이미 "삭제된 댓글이야"로 남아있던 자리인데 답글까지 0개가 되면, 그 자리 자체를 완전히 없앰
            .filter(c => !(c.deleted && (c.replies || []).length === 0));
          await ref.update({ comments });
        } catch (err) {
          console.error('답글 삭제 실패:', err);
        }
      })();
    }
  });

  // ---- 검색 (헤더 버튼 → 전체화면 오버레이) ----
  let searchCategory = 'all';


  function groupKeyForTimestamp(ts){
    const now = new Date();
    const curYear = now.getFullYear(), curMonth = now.getMonth();
    const d = new Date(ts);
    const y = d.getFullYear(), m = d.getMonth();
    if(y === curYear){
      if(m === curMonth) return null;
      return `month-${m}`;
    }
    return `year-${y}`;
  }

  function buildSearchIndex(){
    const items = [];
    schedule.forEach(it => items.push({
      tab:'schedule', label:'일정', ts: it.createdAt || new Date(it.date+'T00:00:00').getTime(),
      title: it.title, sub: it.memo || fmtShortDate(it.date), item: it,
      match: `${it.title||''} ${it.memo||''}`.toLowerCase()
    }));
    wishes.forEach(it => items.push({
      tab:'wish', label:'위시', ts: it.createdAt || 0,
      title: it.title, sub: it.body || '', item: it,
      match: `${it.title||''} ${it.body||''}`.toLowerCase()
    }));
    dateLogs.forEach(it => items.push({
      tab:'datelog', label:'데이트기록', ts: it.createdAt || new Date(it.date+'T00:00:00').getTime(),
      title: it.title, sub: it.memo || it.location || '', item: it,
      match: `${it.title||''} ${it.memo||''} ${it.location||''}`.toLowerCase()
    }));
    boards.forEach(it => items.push({
      tab:'board', label:'게시판', ts: it.createdAt || 0,
      title: it.title, sub: it.body || '', item: it,
      match: `${it.title||''} ${it.body||''}`.toLowerCase()
    }));
    letters.forEach(it => items.push({
      tab:'letter', label:'편지', ts: it.createdAt || 0,
      title: it.title || (it.body||'').slice(0,20), sub: it.body || '', item: it,
      match: `${it.title||''} ${it.body||''}`.toLowerCase()
    }));
    return items;
  }

  function renderSearchResults(){
    const container = document.getElementById('searchResults');
    const q = searchQuery.trim();
    if(!q){
      container.innerHTML = '<div class="empty-state" style="padding:30px 10px;">검색어를 입력해봐</div>';
      return;
    }
    let index = buildSearchIndex();
    if(searchCategory !== 'all') index = index.filter(r => r.tab === searchCategory);
    const results = index.filter(r => r.match.includes(q)).sort((a,b)=> b.ts - a.ts);
    if(results.length === 0){
      container.innerHTML = '<div class="empty-state" style="padding:30px 10px;">검색 결과가 없어.</div>';
      return;
    }
    container.innerHTML = results.map((r,i) => `
      <div class="search-result-item" data-result-idx="${i}">
        <span class="search-result-label">${r.label}</span>
        <div>
          <div class="search-result-title">${escapeHTML(r.title || '')}</div>
          ${r.sub ? `<div class="search-result-sub">${escapeHTML(r.sub.slice(0,44))}</div>` : ''}
        </div>
      </div>
    `).join('');
    container.querySelectorAll('.search-result-item').forEach((el,i)=>{
      el.addEventListener('click', ()=> navigateToSearchResult(results[i]));
    });
  }

  const TAB_TO_COL = { wish:'wishlist', datelog:'datelog', board:'board', letter:'letters' };

  function navigateToItem(tab, itemId, commentTs, replyTs){
    activateTab(tab);
    openPostDetails.add(itemId); // 데이터가 아직 안 왔어도, 오면 열려있도록 미리 기억해둠

    let item = null;
    if(tab === 'schedule') item = schedule.find(x=>x.id===itemId);
    else if(tab === 'wish') item = wishes.find(x=>x.id===itemId);
    else if(tab === 'datelog') item = dateLogs.find(x=>x.id===itemId);
    else if(tab === 'board') item = boards.find(x=>x.id===itemId);
    else if(tab === 'letter') item = letters.find(x=>x.id===itemId);

    if(item){
      if(tab === 'datelog'){
        const key = groupKeyForTimestamp(new Date(item.date + 'T00:00:00').getTime());
        if(key) dateLogExpandedGroups.add(key);
      } else if(tab === 'letter'){
        const key = groupKeyForTimestamp(item.createdAt || Date.now());
        if(key) letterExpandedGroups.add(key);
      } else if(tab === 'board'){
        const key = groupKeyForTimestamp(item.createdAt || Date.now());
        if(key) boardExpandedGroups.add(key);
      } else if(tab === 'wish' && item.done){
        showDoneWishes = true;
      }
    }

    // 댓글/답글 알림으로 들어온 경우 -> 댓글창도 미리 열려있게 기억
    if(commentTs && TAB_TO_COL[tab]){
      openCommentSections.add(`${TAB_TO_COL[tab]}-${itemId}`);
    }

    const renderMap = {
      schedule: renderSchedule,
      wish: renderWish,
      datelog: renderDateLog,
      board: renderBoard,
      letter: renderLetters
    };
    if(renderMap[tab]) renderMap[tab]();

    // 위시/데이트/편지/게시판은 탭을 처음 열 때 그제서야 데이터를 불러오기 시작해서
    // (지연 로딩) 카드가 화면에 아직 없을 수 있음. "스크롤해야 할 목표"를 전역 상태로
    // 기록해두고, 렌더될 때마다(각 renderXxx 함수 끝에서) + 화면이 다시 보이게 될 때마다
    // + 주기적으로(폴링) 계속 확인해서, 목표를 찾는 순간 스크롤함. 콜드 스타트(알림으로
    // 앱이 아예 새로 켜지는 경우)는 로그인 확인+데이터 연결까지 시간이 걸릴 수 있어서
    // 이렇게 여러 경로로 끈질기게 재시도하는 게 훨씬 안정적임.
    if(scrollPollInterval) clearInterval(scrollPollInterval); // 이전 목표용 폴링이 혹시 남아있으면 정리
    pendingScrollTarget = { tab, itemId, commentTs, replyTs };
    tryConsumePendingScroll(); // 지금 당장 한 번 시도

    // 위 즉시 시도 + 전역 등록된 visibilitychange/focus/pageshow로도 다 못 걸리는
    // 상황을 대비해서, 최대 10초 동안 0.5초마다 확인하는 최후의 안전장치도 같이 둠
    let pollCount = 0;
    scrollPollInterval = setInterval(() => {
      pollCount++;
      if(!pendingScrollTarget || pollCount > 20){
        clearScrollState();
        return;
      }
      tryConsumePendingScroll();
    }, 500);
  }
  function navigateToSearchResult(result){
    closeSearchOverlay();
    navigateToItem(result.tab, result.item.id);
  }

  function openSearchOverlay(){
    document.getElementById('searchOverlay').classList.remove('hidden');
    document.getElementById('searchInput').value = '';
    searchQuery = '';
    searchCategory = 'all';
    document.querySelectorAll('.search-cat-btn').forEach(b=> b.classList.toggle('active', b.dataset.cat === 'all'));
    renderSearchResults();
    setTimeout(()=> document.getElementById('searchInput').focus(), 50);
  }
  function closeSearchOverlay(){
    document.getElementById('searchOverlay').classList.add('hidden');
  }
  document.getElementById('searchOpenBtn').addEventListener('click', openSearchOverlay);
  document.getElementById('searchCloseBtn').addEventListener('click', closeSearchOverlay);
  let searchDebounceTimer = null;
  document.getElementById('searchInput').addEventListener('input', (e)=>{
    const value = e.target.value.toLowerCase();
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(()=>{
      searchQuery = value;
      renderSearchResults();
    }, 150);
  });
  document.getElementById('searchInput').addEventListener('keydown', (e)=>{
    if(e.key === 'Enter'){
      e.preventDefault();
      e.target.blur();
    }
  });
  document.querySelectorAll('.search-cat-btn').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      document.querySelectorAll('.search-cat-btn').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      searchCategory = btn.dataset.cat;
      renderSearchResults();
    });
  });

  
  let visitTracked = false;
  let visitWatchStarted = false;
  async function trackVisit(){
    if(visitTracked) return;
    visitTracked = true;
    try{
      const todayStr = localDateStr();
      const visitRef = db.collection('stats').doc('visits');
      await db.runTransaction(async (t)=>{
        const doc = await t.get(visitRef);
        if(!doc.exists){
          t.set(visitRef, { total: 1, todayCount: 1, todayDate: todayStr });
        } else {
          const data = doc.data();
          const newTotal = (data.total || 0) + 1;
          const newTodayCount = data.todayDate === todayStr ? (data.todayCount || 0) + 1 : 1;
          t.update(visitRef, { total: newTotal, todayCount: newTodayCount, todayDate: todayStr });
        }
      });
    }catch(e){ console.error('방문 기록 실패', e); }
  }
  function watchVisitCounter(){
    if(visitWatchStarted) return;
    visitWatchStarted = true;
    db.collection('stats').doc('visits').onSnapshot(doc=>{
      const todayEl = document.getElementById('visitToday');
      const totalEl = document.getElementById('visitTotal');
      if(!todayEl || !totalEl) return;
      const todayStr = localDateStr();
      if(doc.exists){
        const data = doc.data();
        const todayCount = (data.todayDate === todayStr) ? (data.todayCount || 0) : 0;
        todayEl.textContent = `Today ${todayCount}`;
        totalEl.textContent = `Total ${data.total || 0}`;
      } else {
        todayEl.textContent = 'Today 0';
        totalEl.textContent = 'Total 0';
      }
    }, err=>console.error('방문자 수 구독 실패', err));
  }

  document.querySelectorAll('#letterFilterRow .filter-chip').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const val = btn.dataset.letterFilter;
      letterFilterTarget = (val === 'all')
        ? 'all'
        : (letterFilterTarget === val ? 'all' : val);
      document.querySelectorAll('#letterFilterRow .filter-chip').forEach(b=>{
        b.classList.toggle('active', b.dataset.letterFilter === letterFilterTarget);
      });
      renderLetters();
    });
  });

  function init(){
    const versionTag = document.getElementById('appVersionTag');
    if(versionTag) versionTag.textContent = `v${APP_VERSION}`;
    renderHome();
    renderCalendar();
    document.getElementById('schedDate').value = localDateStr();
    document.getElementById('dateLogDate').value = localDateStr();
    setupAutoGrow('wishBody', 240);
    setupAutoGrow('dateLogMemo', 240);
    setupAutoGrow('letterBody', 280);
    setupAutoGrow('boardBody', 240);
    document.querySelector('.app-shell').style.visibility = 'hidden';

    firebase.auth().onAuthStateChanged(user=>{
      const splash = document.getElementById('splashScreen');
      if(splash) splash.classList.add('hidden');
      if(user && EMAIL_MAP[user.email]){
        loginInProgress = false;
        identity = EMAIL_MAP[user.email];
        updateIdentityChip();
        hideGate();
        ensureMyProfile();
        startWatchers();
        activateTabFromHash();
        trackVisit();
        watchVisitCounter();
        if('Notification' in window && Notification.permission === 'granted'){
          setupPushNotifications();
        } else {
          maybeShowNotifPrompt();
        }
      } else if(user && !EMAIL_MAP[user.email]){
        loginInProgress = false;
        firebase.auth().signOut();
        showGate('이 구글 계정은 사용할 수 없어.<br>백씨스터즈 멤버 계정으로만 로그인해줘.');
      } else if(!loginInProgress){
        // 로그인 처리 중에 이 콜백이 user=null 상태로 한 번 더 불릴 때가 있는데,
        // 그때는 "로그인 중이야..." 문구를 이 기본 문구로 덮어쓰지 않게 함
        showGate('백씨스터즈 멤버만 쓸 수 있는 앱이야.<br>구글 계정으로 로그인해줘.');
      }
    });
  }
    // [삭제 도우미]
  async function deleteItem(col, id, item) {
    askDeleteConfirm(async () => {
      showLoadingOverlay('삭제 중이야...<br>사진이 있으면 조금 걸릴 수 있어');
      try {
        if (item.photos) await deletePhotosFromStorage(item.photos);
        await db.collection(col).doc(id).delete();
      } catch (err) {
        console.error('삭제 실패:', err);
        alert('삭제 중 오류가 발생했어.');
      } finally {
        hideLoadingOverlay();
      }
    });
  }

  // [저장 도우미]
  async function saveItem(col, isEditing, id, data, pendingPhotos, onReset) {
    await saveWithPhotoFallback(
      async (withPhotos) => {
        const photos = withPhotos
          ? await uploadPhotos(pendingPhotos, (pct) => showLoadingOverlay(`게시 중이야... ${pct}%<br>사진 업로드 중이야`))
          : pendingPhotos.filter(p => typeof p === 'string');
        const payload = { ...data, photos };
        if (isEditing) payload.photo = firebase.firestore.FieldValue.delete();
        else payload.createdAt = Date.now();
        
        if (isEditing) await db.collection(col).doc(id).update(payload);
        else await db.collection(col).doc(genId()).set({ ...payload, author: identity });
      },
      onReset
    );
  }
  init();
})();
