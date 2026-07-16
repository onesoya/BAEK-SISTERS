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
  let pendingScheduleGeo = null;
  let scheduleSourceWish = null; // 위시에서 시작한 일정이면 { id, title }
  let dateLogSourceSchedule = null; // 일정에서 시작한 기록이면 { id, title, sourceWishId, date, time, endDate, endTime, location, lat, lng }
  let searchQuery = '';

  const USER_AGENT = navigator.userAgent || '';
  const IS_SAMSUNG_INTERNET = /Android/i.test(USER_AGENT) && /SamsungBrowser/i.test(USER_AGENT);
  let lastHandledSamsungPushKey = '';
  let samsungPendingClearTimer = null;
  // 로그인 확인보다 서비스워커 알림 이동정보가 먼저 도착했을 때 잠시 보관
  let deferredNavigateMessage = null;
  // setupPushNotifications()가 여러 번 불려도 onMessage 리스너가 중복 등록되지 않게
  let foregroundMessageUnsubscribe = null;

  // 4인 신원 체계
  const PERSON_COLOR = { '소정':'yellow', '지수':'red', '운빈':'green', '운경':'blue' };
  const ALL_NAMES = ['소정','지수','운빈','운경'];

  // 오늘의 질문 - 투표형(선택지) 질문을 만드는 헬퍼. 텍스트형과 섞여서 같은 배열에 들어감
  function poll(question, options){
    return { type: 'poll', question, options };
  }

  // ---- 오늘의 질문 100개 (카테고리별) ----
  // 서열/외모/능력 평가성 질문은 뺐고, 같은 카테고리가 연속으로 안 나오게
  // 아래에서 카테고리를 라운드로빈으로 섞어서 최종 순서를 만듦
  const DAILY_QUESTION_CATEGORIES = [
    [ // 1. 오늘과 요즘
      '오늘 하루를 이모지 하나로 표현한다면?', '지금 가장 먹고 싶은 음식은?', '오늘 제일 듣고 싶은 말은?',
      '지금 당장 하고 싶은 일은?', '오늘 있었던 가장 사소한 좋은 일은?', '요즘 나를 가장 피곤하게 하는 것은?',
      poll('오늘의 기분을 날씨로 표현한다면?', ['맑음','흐림','비','눈']), '지금 내 머릿속을 가장 많이 차지하는 생각은?',
      '오늘 나에게 점수를 준다면 100점 만점에 몇 점?', '지금 있는 장소에서 가장 마음에 드는 물건은?',
      '오늘 가장 많이 한 말은?', '오늘 가장 웃겼던 순간은?', '지금 당장 집에 가면 가장 먼저 할 일은?',
      '요즘 기다리고 있는 것은?', '오늘의 나에게 작은 상을 준다면 무엇을 주고 싶어?', '지금 듣고 있는 소리는?',
      '이번 주에 꼭 끝내고 싶은 일은?', '최근 새롭게 생긴 습관은?', '오늘 하루 중 다시 돌아가고 싶은 순간은?',
      '내일의 나에게 한마디 남긴다면?'
    ],
    [ // 2. 음식과 취향
      '평생 한 종류의 면 요리만 먹는다면?', poll('떡볶이는 밀떡파, 쌀떡파?', ['밀떡','쌀떡']), poll('탕수육은 부먹, 찍먹, 상관없음?', ['부먹','찍먹','상관없음']),
      '요즘 가장 자주 시켜 먹는 메뉴는?', '편의점에서 무조건 집는 것은?', '내가 가장 자신 있게 만들 수 있는 음식은?',
      '지금 냉장고에 꼭 있었으면 하는 것은?', '평생 포기하기 가장 어려운 음식은?', '최근 먹은 것 중 다시 먹고 싶은 것은?',
      '우리 넷이 함께 먹으러 가면 좋을 메뉴는?', poll('아침밥으로 가장 좋은 음식은?', ['밥','빵','시리얼','안 먹어']), '비 오는 날 생각나는 음식은?',
      poll('여행지에서 음식과 관광 중 더 중요한 것은?', ['음식','관광','둘 다 중요']), '카페에서 가장 자주 주문하는 메뉴는?',
      '남들은 좋아하지만 나는 별로인 음식은?', '남들은 별로라지만 나는 좋아하는 음식은?',
      poll('가장 좋아하는 아이스크림 맛은?', ['초코','바닐라','딸기','기타']), '야식으로 하나만 고른다면?', '지금까지 먹어본 것 중 가장 비쌌던 음식은?',
      '우리 가족 음식 중 가장 생각나는 메뉴는?'
    ],
    [ // 3. 콘텐츠와 소비 생활
      '요즘 가장 많이 듣는 노래는?', '최근 끝까지 재미있게 본 작품은?', '다시 처음부터 보고 싶은 드라마나 영화는?',
      '내 인생의 예능 프로그램 하나를 고른다면?', '최근 저장한 사진이나 영상은 무엇에 관한 것이었어?',
      '요즘 자주 보는 유튜브 콘텐츠는?', '좋아하는데 남들에게 잘 말하지 않는 콘텐츠는?',
      '한 작품 속 인물로 하루를 살아본다면 누구?', '지금 추천하고 싶은 노래 한 곡은?',
      '최근 가장 잘 샀다고 생각하는 물건은?', '장바구니에 오래 담겨 있는 물건은?', '돈이 아깝지 않은 소비는?',
      '돈이 조금 아까웠던 최근 소비는?', '10만 원이 갑자기 생기면 어디에 쓸 거야?',
      '가격을 보지 않고 하나 살 수 있다면 무엇을 사고 싶어?', '집에 이미 많은데 계속 사게 되는 물건은?',
      '내가 유독 까다롭게 고르는 물건은?', '최근 누군가에게 영업당한 것은?',
      '우리 중 한 명에게 선물을 준다면 누구에게 무엇을 주고 싶어?', '지금 내 휴대폰 배경화면은 무엇이야?'
    ],
    [ // 4. 서로를 알아가는 질문
      '우리 넷이 함께 있을 때 가장 좋은 점은?', '우리 넷이 만나면 꼭 하게 되는 행동은?',
      '최근 사촌 중 한 명 때문에 웃었던 순간은?', poll('고민이 있을 때 가장 원하는 반응은?', ['그냥 들어주기','해결책 말해주기','맛있는 거 사주기','혼자 둘 시간 주기']),
      poll('여행 계획은 어느 쪽이야?', ['꼼꼼하게 계획','큰 것만 계획','거의 즉흥','누군가를 따라가기']), poll('맛집을 고를 때 가장 중요한 것은?', ['맛','분위기','가격','거리']),
      poll('갑자기 여행 가자는 연락이 오면?', ['바로 간다','일정부터 확인','계획이 필요해','집이 좋아']), poll('무인도에 하나만 가져간다면?', ['칼','불 피울 도구','마실 물','통신 장비']),
      '우리 넷을 하나의 그룹명으로 다시 짓는다면?', '각자에게 어울리는 동물을 하나씩 정한다면?',
      '사촌들에게 아직 말하지 않았던 내 소소한 특징은?', '내가 생각하는 나의 첫인상과 실제 성격의 차이는?',
      '다른 세 사람에게 배우고 싶은 점은?', '사촌 중 한 명과 하루 동안 삶을 바꾼다면 누구?',
      '우리 넷이 함께 배워보고 싶은 것은?', '우리끼리 만들면 재미있을 전통은?',
      '넷이 여행 간다면 꼭 맡고 싶은 역할은?', '나와 가장 취향이 비슷하다고 느끼는 사람은?',
      '반대로 나와 취향이 가장 다르지만 재미있는 사람은?', '다음 모임에서 꼭 하고 싶은 것은?'
    ],
    [ // 5. 자매와 가족 이야기
      '내 자매와 가장 닮았다고 느끼는 부분은?', '내 자매와 정말 다르다고 느끼는 부분은?',
      '자매에게 고맙지만 평소 잘 말하지 못한 것은?', '어릴 때 자매와 가장 많이 다퉜던 이유는?',
      '지금 생각하면 웃긴 자매와의 싸움은?', '자매가 있어서 다행이라고 느낀 순간은?',
      '상대 자매쌍을 보며 우리 자매와 비슷하다고 느낀 점은?', '네 명 중 어릴 때와 가장 달라진 것 같은 사람은?',
      '가족 모임에서 가장 기억에 남는 사건은?', '어릴 때 우리 넷이 함께했던 일 중 다시 해보고 싶은 것은?'
    ],
    [ // 6. 상상하면 재미있는 질문
      '내일 갑자기 하루가 완전히 비면 무엇을 할 거야?', '한 달 동안 어느 도시에서든 살 수 있다면 어디?',
      poll('평생 여름과 겨울 중 하나만 살아야 한다면?', ['여름','겨울']), poll('과거와 미래 중 한 곳만 다녀올 수 있다면?', ['과거','미래']),
      '일주일 동안 다른 직업을 체험한다면 무엇?', '내 방에 비밀 공간을 하나 만들 수 있다면 무엇으로 꾸밀 거야?',
      poll('로또에 당첨되면 사촌들에게 가장 먼저 알릴 거야?', ['바로 알릴 거야','나만 알고 있을 거야']), '우리 넷이 가게를 연다면 어떤 가게가 어울릴까?',
      '넷이 함께 방송에 출연한다면 어떤 프로그램이 좋을까?', '10년 뒤에도 우리 넷이 꼭 함께하고 있었으면 하는 것은?'
    ]
  ];
  // 카테고리를 라운드로빈으로 섞어서 하나의 순서로 합침 (같은 카테고리 연속 방지)
  function buildQuestionBank(categories){
    const bank = [];
    const maxLen = Math.max(...categories.map(c => c.length));
    for(let i = 0; i < maxLen; i++){
      for(const cat of categories){
        if(i < cat.length) bank.push(cat[i]);
      }
    }
    return bank;
  }
  const DAILY_QUESTION_BANK = buildQuestionBank(DAILY_QUESTION_CATEGORIES);
  // 날짜마다 자동으로 질문 하나를 고르기 위한 기준일 - 다들 같은 날엔 같은 질문이 나오도록,
  // 순수하게 날짜 계산만으로 정해서 서버 조회 없이도 모든 기기에서 똑같이 계산됨
  function dailyQuestionIndexFor(dateStr){
    const epoch = new Date('2026-01-01T00:00:00');
    const target = new Date(dateStr + 'T00:00:00');
    const daysSinceEpoch = Math.floor((target - epoch) / (1000*60*60*24));
    return ((daysSinceEpoch % DAILY_QUESTION_BANK.length) + DAILY_QUESTION_BANK.length) % DAILY_QUESTION_BANK.length;
  }

  // 코드 새로 줄 때마다 이 값 올림 - 홈 화면 맨 아래에 표시돼서, 최신 버전이 실제로
  // 적용됐는지 앱만 열어봐도 바로 확인할 수 있게 해둠.
  const APP_VERSION = '2026.07.16-4';
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
  // 일정 작성자는 항상 참여자로 침 (본인 글에 참여 버튼 안 눌러도 무조건 참여 중인 걸로 표시)
  function getDisplayParticipants(item){
    const explicit = item.participants || [];
    if(item.author && !explicit.includes(item.author)){
      return [item.author, ...explicit];
    }
    return explicit;
  }

  // 백씨스터즈랑 벅구와 복덩이 앱 둘 다 onesoya.github.io 아래에 있어서(경로는 달라도)
  // localStorage는 "출처(origin)" 단위로 공유됨 - 그래서 deviceId, draft_* 같은 흔한
  // 이름의 키를 그냥 쓰면 두 앱이 서로의 값을 덮어쓸 수 있음. 이 앱 전용 접두사를 붙여서 분리함.
  const STORAGE_PREFIX = 'baek_sisters__';
  function appStorageKey(key){
    return STORAGE_PREFIX + key;
  }

  // 기기별로 안정적인 ID를 하나 만들어서 localStorage에 저장해둠 (브라우저 데이터를
  // 지우지 않는 한 계속 같은 값 - 같은 사람이 여러 기기에 로그인해도 기기마다 각자의
  // 알림 토큰을 따로 저장/관리할 수 있게 해줌)
  function getOrCreateDeviceId(){
    const key = appStorageKey('deviceId');
    let id = localStorage.getItem(key);
    if(!id){
      // 접두사 붙이기 전 공용 키에 값이 있었다면 한 번 가져와서 전용 키로 옮김
      // (기존에 등록해둔 기기 토큰 문서가 갑자기 고아가 되지 않도록)
      id = localStorage.getItem('deviceId');
      if(!id){
        id = 'dev_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
      }
      localStorage.setItem(key, id);
    }
    return id;
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
  // 삭제 권한: 본인 글이거나, 소정이면 누구 글이든 삭제 가능 (수정 권한은 그대로 본인만)
  function canDelete(authorName){
    if(authorName === undefined || authorName === null) return true;
    return authorName === identity || identity === '소정';
  }
  function getItemPhotos(item){
    if(item.photos && item.photos.length) return item.photos;
    if(item.photo) return [item.photo];
    return [];
  }
  // 복작방 글 미리보기 텍스트: 예전 글은 제목, 새 글은 본문, 본문도 없이 사진만 있으면
  // 사진이라고 표시, 아무것도 없으면(이론상 없어야 하지만) 기본 문구 - 검색/내 활동/홈
  // 피드에서 전부 이 함수로 통일해서 표시가 어긋나지 않게 함
  function boardPreviewText(item){
    return item.title || item.body || (getItemPhotos(item).length > 0 ? '📷 사진을 남겼어' : '한마디를 남겼어');
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
    if(!el) return;
    // 0.2초 사이에 화면이 다시 그려질 수 있어서(예: 개별 실시간 구독의 첫 응답 도착),
    // 지금 갖고 있는 요소 참조가 그 사이 stale해질 수 있음 - 나중에 다시 찾을 수 있는
    // 정보를 미리 저장해두고, 실제 스크롤 시점에 필요하면 새로 찾음
    const locator = {
      id: el.id || '',
      itemId: el.dataset ? (el.dataset.itemId || '') : '',
      commentAnchor: el.dataset ? (el.dataset.commentAnchor || '') : '',
      archiveDate: el.dataset ? (el.dataset.archiveDate || '') : '',
    };
    setTimeout(() => {
      let target = el;
      if(!target.isConnected){
        if(locator.id){
          target = document.getElementById(locator.id);
        } else {
          const activePanel = document.querySelector('.tab-panel.active');
          if(locator.itemId){
            target = activePanel && activePanel.querySelector(`[data-item-id="${locator.itemId}"]`);
          } else if(locator.commentAnchor){
            target = activePanel && activePanel.querySelector(`[data-comment-anchor="${locator.commentAnchor}"]`);
          } else if(locator.archiveDate){
            target = document.querySelector(`[data-archive-date="${locator.archiveDate}"]`);
          }
        }
      }
      if(!target || !target.isConnected) return;
      target.getBoundingClientRect(); // 스크롤 직전에 강제로 레이아웃 계산을 끝내게 함 (모바일에서 위치 계산이 덜 끝난 채로 스크롤되는 것 방지)
      target.scrollIntoView({behavior:'smooth', block:'center'});
      target.classList.add('search-flash');
      setTimeout(()=> { if(target && target.isConnected) target.classList.remove('search-flash'); }, 1600);
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

  // 알림 클릭 등으로 화면이 예상치 못하게 새로고침돼도 작성 중이던 글이 안 날아가게,
  // 입력할 때마다 브라우저에 조용히 임시저장해두고 화면이 새로 열릴 때 복원함.
  function setupDraftAutosave(storageKey, fieldIds){
    const finalStorageKey = appStorageKey(storageKey);
    try{
      const saved = localStorage.getItem(finalStorageKey);
      if(saved){
        const data = JSON.parse(saved);
        fieldIds.forEach(id => {
          const el = document.getElementById(id);
          if(el && data[id]){
            el.value = data[id];
            if(el._autoGrowResize) el._autoGrowResize();
          }
        });
      }
    }catch(e){ /* 무시 */ }

    const save = () => {
      const data = {};
      fieldIds.forEach(id => {
        const el = document.getElementById(id);
        if(el) data[id] = el.value;
      });
      try{ localStorage.setItem(finalStorageKey, JSON.stringify(data)); }catch(e){ /* 무시 */ }
    };
    fieldIds.forEach(id => {
      const el = document.getElementById(id);
      if(el) el.addEventListener('input', save);
    });
  }
  function clearDraftAutosave(storageKey){
    try{ localStorage.removeItem(appStorageKey(storageKey)); }catch(e){ /* 무시 */ }
  }

  function tryConsumePendingScroll(){
    if(!pendingScrollTarget) return;

    const { tab, itemId, commentTs, replyTs } = pendingScrollTarget;
    const card = document.querySelector(`[data-item-id="${itemId}"]`);

    // 아직 게시물 카드가 화면에 없으면 계속 기다림.
    // 게시물 삭제 여부는 아래 navigateToItem()의 4초 확인에서 따로 판단함.
    if(!card) return;

    // 게시물은 찾았으므로 상세 내용을 바로 펼침
    const detail = card.querySelector('.post-detail');
    if(detail) detail.classList.remove('hidden');

    // 게시물 자체를 가리키는 알림이면 성공
    if(!commentTs){
      clearScrollState();
      scrollToEl(card);
      return;
    }

    // 댓글 알림이면 댓글창까지 바로 열기
    const section = card.querySelector('.comment-section');
    if(section) section.classList.add('active');

    // 답글 알림이면 해당 댓글의 답글 입력창도 열어둠
    if(replyTs && tab && TAB_TO_COL[tab]){
      const replyKey = `${TAB_TO_COL[tab]}-${itemId}-${commentTs}`;
      const replyRow = document.getElementById(`reply-row-${replyKey}`);

      if(replyRow){
        replyRow.classList.add('active');
        openReplyInputs.add(replyKey);
      }
    }

    const anchorTs = replyTs || commentTs;
    const anchorEl = card.querySelector(
      `[data-comment-anchor="${anchorTs}"]`
    );

    // 댓글 또는 답글을 찾았으면 정상 스크롤
    if(anchorEl){
      clearScrollState();
      scrollToEl(anchorEl);
      return;
    }

    // 게시물은 있는데 댓글/답글 요소만 없음.
    // 렌더링이 아주 잠깐 늦은 것일 수 있으므로 400ms 뒤 Firestore 원본을 확인함.
    if(!pendingScrollTarget.commentCheckScheduled){
      pendingScrollTarget.commentCheckScheduled = true;
      const targetSnapshot = { ...pendingScrollTarget };

      setTimeout(() => {
        verifyMissingCommentTarget(targetSnapshot);
      }, 400);
    }
  }

  // 화면 탭 이름을 실제 Firestore 컬렉션 이름으로 변환 (TAB_TO_COL과는 별개 -
  // TAB_TO_COL은 댓글창 DOM ID를 만들 때 쓰고, 이건 Firestore 문서를 직접 조회할 때 씀.
  // schedule도 포함해야 해서 - 일정은 댓글이 없어도 게시물 삭제 확인은 필요함)
  const TAB_TO_COLLECTION = {
    schedule: 'schedule',
    wish: 'wishlist',
    datelog: 'datelog',
    board: 'board',
    letter: 'letters'
  };

  // 비동기 확인을 하는 동안 사용자가 다른 알림을 눌렀는지 확인.
  // 다른 대상으로 이동한 상태라면 이전 확인 결과를 화면에 띄우지 않음.
  function isSamePendingTarget(target){
    const current = pendingScrollTarget;
    if(!current) return false;

    return (
      current.tab === target.tab &&
      current.itemId === target.itemId &&
      String(current.commentTs || '') === String(target.commentTs || '') &&
      String(current.replyTs || '') === String(target.replyTs || '')
    );
  }

  // 게시물은 화면에 나타났는데 특정 댓글/답글을 찾지 못했을 때,
  // Firestore의 최신 원본 문서를 직접 확인함.
  async function verifyMissingCommentTarget(target){
    const col = TAB_TO_COLLECTION[target.tab];
    if(!col || !isSamePendingTarget(target)) return;

    try{
      // 캐시가 아니라 서버의 최신 문서로 확인
      const snap = await db
        .collection(col)
        .doc(target.itemId)
        .get({ source: 'server' });

      // 확인하는 사이 다른 알림으로 이동했다면 무시
      if(!isSamePendingTarget(target)) return;

      // 게시물 자체가 없어졌다면 게시물 삭제 안내
      if(!snap.exists){
        clearScrollState();
        showPushToast('삭제된 게시물이야', null, null, null, null, true);
        return;
      }

      const itemData = snap.data() || {};
      const comments = itemData.comments || [];

      const parentComment = comments.find((comment) =>
        String(comment.ts) === String(target.commentTs)
      );

      // 부모 댓글이 완전히 삭제된 경우
      if(!parentComment){
        const card = document.querySelector(
          `[data-item-id="${target.itemId}"]`
        );

        clearScrollState();

        // 게시물은 있으므로 게시물 카드로 이동
        if(card) scrollToEl(card);

        showPushToast('해당 댓글은 삭제됐어', null, null, null, null, true);
        return;
      }

      // 부모 댓글은 있지만 특정 답글이 삭제된 경우
      if(target.replyTs){
        const replies = parentComment.replies || [];

        const replyExists = replies.some((reply) =>
          String(reply.ts) === String(target.replyTs)
        );

        if(!replyExists){
          const card = document.querySelector(
            `[data-item-id="${target.itemId}"]`
          );

          // 답글이 달렸던 부모 댓글 위치가 남아 있으면 그쪽으로 이동
          const parentEl = card && card.querySelector(
            `[data-comment-anchor="${target.commentTs}"]`
          );

          clearScrollState();

          if(parentEl) scrollToEl(parentEl);
          else if(card) scrollToEl(card);

          showPushToast('해당 답글은 삭제됐어', null, null, null, null, true);
          return;
        }
      }

      // Firestore에는 댓글/답글이 존재함.
      // DOM 렌더링만 늦은 상황이므로 pending 상태를 유지하고 계속 재시도함.
    }catch(err){
      console.warn('댓글 삭제 여부 확인 실패:', err);

      // 일시적인 네트워크 오류일 수 있으므로 삭제됐다고 단정하지 않음.
      // 다음 렌더 또는 폴링에서 다시 찾도록 상태를 유지함.
      if(isSamePendingTarget(target)){
        pendingScrollTarget.commentCheckScheduled = false;
      }
    }
  }

  // 게시물 카드가 일정 시간 동안 나타나지 않을 때,
  // 실제로 문서가 삭제됐는지 Firestore 서버에서 확인함.
  async function verifyDeletedPostTarget(target){
    const col = TAB_TO_COLLECTION[target.tab];
    if(!col || !isSamePendingTarget(target)) return;

    try{
      const snap = await db
        .collection(col)
        .doc(target.itemId)
        .get({ source: 'server' });

      if(!isSamePendingTarget(target)) return;

      if(!snap.exists){
        clearScrollState();
        showPushToast('삭제된 게시물이야', null, null, null, null, true);
      }

      // 문서가 존재한다면 단순 데이터 로딩 지연일 수 있으므로 계속 기다림
    }catch(err){
      console.warn('게시물 삭제 여부 확인 실패:', err);
      // 네트워크 오류일 수 있으므로 삭제됐다고 표시하지 않음
    }
  }

  // 화면이 다시 보이게 되는 걸 알려주는 이벤트들 - 여러 번 호출부에서 등록하지 않고
  // 여기서 한 번만 전역으로 등록해둠 (기명 함수라 중복 등록은 원래도 안 됐지만, 구조상 더 깔끔하게)
  function checkPendingPush(){
    postToActiveServiceWorker({ type: 'CHECK_PENDING_NOTIF' });
  }

  // 화면 복귀 시 예약된 재확인 타이머 - 한 번만 확인하고 끝내지 않고, 아이폰에서
  // 서비스워커와의 연결이 조금 늦게 복구되는 경우를 대비해 몇 차례 더 재시도함.
  let resumeRetryTimers = [];
  function handleAppResume(){
    if(document.visibilityState !== 'visible') return;
    resumeRetryTimers.forEach(clearTimeout);
    resumeRetryTimers = [];

    // 밤새 화면이 꺼져 있었다가 다음 날 다시 켰을 때, 1분 타이머를 기다리지 않고
    // 바로 오늘 질문/오늘의 우리 카드로 교체되게 함
    if(identity){
      watchDailyQuestion();
      renderTodayUsCard();
    }

    // 예전엔 여기서 앱을 열 때마다 CLEAR_ALL_NOTIFICATIONS를 보내서 잠금화면/알림창의
    // 알림을 전부 지웠는데, 이러면 "안 읽음 = 실제로 확인/삭제 안 한 것" 기준과 어긋남
    // (알림을 읽지도 않았는데 시스템 알림만 사라져서 헷갈릴 수 있음). 그래서 뺐음 -
    // 이제 시스템 알림은 "전체 삭제" 버튼을 누르거나, 개별 알림을 읽음/삭제 처리할 때만 지워짐.

    const runResumeCheck = () => {
      checkPendingPush();       // 놓친 알림 있는지 서비스워커에 확인
      tryConsumePendingScroll(); // 이미 이동 명령을 받았다면 스크롤도 다시 시도
    };

    if(IS_SAMSUNG_INTERNET){
      // 삼성인터넷은 focus() 과정에서 최초 실행 상태를 다시 복원할 수 있어서,
      // 그 복원이 어느 정도 끝난 다음에 새 알림 정보를 확인하도록 함
      // (복귀 즉시 확인하면 그 직후 복원 과정이 결과를 덮어써버리는 것으로 보임)
      resumeRetryTimers.push(
        setTimeout(runResumeCheck, 700),
        setTimeout(runResumeCheck, 1500),
        setTimeout(runResumeCheck, 2600)
      );
    } else {
      // 아이폰·아이패드·그 외 브라우저는 기존 방식 유지
      runResumeCheck();
      resumeRetryTimers.push(
        setTimeout(runResumeCheck, 300),
        setTimeout(runResumeCheck, 1000),
        setTimeout(runResumeCheck, 2000)
      );
    }
  }

  document.addEventListener('visibilitychange', () => {
    if(document.visibilityState === 'visible') handleAppResume();
  });
  window.addEventListener('load', handleAppResume);
  window.addEventListener('focus', handleAppResume);
  window.addEventListener('pageshow', handleAppResume);

  // 아이폰 PWA가 화면 복귀 이벤트(focus/pageshow/visibilitychange)를 전부 놓치는
  // 경우까지 대비한 감시 장치. 화면이 꺼져있는 동안 멈췄던 타이머가 다시 움직이기
  // 시작하면("시간 간격이 갑자기 벌어졌다 정상화됨") 앱이 복귀한 것으로 판단함.
  // 평소엔 시간 차이만 계산하는 가벼운 작업이고, 복귀가 감지될 때만 확인 작업을 함.
  let lastResumeTick = Date.now();
  setInterval(() => {
    const now = Date.now();
    const timerWasSuspended = now - lastResumeTick > 2500;
    lastResumeTick = now;
    if(timerWasSuspended && document.visibilityState === 'visible'){
      handleAppResume();
    }
  }, 1000);

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
          ${canDelete(r.author) ? `<button class="r-del" data-comment-col="${colName}" data-comment-id="${item.id}" data-parent-ts="${c.ts}" data-reply-ts="${r.ts}">✕</button>` : ''}
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
        ${canDelete(c.author) ? `<button class="c-del" data-comment-col="${colName}" data-comment-id="${item.id}" data-comment-ts="${c.ts}">✕</button>` : ''}
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

  // ---- 사진 확대뷰 (핀치줌 / 팬 / 스와이프 넘기기 / 아래로 밀어 닫기 / 더블탭) ----
  // 오늘의 한 장 아카이브에서도 같은 뷰어를 쓸 수 있도록 여는 함수를 바깥에 연결함.
  let openPhotoLightbox = null;
  (function(){
    const lightbox = document.getElementById('photoLightbox');
    const stage = document.getElementById('lightboxStage');
    const img = document.getElementById('lightboxImg');
    const closeBtn = document.getElementById('lightboxClose');
    const prevBtn = document.getElementById('lightboxPrev');
    const nextBtn = document.getElementById('lightboxNext');
    const counter = document.getElementById('lightboxCounter');
    const viewPostBtn = document.getElementById('lightboxViewPostBtn');

    let scale = 1, panX = 0, panY = 0;
    let startScale = 1, startDist = 0;
    let startTouchX = 0, startTouchY = 0;
    let isPanning = false, isPinching = false;
    let lastTapTime = 0;
    let swipeStartX = 0, swipeStartY = 0, swipeActive = false;

    let currentPhotos = [];
    let currentPostIds = [];
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
      const postId = currentPostIds[currentIndex] || '';
      viewPostBtn.classList.toggle('hidden', !postId);
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
    function openLightbox(photos, index, postIds){
      currentPhotos = photos;
      currentPostIds = Array.isArray(postIds) ? postIds : [];
      currentIndex = index;
      showCurrentPhoto();
      lightbox.classList.remove('hidden');
    }
    function closeLightbox(){
      lightbox.classList.add('hidden');
      img.src = '';
      currentPhotos = [];
      currentPostIds = [];
      currentIndex = 0;
      resetTransform();
    }
    openPhotoLightbox = openLightbox;
    closeBtn.addEventListener('click', closeLightbox);
    prevBtn.addEventListener('click', goPrev);
    nextBtn.addEventListener('click', goNext);
    viewPostBtn.addEventListener('click', ()=>{
      const postId = currentPostIds[currentIndex];
      if(!postId) return;
      closeLightbox();
      openDailyPhotoArchivePost(postId);
    });
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
          // 기본 배율에서 아래로 충분히 밀면 닫음. 확대 중에는 swipeActive가
          // 켜지지 않으므로 사진을 아래로 팬하는 동작과 충돌하지 않음.
          if(dy > 90 && Math.abs(dy) > Math.abs(dx) * 1.15){
            closeLightbox();
          } else if(Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)){
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
        openLightbox(imgs.map(i=>i.src), imgs.indexOf(target), []);
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
  // 같은 일정 장소를 그대로 상속해서 여러 명이 기록하면 좌표가 완전히 같아져 마커가 겹칠 수 있음 -
  // 좌표가 같은(소수점 5자리까지) 기록들을 한 그룹으로 묶어서 마커 하나 + 목록 팝업으로 보여줌
  function mapGroupKey(item){
    if(typeof item.lat !== 'number' || typeof item.lng !== 'number') return null;
    return item.lat.toFixed(5) + ':' + item.lng.toFixed(5);
  }
  function renderDateMapMarkers(pts){
    const groups = new Map();
    pts.forEach(item=>{
      const key = mapGroupKey(item);
      if(!key) return;
      if(!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    });
    if(dateLogMarkersLayer) dateLogMapInstance.removeLayer(dateLogMarkersLayer);
    dateLogMarkersLayer = L.layerGroup();
    groups.forEach(items=>{
      const first = items[0];
      const marker = L.marker([first.lat, first.lng], { icon: heartMarkerIcon() });
      if(items.length === 1){
        const photo = getItemPhotos(first)[0];
        marker.bindPopup(
          `<b>${escapeHTML(first.title)}</b><br><span style="color:#8A7A86;font-size:11px;">${fmtShortDate(first.date)} · ${first.author||''}</span>` +
          (photo ? `<br><img src="${photo}" style="width:110px;border-radius:8px;margin-top:4px;">` : '')
        );
      } else {
        // 같은 좌표에 여러 기록 - 하나의 팝업 안에 각자의 기록을 목록으로
        const placeName = first.location || first.title;
        const listHTML = items.map(item=>{
          const photo = getItemPhotos(item)[0];
          return `<div style="display:flex;gap:6px;align-items:center;margin-top:6px;">
            ${photo ? `<img src="${photo}" style="width:34px;height:34px;border-radius:6px;object-fit:cover;flex-shrink:0;">` : ''}
            <div>
              <div style="font-size:12px;color:#4A3548;">${escapeHTML(item.author||'')}의 기록</div>
              <div style="font-size:11px;color:#8A7A86;">${fmtShortDate(item.date)}</div>
            </div>
          </div>`;
        }).join('');
        marker.bindPopup(`<b>${escapeHTML(placeName)}</b>${listHTML}`);
      }
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
  }
  async function openDateMap(){
    document.getElementById('dateMapModal').classList.remove('hidden');
    setTimeout(async ()=>{
      if(!dateLogMapInstance){
        dateLogMapInstance = L.map('dateMapContainer', { attributionControl: true });
        L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
          attribution: '&copy; OpenStreetMap &copy; CARTO',
          maxZoom: 20,
          subdomains: 'abcd'
        }).addTo(dateLogMapInstance);
      }
      // 우선 로컬(최근 100개)로 바로 한 번 그려서 지도가 빨리 뜨게 함
      let pts = dateLogs.filter(d => typeof d.lat === 'number' && typeof d.lng === 'number');
      renderDateMapMarkers(pts);

      // 최근 100개 제한과 무관하게, 전체 기록을 별도로 다시 조회해서 갱신
      // (사람별 기록이 쌓이면 100개가 금방 차서 오래된 좌표가 누락될 수 있음)
      try{
        const snap = await db.collection('datelog').get();
        const allPts = [];
        snap.forEach(doc=>{
          const data = doc.data();
          if(typeof data.lat === 'number' && typeof data.lng === 'number'){
            allPts.push({ id: doc.id, ...data });
          }
        });
        if(dateLogMapInstance) renderDateMapMarkers(allPts);
      }catch(e){
        console.error('지도 전체 좌표 조회 실패', e);
        // 실패해도 이미 로컬 기준으로 그려둔 지도는 그대로 보여줌
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
    const participants = getDisplayParticipants(item);
    const joined = identity && participants.includes(identity);
    const canWriteMemory = canWriteDateLogForSchedule(item);
    const linkedDateLogs = item.isDate ? findDateLogsForSchedule(item.id) : [];
    const myDateLog = linkedDateLogs.find(log => log.author === identity) || null;
    const recordedNames = [...new Set(linkedDateLogs.map(log => log.author).filter(Boolean))];
    return `<div class="item-card ${isPast(item)?'past':''} ${item.isDate?'date-plan-card':''}" data-item-id="${item.id}">
      <div class="date-badge"><div class="day">${d.day}</div><div class="mon">${d.mon}</div></div>
      <div class="item-body">
        <div class="item-title">${escapeHTML(item.title)}${item.isDate ? ' ' + pixelHeartSVG(true, 16) : ''}</div>
        ${hasExtra ? `<div class="item-memo">${extraLabel}</div>` : ''}
        ${item.memo ? `<div class="item-memo">${escapeHTML(item.memo)}</div>` : ''}
        ${item.location ? `<div class="item-memo">📍 ${escapeHTML(item.location)}</div>` : ''}
        <div class="item-meta">${authorTagHTML(item.author)}</div>
        ${item.sourceWishId ? `<button type="button" class="source-link-btn" data-open-source-wish="${item.sourceWishId}">💫 관련 위시 보기</button>` : ''}
        ${item.isDate ? `
          <div class="home-next-participants">
            ${participants.map(p => `<span class="recipient-chip color-${colorKeyOf(p)}">${p}</span>`).join('')}
          </div>
          ${!isPast(item) && !isMine(item) ? `<button type="button" class="date-plan-toggle ${joined?'active':''}" data-join-schedule="${item.id}" data-joined="${joined}" style="margin-top:8px;">${joined ? '참여 취소' : '참여할래'}</button>` : ''}
          ${recordedNames.length > 0 ? `
            <div class="schedule-memory-people">기록을 남긴 사람
              <span class="home-next-participants">${recordedNames.map(n => `<span class="recipient-chip color-${colorKeyOf(n)}">${escapeHTML(n)}</span>`).join('')}</span>
            </div>
          ` : ''}
          ${canWriteMemory ? `
            <button type="button" class="schedule-memory-btn ${myDateLog ? 'completed' : ''}" data-schedule-memory="${item.id}">${myDateLog ? '💛 내 기록 보기' : '✍️ 내 기록 남기기'}</button>
          ` : ''}
        ` : ''}
      </div>
      ${isMine(item) ? `<button class="edit-btn" data-edit-schedule="${item.id}">${pixelEditSVG()}</button>` : ''}
      ${canDelete(item.author) ? `<button class="del-btn" data-del-schedule="${item.id}">✕</button>` : ''}
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
      toggleBtn.classList.remove('past-open');
      pastSection.classList.add('hidden');
      tryConsumePendingScroll();
      return;
    }
    filterNotice.classList.add('hidden');

    if(scheduleData.length === 0){
      list.innerHTML = '<div class="empty-state"><span class="empty-emoji">🗓️</span>아직 등록된 일정이 없어.<br>첫 일정을 추가해볼까?</div>';
      toggleBtn.classList.add('hidden');
      toggleBtn.classList.remove('past-open');
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
      toggleBtn.classList.toggle('past-open', showPastSchedule);
      pastSection.classList.toggle('hidden', !showPastSchedule);
      pastSection.innerHTML = past.map(scheduleCardHTML).join('');
    } else {
      toggleBtn.classList.add('hidden');
      toggleBtn.classList.remove('past-open');
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
    const linkedSchedule = findScheduleForWish(item.id);
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
          <button type="button" class="source-link-btn" data-plan-or-view-wish="${item.id}">${linkedSchedule ? '📅 일정 보기' : '📅 날짜 잡기'}</button>
          <div class="wish-footer">
            <div style="display:flex;align-items:center;gap:6px;justify-content:flex-end;width:100%;">
              <button class="wish-check ${item.done?'checked':''}" data-check-wish="${item.id}">${item.done ? '✓ 완료함' : '완료로 표시'}</button>
              ${isMine(item) ? `<button class="edit-btn" data-edit-wish="${item.id}">${pixelEditSVG()}</button>` : ''}
              ${canDelete(item.author) ? `<button class="del-btn" data-del-wish="${item.id}">✕</button>` : ''}
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
        : '<div class="empty-state"><span class="empty-emoji">💭</span>해당하는 게 없어.</div>';
      toggleBtn.classList.add('hidden');
      toggleBtn.classList.remove('past-open');
      doneSection.classList.add('hidden');
      tryConsumePendingScroll();
      return;
    }
    const active = wishData.filter(w=>!w.done);
    const done = wishData.filter(w=>w.done);

    list.innerHTML = active.length === 0
      ? '<div class="empty-state"><span class="empty-emoji">🎉</span>다 완료했어! 새로운 걸 적어볼까?</div>'
      : active.map(wishCardHTML).join('');

    if(done.length > 0){
      toggleBtn.classList.remove('hidden');
      toggleBtn.textContent = showDoneWishes ? '완료한 것 숨기기' : `완료한 것 ${done.length}개 보기`;
      toggleBtn.classList.toggle('past-open', showDoneWishes);
      doneSection.classList.toggle('hidden', !showDoneWishes);
      doneSection.innerHTML = done.map(wishCardHTML).join('');
    } else {
      toggleBtn.classList.add('hidden');
      toggleBtn.classList.remove('past-open');
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
          ${item.sourceScheduleId ? `<button type="button" class="source-link-btn" data-open-source-schedule="${item.sourceScheduleId}">🗓️ 관련 일정 보기</button>` : ''}
          ${item.sourceWishId ? `<button type="button" class="source-link-btn" data-open-source-wish="${item.sourceWishId}">💫 관련 위시 보기</button>` : ''}

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
              ${isMine(item) ? `<button class="edit-btn" data-edit-datelog="${item.id}">${pixelEditSVG()}</button>` : ''}
              ${canDelete(item.author) ? `<button class="del-btn" data-del-datelog="${item.id}">✕</button>` : ''}
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
    // 복작방은 "가볍게 들락거리는" 게 목적이라, 위시/편지처럼 눌러서 펼치는 방식이 아니라
    // 작성자·날짜·본문·사진·좋아요/댓글 버튼이 전부 바로 보이는 피드형으로 구성함.
    // (댓글 목록/입력창만 기존처럼 버튼을 눌러야 펼쳐짐 - 그건 다른 탭들과 동일한 패턴)
    return `<div class="wish-card board-feed-card ${item.pinned?'pinned-card':''}" data-item-id="${item.id}">
      <div class="wish-content">
        <div class="board-feed-header">
          ${item.pinned ? `<div class="pinned-badge">📌 공지</div>` : ''}
          <div class="post-summary-meta" style="margin-top:0;">${authorTagHTML(item.author)}<span>${dateStr}</span></div>
          ${isMine(item) && item.postType !== 'dailyPhoto' ? `<button class="edit-btn" data-edit-board="${item.id}">${pixelEditSVG()}</button>` : ''}
          ${canDelete(item.author) ? `<button class="del-btn" data-del-board="${item.id}">✕</button>` : ''}
        </div>
        ${item.title ? `<div class="board-feed-title">${escapeHTML(item.title)}</div>` : ''}
        ${item.body ? `<div class="wish-body">${escapeHTML(item.body)}</div>` : ''}
        ${cardPhotosHTML(item)}
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
    </div>`;
  }
function renderBoard() {
  const list = document.getElementById('boardList');
  const boardData = boardAuthorFilter === 'all' ? boards : boards.filter(b => b.author === boardAuthorFilter);
  if(boardData.length === 0){
    list.innerHTML = boardAuthorFilter === 'all'
      ? '<div class="empty-state"><span class="empty-emoji">📋</span>아직 남긴 한마디가 없어.<br>먼저 가볍게 말을 걸어볼까?</div>'
      : '<div class="empty-state"><span class="empty-emoji">📋</span>해당하는 한마디가 없어.</div>';
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
              ${isMine(item) ? `<button class="edit-btn" data-edit-letter="${item.id}">${pixelEditSVG()}</button>` : ''}${canDelete(item.author) ? `<button class="del-btn" data-del-letter="${item.id}">✕</button>` : ''}
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
      items.push({ id: it.id, ts: it.createdAt, author: it.author, label:'일정', text: it.title, tab:'schedule', item: null });
    });
    wishes.forEach(it=>{
      items.push({ id: it.id, ts: it.createdAt || 0, author: it.author, label:'하고 싶은 것', text: it.title, tab:'wish', item: it });
    });
    dateLogs.forEach(it=>{
      if(!it.createdAt) return;
      items.push({ id: it.id, ts: it.createdAt, author: it.author, label:'함께한 날', text: it.title, tab:'datelog', item: it });
    });
    // 복작방은 홈 전용 카드(homeBoardFeedCard)에서 이미 따로 보여주고 있어서,
    // 여기(최근 활동)에 또 넣으면 같은 글이 홈에 두 번 나타나므로 제외함
    letters.forEach(it=>{
      const isLocked = !!(it.unlockAt && it.unlockAt > Date.now() && !isMine(it));
      items.push({
        id: it.id, ts: it.createdAt || 0, author: it.author, label:'편지',
        text: isLocked ? '🔒 아직 열리지 않은 편지야' : (it.title || it.body),
        tab:'letter', item: it, canReact: !isLocked
      });
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
        const participants = getDisplayParticipants(nextDate);
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

    renderTodayUsCard();

    const boardFeedCard = document.getElementById('homeBoardFeedCard');
    if(boardFeedCard){
      const recentBoards = boards.filter(item => item.postType !== 'dailyPhoto').sort((a,b)=> (b.createdAt||0) - (a.createdAt||0)).slice(0, 3);
      if(recentBoards.length === 0){
        boardFeedCard.innerHTML = `<div class="home-next-label">🗨️ 복작방</div><div class="home-next-sub">아직 남긴 한마디가 없어</div>`;
      } else {
        boardFeedCard.innerHTML = `
          <div class="home-next-label">🗨️ 복작방</div>
          ${recentBoards.map(it => {
            const likes = it.likes || [];
            const isLiked = identity && likes.includes(identity);
            const commentCount = totalCommentCount(it.comments);
            const snippet = boardPreviewText(it);
            return `<div class="home-board-feed-item" data-item-target="${it.id}">
              <span class="home-feed-author color-${colorKeyOf(it.author)}">${it.author||''}</span>
              <span class="home-feed-text">${escapeHTML((snippet||'').slice(0,30))}</span>
              <span class="home-board-feed-actions">
                <button class="like-btn ${isLiked?'liked':''}" data-like-col="board" data-like-id="${it.id}"><span class="heart-icon">${pixelHeartSVG(isLiked)}</span> ${likes.length>0?likes.length:''}</button>
                <button class="home-board-comment-btn" data-comment-target="${it.id}"><span class="chat-icon">${pixelChatSVG()}</span> ${commentCount>0?commentCount:''}</button>
              </span>
            </div>`;
          }).join('')}
        `;
        // 이름/본문 부분을 누르면 복작방 탭의 그 글로 이동
        boardFeedCard.querySelectorAll('.home-board-feed-item').forEach(el=>{
          el.addEventListener('click', (e)=>{
            if(e.target.closest('.like-btn') || e.target.closest('.home-board-comment-btn')) return;
            navigateToItem('board', el.dataset.itemTarget);
          });
        });
        // 댓글 아이콘을 누르면 그 글로 이동하면서 댓글창까지 바로 열어줌
        boardFeedCard.querySelectorAll('.home-board-comment-btn').forEach(btn=>{
          btn.addEventListener('click', (e)=>{
            e.stopPropagation();
            const id = btn.dataset.commentTarget;
            // 작성 중인 내용 때문에 이동이 취소됐다면 아무 상태도 바꾸지 않음
            const navigated = navigateToItem('board', id);
            if(!navigated) return;

            // 다시 렌더링돼도 게시물 본문과 댓글창이 계속 열려있도록 기록
            openPostDetails.add(id);
            openCommentSections.add(`board-${id}`);

            const card = document.querySelector(`#panel-board [data-item-id="${id}"]`);
            const detail = card ? card.querySelector('.post-detail') : null;
            if(detail) detail.classList.remove('hidden');

            const section = card ? card.querySelector('.comment-section') : null;
            if(section){
              section.classList.add('active');
              setTimeout(()=>{
                const input = document.getElementById(`c-input-board-${id}`);
                if(input) input.focus();
              }, 250);
            }
          });
        });
        // 좋아요 버튼은 main에 이미 등록된 전역 .like-btn 핸들러가 알아서 처리함
      }
    }

    const feedCard = document.getElementById('homeFeedCard');
    if(feedCard){
      const feed = buildActivityFeed();
      if(feed.length === 0){
        feedCard.innerHTML = `<div class="home-next-label">🕓 최근 활동</div><div class="home-next-sub">아직 활동이 없어</div>`;
      } else {
        const authorClass = a => `color-${colorKeyOf(a)}`;
        feedCard.innerHTML = `
          <div class="home-next-label">🕓 최근 활동</div>
          ${feed.map(f => {
            // 일정은 좋아요·댓글이 없는 항목이라 기존의 단순한 한 줄 표시 그대로 씀
            if(!f.item || f.canReact === false){
              return `<div class="home-feed-item" data-tab-target="${f.tab}" data-item-target="${f.id}">
                <span class="home-feed-author ${authorClass(f.author)}">${f.author||''}</span>
                <span class="home-feed-text">${f.label} · ${escapeHTML((f.text||'').slice(0,24))}</span>
                <span class="home-feed-time">${relativeTimeKR(f.ts)}</span>
              </div>`;
            }
            // 하고 싶은 것/함께한 날/편지는 탭을 이동하지 않고 홈에서 바로 좋아요·댓글 가능
            const col = TAB_TO_COL[f.tab];
            const likes = f.item.likes || [];
            const isLiked = identity && likes.includes(identity);
            const commentCount = totalCommentCount(f.item.comments);
            return `<div class="home-feed-item-rich" data-tab-target="${f.tab}" data-item-target="${f.id}">
              <div class="home-feed-rich-top">
                <span class="home-feed-author ${authorClass(f.author)}">${f.author||''}</span>
                <span class="home-feed-rich-label">${f.label}</span>
                <span class="home-feed-time">${relativeTimeKR(f.ts)}</span>
              </div>
              <div class="home-feed-rich-text">${escapeHTML((f.text||'').slice(0,30))}</div>
              <div class="home-feed-rich-actions">
                <button class="like-btn ${isLiked?'liked':''}" data-like-col="${col}" data-like-id="${f.id}">
                  <span class="heart-icon">${pixelHeartSVG(isLiked)}</span> ${likes.length>0?likes.length:''}
                </button>
                <button class="home-feed-comment-btn" data-comment-tab="${f.tab}" data-comment-target="${f.id}">
                  <span class="chat-icon">${pixelChatSVG()}</span> ${commentCount>0?commentCount:''}
                </button>
              </div>
            </div>`;
          }).join('')}
        `;
        // 좋아요/댓글 버튼이 아닌, 카드 나머지 부분을 누르면 해당 탭으로 이동
        feedCard.querySelectorAll('.home-feed-item, .home-feed-item-rich').forEach(el=>{
          el.addEventListener('click', (e)=>{
            if(e.target.closest('.like-btn') || e.target.closest('.home-feed-comment-btn')) return;
            navigateToItem(el.dataset.tabTarget, el.dataset.itemTarget);
          });
        });
        // 댓글 아이콘은 그 탭으로 이동하면서 댓글창까지 바로 열어줌 (복작방 홈 카드와 동일한 패턴)
        feedCard.querySelectorAll('.home-feed-comment-btn').forEach(btn=>{
          btn.addEventListener('click', (e)=>{
            e.stopPropagation();
            const tab = btn.dataset.commentTab;
            const id = btn.dataset.commentTarget;

            // 작성 중인 내용 때문에 이동이 취소됐다면 아무 상태도 바꾸지 않음
            const navigated = navigateToItem(tab, id);
            if(!navigated) return;

            const col = TAB_TO_COL[tab];
            if(!col) return;

            // 다시 렌더링돼도 게시물 본문과 댓글창이 계속 열려있도록 기록
            openPostDetails.add(id);
            openCommentSections.add(`${col}-${id}`);

            const card = document.querySelector(`#panel-${tab} [data-item-id="${id}"]`);
            const detail = card ? card.querySelector('.post-detail') : null;
            if(detail) detail.classList.remove('hidden');

            const section = card ? card.querySelector('.comment-section') : null;
            if(section){
              section.classList.add('active');
              // 댓글 버튼을 눌렀으니 입력창까지 바로 포커스
              setTimeout(()=>{
                const input = document.getElementById(`c-input-${col}-${id}`);
                if(input) input.focus();
              }, 250);
            }
          });
        });
        // 좋아요 버튼은 main에 이미 등록된 전역 .like-btn 핸들러가 알아서 처리함
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

  const STATUS_REACTION_OPTIONS = ['💜', 'ㅋㅋㅋ', '👀', '나도!'];
  function renderTodayUsCard(){
    const card = document.getElementById('todayUsCard');
    if(!card) return;
    const dateStr = localDateStr();
    card.innerHTML = `
      <div class="today-us-label">🌷 오늘의 우리</div>
      <div class="today-us-grid">
        ${ALL_NAMES.map(name => {
          const p = profiles[name];
          const colorKey = colorKeyOf(name);
          const emoji = (p && p.status && p.status.emoji) || '🙂';
          const text = (p && p.status && p.status.text) || '상태 없음';
          const memo = (p && p.status && p.status.memo) || '';
          const updatedAt = p && p.status && p.status.updatedAt;
          const timeAgo = updatedAt ? relativeTimeKR(updatedAt) : '';
          // 24시간 지난 상태는 문구·시간만 흐리게 (사진은 그대로 정상 표시)
          const isStale = !!(updatedAt && (Date.now() - updatedAt > 24*60*60*1000));
          const isMine = identity === name;
          const reactions = (p && p.status && p.status.reactions) || {};
          const reactionEntries = Object.entries(reactions).filter(([,e]) => e);
          const myReaction = identity && reactions[identity];

          const post = boards.find(b => b.postType === 'dailyPhoto' && b.author === name && b.date === dateStr);
          const photo = post ? getItemPhotos(post)[0] : null;

          return `<div class="today-us-cell color-${colorKey}">
            <div class="today-us-photo ${photo ? '' : 'today-us-photo-empty'}" ${photo ? `data-photo-post-id="${post.id}"` : ''}>
              ${photo ? `<img src="${photo}" loading="lazy">` : `<span class="today-us-photo-empty-text">사진 없음</span>`}
            </div>
            <div class="today-us-info">
              <div class="today-us-name">${name}</div>
              <div class="today-us-status ${isStale ? 'today-us-stale' : ''}">
                <span>${escapeHTML(emoji)}</span> <span class="today-us-status-text">${escapeHTML(text)}</span>
              </div>
              ${memo ? `<div class="today-us-memo ${isStale ? 'today-us-stale' : ''}">${escapeHTML(memo)}</div>` : ''}
              <div class="today-us-time ${isStale ? 'today-us-stale' : ''}">${timeAgo}</div>
              ${isMine ? `
                <div class="today-us-my-actions">
                  <button type="button" class="today-us-action-btn" data-status-edit="1">상태 바꾸기</button>
                  <button type="button" class="today-us-action-btn" data-photo-action-post-id="${post ? post.id : ''}">${photo ? '사진 교체' : '사진 올리기'}</button>
                </div>
              ` : `
                <div class="s-reaction-row">
                  ${STATUS_REACTION_OPTIONS.map(r => `<button type="button" class="s-reaction-btn ${myReaction===r ? 'active' : ''}" data-react-name="${name}" data-react-emoji="${r}">${r}</button>`).join('')}
                  <button type="button" class="s-reaction-more-btn" data-react-name="${name}" title="다른 이모지로 반응">${myReaction && !STATUS_REACTION_OPTIONS.includes(myReaction) ? escapeHTML(myReaction) : '＋'}</button>
                </div>
              `}
              ${reactionEntries.length > 0 ? `<div class="s-reaction-list">${reactionEntries.map(([n,e]) => `<span class="s-reaction-tag">${escapeHTML(String(e))} ${escapeHTML(n)}</span>`).join(' ')}</div>` : ''}
            </div>
          </div>`;
        }).join('')}
      </div>
    `;
    // 사진(있는 경우, 본인/타인 상관없이)을 누르면 복작방의 그 게시물로 이동
    card.querySelectorAll('[data-photo-post-id]').forEach(el=>{
      el.addEventListener('click', ()=> navigateToItem('board', el.dataset.photoPostId));
    });
    // 내 칸의 "상태 바꾸기"
    card.querySelectorAll('[data-status-edit]').forEach(el=>{
      el.addEventListener('click', openStatusModal);
    });
    // 내 칸의 "사진 올리기/교체"
    card.querySelectorAll('[data-photo-action-post-id]').forEach(btn=>{
      btn.addEventListener('click', (e)=>{
        e.stopPropagation();
        const postId = btn.dataset.photoActionPostId;
        const existingPost = postId ? boards.find(b => b.id === postId) : null;
        openDailyPhotoModal(existingPost || null);
      });
    });
    // 고정 4개 반응 버튼 - 누르면 바로 저장됨. 같은 걸 다시 누르면 취소, 다른 걸 누르면 교체
    card.querySelectorAll('.s-reaction-btn').forEach(btn=>{
      btn.addEventListener('click', (e)=>{
        e.stopPropagation();
        saveStatusReaction(btn.dataset.reactName, btn.dataset.reactEmoji, /*toggle=*/true);
      });
    });
    // + 버튼 - 4개 말고 다른 이모지를 직접 고르고 싶을 때만 모달 열기
    card.querySelectorAll('.s-reaction-more-btn').forEach(btn=>{
      btn.addEventListener('click', (e)=>{
        e.stopPropagation();
        openStatusReactionModal(btn.dataset.reactName);
      });
    });
  }
  // 상태에 반응 저장 (공용) - toggle=true면 같은 반응 다시 눌렀을 때 취소 처리
  function saveStatusReaction(targetName, emoji, toggle){
    if(!identity || targetName === identity) return;
    const current = (profiles[targetName] && profiles[targetName].status && profiles[targetName].status.reactions) || {};
    const isSame = current[identity] === emoji;
    const fieldPath = `status.reactions.${identity}`;
    const update = {};
    update[fieldPath] = (toggle && isSame) || !emoji ? firebase.firestore.FieldValue.delete() : emoji;
    db.collection('profiles').doc(targetName).update(update)
      .catch(err => {
        console.error('상태 반응 실패', err);
        alert('반응을 남기지 못했어. 잠시 후 다시 시도해줘.');
      });
  }
  // 고정 4개 말고 다른 이모지로 반응하고 싶을 때 - 기기의 이모지 키보드로 아무거나 직접 입력
  let reactionTargetName = null;
  function openStatusReactionModal(targetName){
    if(!identity || targetName === identity) return;
    reactionTargetName = targetName;
    const current = (profiles[targetName] && profiles[targetName].status && profiles[targetName].status.reactions) || {};
    document.getElementById('statusReactionInput').value = current[identity] || '';
    document.getElementById('statusReactionModal').classList.remove('hidden');
    document.getElementById('statusReactionInput').focus();
  }
  document.getElementById('statusReactionCancelBtn').addEventListener('click', ()=>{
    document.getElementById('statusReactionModal').classList.add('hidden');
  });
  document.getElementById('statusReactionSaveBtn').addEventListener('click', ()=>{
    if(!reactionTargetName) return;
    const emoji = document.getElementById('statusReactionInput').value.trim();
    saveStatusReaction(reactionTargetName, emoji, /*toggle=*/false);
    document.getElementById('statusReactionModal').classList.add('hidden');
  });
  let selectedStatusEmoji = '';
  let selectedStatusText = '';
  function openStatusModal(){
    const p = profiles[identity];
    selectedStatusEmoji = (p && p.status && p.status.emoji) || '';
    selectedStatusText = (p && p.status && p.status.text) || '';
    document.getElementById('statusMemoInput').value = (p && p.status && p.status.memo) || '';
    document.querySelectorAll('.status-quick-btn').forEach(btn=>{
      btn.classList.toggle('active', btn.dataset.text === selectedStatusText && btn.dataset.emoji === selectedStatusEmoji);
    });
    document.getElementById('statusModal').classList.remove('hidden');
  }
  document.querySelectorAll('.status-quick-btn').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      selectedStatusEmoji = btn.dataset.emoji;
      selectedStatusText = btn.dataset.text;
      document.querySelectorAll('.status-quick-btn').forEach(b=> b.classList.remove('active'));
      btn.classList.add('active');
    });
  });
  document.getElementById('statusCancelBtn').addEventListener('click', ()=>{
    document.getElementById('statusModal').classList.add('hidden');
  });
  document.getElementById('statusClearBtn').addEventListener('click', ()=>{
    document.getElementById('statusMemoInput').value = '';
    document.getElementById('statusMemoInput').focus();
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
    const memo = document.getElementById('statusMemoInput').value.trim();

    // 상태를 하나도 안 고르고 메모만 쓴 채로 저장하는 걸 막음
    if(!selectedStatusEmoji || !selectedStatusText){
      alert('오늘의 상태를 하나 골라줘.');
      return;
    }

    const current = (profiles[identity] && profiles[identity].status) || {};
    const unchanged = current.emoji === selectedStatusEmoji
      && current.text === selectedStatusText
      && (current.memo || '') === memo;
    if(unchanged){
      // 완전히 같은 내용이면 그냥 닫기만 함 - 안 그러면 updatedAt만 바뀌면서
      // 다들 "상태를 바꿨어" 알림을 또 받게 됨
      document.getElementById('statusModal').classList.add('hidden');
      return;
    }

    try{
      // dot notation으로 status의 emoji/text/memo/updatedAt만 콕 집어 갱신 -
      // 그래야 status.reactions(다른 사람들이 남긴 반응)가 안 지워짐... 단, 상태
      // 자체가 바뀌는 거라면 예전 반응은 새 상태에 안 어울리니 여기서 같이 초기화함
      await db.collection('profiles').doc(identity).update({
        colorKey: colorKeyOf(identity),
        'status.emoji': selectedStatusEmoji,
        'status.text': selectedStatusText,
        'status.memo': memo,
        'status.updatedAt': Date.now(),
        'status.reactions': {}
      });
      document.getElementById('statusModal').classList.add('hidden');
    }catch(e){
      console.error('상태 저장 실패', e);
      alert('상태를 저장하지 못했어. 잠시 후 다시 시도해줘.');
    }
  });

  function getCurrentActiveTab(){
    const activePanel = document.querySelector('.tab-panel.active');
    return activePanel ? activePanel.id.replace('panel-','') : null;
  }
  function hasUnsavedDraft(tabName){
    switch(tabName){
      case 'schedule': return document.getElementById('schedTitle').value.trim() !== '';
      case 'wish': return document.getElementById('wishTitle').value.trim() !== '' || document.getElementById('wishBody').value.trim() !== '';
      case 'datelog': return !!dateLogSourceSchedule || !!activeDateLogLockScheduleId
        || document.getElementById('dateLogTitle').value.trim() !== ''
        || document.getElementById('dateLogMemo').value.trim() !== ''
        || document.getElementById('dateLogLocation').value.trim() !== ''
        || pendingDateLogPhotos.length > 0
        || dateLogSelectedParticipants.length > 0;
      case 'letter': return document.getElementById('letterBody').value.trim() !== '';
      case 'board': return document.getElementById('boardBody').value.trim() !== '' || pendingBoardPhotos.length > 0;
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
  // "약속"(일정+하고 싶은 것), "추억"(함께한 날+편지) 묶음 - 탭 이름 자체는 그대로 두고
  // 하단 탭바 표시/강조만 그룹 단위로 처리함 (기존 navigateToItem, 알림, 검색 등은
  // 실제 탭 이름을 그대로 쓰므로 전혀 안 건드려도 됨)
  const TAB_GROUP = { schedule: 'promise', wish: 'promise', datelog: 'memories', letter: 'memories', dailyPhotoArchive: 'memories' };
  function activateTab(tabName){
    const panel = document.getElementById('panel-'+tabName);
    if(!panel) return false;
    const currentTab = getCurrentActiveTab();
    if(currentTab && currentTab !== tabName && hasUnsavedDraft(currentTab)){
      const proceed = confirm('작성 중인 내용이 있어.\n다른 탭으로 이동하면 지금 쓴 내용이 사라져.\n\n그래도 이동할까?');
      if(!proceed) return false;
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
      // 복작방 탭을 나가면, 아카이브에서 임시로 열어뒀던 과거 사진도 정리
      // (안 지우면 일반 목록 구독이 갱신될 때마다 계속 다시 끼워넣어져서 안 사라짐)
      if(currentTab === 'board' && typeof clearOpenedArchivePhoto === 'function'){
        clearOpenedArchivePhoto();
      }
      // 개별 조회해서 보호해두던 알림 대상도, 그 탭을 완전히 떠나면 더 이상 지킬 필요 없음
      // (중앙 정리 함수를 써야 실제 배열에서도 빠지고 개별 구독도 해제됨)
      if(openedNotificationTarget && openedNotificationTarget.tab === currentTab){
        clearOpenedNotificationTarget();
      }
      // 일정에 연결된 기록을 쓰다가 탭을 완전히 떠나면(취소/저장 없이), 작성 잠금도 해제
      if(currentTab === 'datelog' && activeDateLogLockScheduleId && typeof releaseDateLogDraftLock === 'function'){
        releaseDateLogDraftLock();
      }
    }
    document.querySelectorAll('.tab-panel').forEach(p=>p.classList.remove('active'));
    panel.classList.add('active');
    window.scrollTo(0, 0);
    // 하단 탭바: "약속"/"추억"처럼 여러 탭을 묶은 그룹 버튼은, 그 그룹에 속한 어떤
    // 탭이 활성화되어도 계속 눌린 상태로 보이게 함
    document.querySelectorAll('.tab-btn').forEach(b=>{
      const group = TAB_GROUP[tabName];
      b.classList.toggle('active', b.dataset.tab === tabName || (!!group && b.dataset.tabGroup === group));
    });
    // 패널 안쪽 상단의 서브탭(일정|하고 싶은 것, 함께한 날|편지)도 같이 갱신
    document.querySelectorAll('.sub-tab-btn').forEach(b=>{
      b.classList.toggle('active', b.dataset.tab === tabName);
    });
    // 오늘의 한 장 아카이브는 복작방의 최근 100개 제한과 무관하게 전체를 봐야 함.
    // 네 명만 쓰는 작은 앱이라, 매번 다시 조회하는 게 가장 단순하고 정확함
    // (한 번 열고 나서 새 사진/교체/삭제가 생겨도 다음 진입 때 바로 반영됨)
    if(tabName === 'dailyPhotoArchive'){
      loadDailyPhotoArchive();
    }
    if(typeof startCollectionWatcher === 'function') startCollectionWatcher(tabName === 'dailyPhotoArchive' ? 'board' : tabName);
    return true;
  }
  function activateTabFromHash(){
    const hash = window.location.hash.replace('#','');
    // 해시를 읽자마자 주소창에서 지움 - 안드로이드가 백그라운드에서 깨어나며
    // 조용히 새로고침하는 경우, 예전 해시가 그대로 남아있으면 그걸 다시 읽어서
    // "예전에 눌렀던 알림"을 계속 반복하는 문제가 있었음. 매번 지워두면 그럴 일이 없음.
    if(hash) history.replaceState(null, '', window.location.pathname + window.location.search);
    if(!hash) return;
    const [tab, itemId, commentTs, replyTs] = hash.split(':');
    if(!tab) return;
    if(itemId) navigateToItem(tab, itemId, commentTs, replyTs);
    else activateTab(tab);
  }
  document.querySelectorAll('.tab-btn').forEach(btn=>{
    btn.addEventListener('click', ()=> activateTab(btn.dataset.tab));
  });
  // 패널 안쪽 상단의 서브탭(일정|하고 싶은 것, 함께한 날|편지) 클릭 처리
  document.querySelectorAll('.sub-tab-btn').forEach(btn=>{
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
  async function postToActiveServiceWorker(message){
    if(!('serviceWorker' in navigator)) return false;
    try{
      // ready는 서비스워커가 아예 등록된 적 없는 사용자한텐 영원히 안 풀리는 약속이라
      // (알림을 한 번도 허용 안 한 사람 등), getRegistration()으로 먼저 확인하고
      // 그런 경우엔 조용히 포기함
      const registration = await navigator.serviceWorker.getRegistration();
      const worker = navigator.serviceWorker.controller || (registration && registration.active);
      if(!worker) return false;
      worker.postMessage(message);
      return true;
    }catch(e){
      return false;
    }
  }

  function clearPendingNavigateInServiceWorker(){
    postToActiveServiceWorker({ type: 'CLEAR_PENDING_NOTIF' });
    samsungPendingClearTimer = null;
  }

  function handleServiceWorkerNavigate(msg){
    if(!msg || msg.type !== 'navigate' || !msg.tab) return;

    // 로그인 확인이 아직 안 끝났다면 이동정보를 잃지 않고 보관.
    // 이 상태에서는 pending도 지우지 않음 (로그인 완료 후 다시 이 함수가 불려서 처리됨)
    if(!identity){
      deferredNavigateMessage = msg;
      return;
    }

    const pushKey = [
      msg.notifId || '', msg.tab || '', msg.itemId || '', msg.commentTs || '', msg.replyTs || ''
    ].join('|');
    const isDuplicateSamsungDelivery = IS_SAMSUNG_INTERNET && pushKey === lastHandledSamsungPushKey;

    // 삼성인터넷은 pending을 여러 차례(0.7/1.5/2.6초) 확인하므로,
    // 같은 알림을 같은 페이지에서 반복 이동시키지 않게 막음
    if(!isDuplicateSamsungDelivery){
      if(IS_SAMSUNG_INTERNET) lastHandledSamsungPushKey = pushKey;

      const navigated = msg.itemId ? navigateToItem(msg.tab, msg.itemId, msg.commentTs, msg.replyTs) : activateTab(msg.tab);
      // 잠금화면/알림창 알림을 눌러서 들어온 거면, 그 알림도 Firestore에서 읽음 처리함.
      // 단, 작성 중인 내용 때문에 이동 자체가 취소됐다면 읽음 처리도 하지 않음
      // (취소했는데 알림만 사라지면 헷갈리니까)
      if(msg.notifId && navigated) markNotifRead(msg.notifId);
    }

    if(IS_SAMSUNG_INTERNET){
      // 복귀 도중 삼성인터넷이 화면을 다시 복원하더라도, 뒤이은 재확인(1.5초/2.6초)이
      // 여전히 같은 정보를 찾아 다시 적용할 수 있도록 조금 더 오래 유지해뒀다가 지움.
      // 매번 타이머를 새로 시작해야 함 - 안 그러면 3.5초 이내에 알림 두 개가 연속으로
      // 오면, 첫 번째 타이머가 두 번째 알림의 pending까지 너무 일찍 지워버릴 수 있음
      if(samsungPendingClearTimer) clearTimeout(samsungPendingClearTimer);
      samsungPendingClearTimer = setTimeout(clearPendingNavigateInServiceWorker, 3500);
    } else {
      // 다른 브라우저는 기존처럼 즉시 정리
      // (안 지우면 나중에 전혀 상관없는 시점에 이 알림이 다시 튀어나올 수 있음)
      clearPendingNavigateInServiceWorker();
    }
  }

  if('serviceWorker' in navigator){
    navigator.serviceWorker.addEventListener('message', (event)=>{
      const msg = event.data;
      if(msg && msg.type === 'navigate'){
        handleServiceWorkerNavigate(msg);
        return;
      }
      if(msg && msg.type === 'SW_VERSION'){
        const tag = document.getElementById('appVersionTag');
        if(tag) tag.textContent = `v${APP_VERSION} · ${msg.version}`;
      }
    });
  }

  function updateIdentityChip(){
    document.getElementById('identityChip').textContent = identity ? `나는 ${identity}` : '나는 ...';
  }
  function clearTransientNavigationState(){
    if(samsungPendingClearTimer){
      clearTimeout(samsungPendingClearTimer);
      samsungPendingClearTimer = null;
    }
    resumeRetryTimers.forEach((timer)=> clearTimeout(timer));
    resumeRetryTimers = [];
    deferredNavigateMessage = null;
    lastHandledSamsungPushKey = '';
    clearScrollState();

    // 이전 계정의 포그라운드 알림 토스트도 완전히 정리 (드물지만, 토스트 떠있는 채로
    // 바로 로그아웃하고 다른 계정으로 빠르게 로그인하면 잠깐 다시 보일 수 있었음)
    if(pushToastTimer){
      clearTimeout(pushToastTimer);
      pushToastTimer = null;
    }
    pushToastTab = null;
    pushToastItemId = null;
    pushToastCommentTs = null;
    pushToastReplyTs = null;
    pushToastNotifId = null;
    const toast = document.getElementById('pushToast');
    if(toast){
      toast.classList.add('hidden');
      toast.classList.remove('centered');
    }

    // 서비스워커 IndexedDB에 남아 있는 이동정보도 정리
    postToActiveServiceWorker({ type: 'CLEAR_PENDING_NOTIF' });
  }

  async function logoutCurrentUser(){
    const oldIdentity = identity;
    const deviceId = getOrCreateDeviceId();
    try{
      // 로그아웃 전에 기존 계정의 이 기기 푸시 등록을 삭제 (다른 계정으로 다시 로그인해도
      // 예전 계정 알림이 이 기기로 계속 오는 것을 방지)
      if(oldIdentity){
        await db.collection('fcmTokens').doc(oldIdentity).collection('devices').doc(deviceId)
          .delete().catch((err)=>console.warn('기기 알림 등록 삭제 실패', err));
      }
    } finally {
      if(foregroundMessageUnsubscribe){
        foregroundMessageUnsubscribe();
        foregroundMessageUnsubscribe = null;
      }
      clearTransientNavigationState();
      stopAllWatchers();
      identity = null;
      updateIdentityChip();
      await firebase.auth().signOut();
    }
  }
  document.getElementById('identityChip').addEventListener('click', ()=>{
    document.getElementById('profileMenuTitle').textContent = identity ? `나는 ${identity}` : '나는 ...';
    document.getElementById('profileMenuModal').classList.remove('hidden');
  });
  document.getElementById('profileMenuCancelBtn').addEventListener('click', ()=>{
    document.getElementById('profileMenuModal').classList.add('hidden');
  });
  document.getElementById('profileMenuActivityBtn').addEventListener('click', ()=>{
    document.getElementById('profileMenuModal').classList.add('hidden');
    openMyActivityOverlay();
  });
  document.getElementById('profileMenuLogoutBtn').addEventListener('click', async ()=>{
    document.getElementById('profileMenuModal').classList.add('hidden');
    if(!confirm('로그아웃할까?')) return;
    await logoutCurrentUser();
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
  setupDraftAutosave('draft_schedule', ['schedTitle', 'schedMemo']);
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
    document.getElementById('schedLocation').value = item.location || '';
    pendingScheduleGeo = (typeof item.lat === 'number' && typeof item.lng === 'number') ? { lat: item.lat, lng: item.lng } : null;
    document.getElementById('schedLocationStatus').classList.add('hidden');
    setScheduleSourceWish(item.sourceWishId ? {
      id: item.sourceWishId,
      title: (wishes.find(w => w.id === item.sourceWishId) || {}).title || item.sourceWishTitle || '하고 싶은 일'
    } : null);
    setDatePlanToggle(!!item.isDate);
    if(item.endDate){
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
    document.getElementById('schedLocation').value='';
    document.getElementById('schedLocationResults').classList.add('hidden');
    document.getElementById('schedLocationResults').innerHTML = '';
    document.getElementById('schedLocationStatus').classList.add('hidden');
    pendingScheduleGeo = null;
    setScheduleSourceWish(null);
    setRangeToggleState('schedEndDateRow', 'schedRangeToggleBtn', false);
    setDatePlanToggle(false);
    document.getElementById('schedDate').value = localDateStr();
    document.getElementById('schedAddBtn').textContent = '추가하기';
    document.getElementById('schedCancelBtn').classList.add('hidden');
    clearDraftAutosave('draft_schedule');
  }
  document.getElementById('schedCancelBtn').addEventListener('click', resetScheduleForm);
  document.getElementById('schedLocation').addEventListener('input', ()=>{
    pendingScheduleGeo = null;
    document.getElementById('schedLocationStatus').classList.add('hidden');
  });
  document.getElementById('schedLocation').addEventListener('keydown', (e)=>{
    if(e.key === 'Enter'){
      e.preventDefault();
      e.target.blur();
      setTimeout(()=>{ document.activeElement && document.activeElement.blur(); }, 0);
      document.getElementById('schedLocationSearchBtn').click();
    }
  });
  document.getElementById('schedLocationSearchBtn').addEventListener('click', async ()=>{
    const query = document.getElementById('schedLocation').value.trim();
    if(!query) return;
    const resultsEl = document.getElementById('schedLocationResults');
    document.getElementById('schedLocationStatus').classList.add('hidden');
    resultsEl.classList.remove('hidden');
    resultsEl.innerHTML = '';
    showLoadingOverlay('장소 찾는 중이야...');
    let results;
    try{
      results = await searchLocations(query);
    } finally {
      hideLoadingOverlay();
    }
    if(results.length === 0){
      resultsEl.innerHTML = `
        <div class="location-result-item">검색 결과가 없어. 다른 이름으로 시도해봐.</div>
        <button type="button" class="location-cancel-btn" id="schedLocationCancelBtn">✕ 취소</button>
      `;
      document.getElementById('schedLocationCancelBtn').addEventListener('click', ()=>{
        resultsEl.classList.add('hidden');
        resultsEl.innerHTML = '';
        document.getElementById('schedLocation').value = '';
        pendingScheduleGeo = null;
        const statusEl = document.getElementById('schedLocationStatus');
        statusEl.classList.add('hidden');
        statusEl.textContent = '';
      });
      return;
    }
    resultsEl.innerHTML = results.map((r,i)=>`
      <div class="location-result-item" data-idx="${i}">
        <div class="location-result-name">${escapeHTML(r.name)}</div>
        <div class="location-result-addr">${escapeHTML(r.address || '')}</div>
      </div>
    `).join('') + `<button type="button" class="location-cancel-btn" id="schedLocationCancelBtn">✕ 취소</button>`;
    document.getElementById('schedLocationCancelBtn').addEventListener('click', ()=>{
      resultsEl.classList.add('hidden');
      resultsEl.innerHTML = '';
      document.getElementById('schedLocation').value = '';
      pendingScheduleGeo = null;
      const statusEl = document.getElementById('schedLocationStatus');
      statusEl.classList.add('hidden');
      statusEl.textContent = '';
    });
    resultsEl.querySelectorAll('.location-result-item[data-idx]').forEach(el=>{
      el.addEventListener('click', ()=>{
        const r = results[Number(el.dataset.idx)];
        pendingScheduleGeo = { lat: r.lat, lng: r.lng };
        document.getElementById('schedLocation').value = r.name;
        resultsEl.classList.add('hidden');
        resultsEl.innerHTML = '';
        const statusEl = document.getElementById('schedLocationStatus');
        statusEl.classList.remove('hidden');
        statusEl.textContent = `✅ 이 장소로 선택했어: ${r.name}`;
        statusEl.style.color = '#4A9B6E';
      });
    });
  });

  // ---- 위시 → 일정 연결 ----
  function setScheduleSourceWish(wish){
    scheduleSourceWish = wish ? { id: wish.id, title: wish.title || '하고 싶은 일' } : null;
    const row = document.getElementById('schedSourceWishRow');
    const title = document.getElementById('schedSourceWishTitle');
    row.classList.toggle('hidden', !scheduleSourceWish);
    title.textContent = scheduleSourceWish ? scheduleSourceWish.title : '';
  }
  document.getElementById('schedSourceWishClearBtn').addEventListener('click', ()=>{
    setScheduleSourceWish(null);
  });
  // 이 위시로 이미 만들어둔 일정이 있는지 확인 (로컬 우선, 없으면 서버에서 한 번 더)
  function findScheduleForWish(wishId){
    return schedule.filter(item => item.sourceWishId === wishId)
      .sort((a,b) => (b.createdAt||0) - (a.createdAt||0))[0] || null;
  }
  async function getScheduleForWish(wishId){
    const localItem = findScheduleForWish(wishId);
    if(localItem) return localItem;
    const snap = await db.collection('schedule').where('sourceWishId', '==', wishId).limit(1).get({ source: 'server' });
    if(snap.empty) return null;
    const doc = snap.docs[0];
    const item = { id: doc.id, ...doc.data() };
    if(!schedule.some(s => s.id === item.id)) schedule = [...schedule, item];
    return item;
  }
  async function startScheduleFromWish(wish){
    if(!wish) return;
    let linkedSchedule;
    try{
      linkedSchedule = await getScheduleForWish(wish.id);
    }catch(e){
      console.error('연결된 일정 확인 실패', e);
      alert('연결된 일정이 있는지 확인하지 못했어. 인터넷 연결을 확인하고 다시 눌러줘.');
      return;
    }
    if(linkedSchedule){
      if(isPast(linkedSchedule)) showPastSchedule = true;
      navigateToItem('schedule', linkedSchedule.id);
      return;
    }
    if(!activateTab('schedule')) return;
    resetScheduleForm();
    setScheduleSourceWish(wish);
    document.getElementById('schedTitle').value = wish.title || '';
    document.getElementById('schedMemo').value = wish.body || '';
    setDatePlanToggle(true); // 일반 일정이 아니라 데이트 일정으로 시작
    const form = document.getElementById('scheduleForm');
    if(form) form.scrollIntoView({behavior:'smooth', block:'start'});
  }
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
    const location = document.getElementById('schedLocation').value.trim();

    // 검색 결과를 직접 고르지 않았어도, 장소 이름만 써놨다면 저장 직전에 한 번 자동 검색
    let geo = pendingScheduleGeo;
    if(!geo && location){
      showLoadingOverlay('장소 확인 중이야...');
      try{
        const results = await searchLocations(location);
        geo = results[0] ? { lat: results[0].lat, lng: results[0].lng } : null;
      } finally {
        hideLoadingOverlay();
      }
    }

    try{
      if(editingScheduleId){
        await db.collection('schedule').doc(editingScheduleId).update({
          date, endDate, time, endTime, title, memo, isDate, location,
          lat: geo ? geo.lat : null, lng: geo ? geo.lng : null,
          sourceWishId: scheduleSourceWish ? scheduleSourceWish.id : null,
          sourceWishTitle: scheduleSourceWish ? scheduleSourceWish.title : null,
        });
        resetScheduleForm();
      } else {
        await db.collection('schedule').doc(genId()).set({
          date, endDate, time, endTime, title, memo, isDate, location,
          lat: geo ? geo.lat : null, lng: geo ? geo.lng : null,
          sourceWishId: scheduleSourceWish ? scheduleSourceWish.id : null,
          sourceWishTitle: scheduleSourceWish ? scheduleSourceWish.title : null,
          participants: [], author: identity, createdAt: Date.now()
        });
        resetScheduleForm();
      }
    }catch(e){ console.error('일정 저장 실패', e); alert('저장에 실패했어. 인터넷 연결을 확인해줘.'); }
  });
  function handleScheduleClick(e){
    const editBtn = e.target.closest('[data-edit-schedule]');
    const delBtn = e.target.closest('[data-del-schedule]');
    const editId = editBtn && editBtn.dataset.editSchedule;
    const delId = delBtn && delBtn.dataset.delSchedule;
    const joinBtn = e.target.closest('[data-join-schedule]');
    const memoryBtn = e.target.closest('[data-schedule-memory]');
    const sourceWishBtn = e.target.closest('[data-open-source-wish]');
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
    } else if(memoryBtn){
      const item = schedule.find(s=>s.id===memoryBtn.dataset.scheduleMemory);
      if(item) startDateLogFromSchedule(item);
    } else if(sourceWishBtn){
      navigateToItem('wish', sourceWishBtn.dataset.openSourceWish);
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
  setupDraftAutosave('draft_wish', ['wishTitle', 'wishBody', 'wishLink']);
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
    clearDraftAutosave('draft_wish');
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
    const planBtn = e.target.closest('[data-plan-or-view-wish]');
    const editId = editBtn && editBtn.dataset.editWish;
    const delId = delBtn && delBtn.dataset.delWish;
    const checkId = checkBtn && checkBtn.dataset.checkWish;
    const planWishId = planBtn && planBtn.dataset.planOrViewWish;

    if (editId) startEditWish(wishes.find(s => s.id === editId));
    else if (delId) deleteItem('wishlist', delId, wishes.find(s => s.id === delId));
    else if (checkId) {
      const wishItem = wishes.find(s => s.id === checkId);
      if(!wishItem) return;
      const willBeDone = !wishItem.done;
      if(willBeDone && !confirm('완료로 표시할까?')) return;
      db.collection('wishlist').doc(checkId).update({ done: willBeDone }).catch(err=>console.error(err));
    } else if (planWishId) {
      startScheduleFromWish(wishes.find(s => s.id === planWishId));
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
  setupDraftAutosave('draft_datelog', ['dateLogTitle', 'dateLogMemo']);

  // ---- 일정 → 기록 연결 (한 일정당 사람별로 기록 하나씩) ----
  const DATELOG_LOCK_DURATION_MS = 10 * 60 * 1000; // 10분 - 정상 작성 중에는 1분마다 갱신되어 계속 연장됨

  function canWriteDateLogForSchedule(item){
    if(!item || !item.isDate || !item.date || item.date > localDateStr()) return false;
    const participants = getDisplayParticipants(item);
    return participants.includes(identity);
  }
  // 이 일정에 연결된 모든 사람의 기록
  function findDateLogsForSchedule(scheduleId){
    return dateLogs.filter(item => item.sourceScheduleId === scheduleId);
  }
  // 이 일정에 내가 남긴 기록
  function findMyDateLogForSchedule(scheduleId){
    return dateLogs.find(item => item.sourceScheduleId === scheduleId && item.author === identity) || null;
  }
  function dateLogDocIdForSchedule(scheduleId, author){
    author = author || identity;
    return `schedule_${scheduleId}_${encodeURIComponent(author)}`;
  }
  // 최근 100개 목록에 없을 수도 있으니, 내 기록의 고정 문서 ID로 서버에서 직접 확인
  async function getMyDateLogForSchedule(scheduleId){
    const localItem = findMyDateLogForSchedule(scheduleId);
    if(localItem) return localItem;
    const docId = dateLogDocIdForSchedule(scheduleId, identity);
    const snap = await db.collection('datelog').doc(docId).get({ source: 'server' });
    if(!snap.exists) return null;
    const item = { id: snap.id, ...snap.data() };
    if(!dateLogs.some(log => log.id === item.id)) dateLogs = [item, ...dateLogs];
    return item;
  }

  // ---- 작성 중 잠금 (같은 사람이 여러 기기에서 동시에 쓰는 것만 방지 - 다른 사람끼리는 서로 독립적) ----
  let activeDateLogLockScheduleId = null;
  let activeDateLogLockToken = null;
  let dateLogLockHeartbeat = null;
  function dateLogLockId(scheduleId){
    return `${scheduleId}_${encodeURIComponent(identity)}`;
  }
  async function acquireDateLogDraftLock(scheduleId){
    const lockRef = db.collection('datelogDraftLocks').doc(dateLogLockId(scheduleId));
    const recordRef = db.collection('datelog').doc(dateLogDocIdForSchedule(scheduleId, identity));
    const deviceId = getOrCreateDeviceId();
    const lockToken = genId();
    const now = Date.now();
    return db.runTransaction(async t => {
      const recordSnap = await t.get(recordRef);
      if(recordSnap.exists) return { acquired: false, existingId: recordRef.id };
      const lockSnap = await t.get(lockRef);
      if(lockSnap.exists){
        const lock = lockSnap.data();
        const isExpired = !lock.expiresAt || lock.expiresAt <= now;
        const isMyLock = lock.owner === identity && lock.deviceId === deviceId;
        if(!isExpired && !isMyLock) return { acquired: false, owner: lock.owner };
      }
      t.set(lockRef, { owner: identity, deviceId, lockToken, acquiredAt: now, expiresAt: now + DATELOG_LOCK_DURATION_MS });
      return { acquired: true, owner: identity, lockToken };
    });
  }
  async function renewDateLogDraftLock(scheduleId){
    const lockRef = db.collection('datelogDraftLocks').doc(dateLogLockId(scheduleId));
    const deviceId = getOrCreateDeviceId();
    try{
      return await db.runTransaction(async t => {
        const snap = await t.get(lockRef);
        if(!snap.exists) return false;
        const lock = snap.data();
        const isMyLock = lock.owner === identity && lock.deviceId === deviceId && lock.lockToken === activeDateLogLockToken;
        if(!isMyLock) return false;
        t.update(lockRef, { expiresAt: Date.now() + DATELOG_LOCK_DURATION_MS });
        return true;
      });
    }catch(e){
      console.warn('잠금 갱신 실패', e);
      return true; // 일시적 네트워크 오류를 잠금 상실로 단정하지 않음
    }
  }
  function stopDateLogLockHeartbeat(){
    if(dateLogLockHeartbeat){ clearInterval(dateLogLockHeartbeat); dateLogLockHeartbeat = null; }
  }
  function startDateLogLockHeartbeat(scheduleId){
    stopDateLogLockHeartbeat();
    dateLogLockHeartbeat = setInterval(async ()=>{
      if(activeDateLogLockScheduleId !== scheduleId) return;
      const renewed = await renewDateLogDraftLock(scheduleId);
      if(!renewed && activeDateLogLockScheduleId === scheduleId){
        // 다른 기기가 잠금을 가져간 경우 - 조용히 정리(작성 중인 내용은 그대로 남겨둠, 저장 시 다시 확인함)
        activeDateLogLockScheduleId = null;
        activeDateLogLockToken = null;
        stopDateLogLockHeartbeat();
      }
    }, 60000);
  }
  async function releaseDateLogDraftLock(){
    const scheduleId = activeDateLogLockScheduleId;
    const lockToken = activeDateLogLockToken;
    activeDateLogLockScheduleId = null;
    activeDateLogLockToken = null;
    stopDateLogLockHeartbeat();
    if(!scheduleId || !lockToken) return;
    try{
      const lockRef = db.collection('datelogDraftLocks').doc(dateLogLockId(scheduleId));
      const deviceId = getOrCreateDeviceId();
      await db.runTransaction(async t => {
        const snap = await t.get(lockRef);
        if(!snap.exists) return;
        const lock = snap.data();
        const isExactLock = lock.owner === identity && lock.deviceId === deviceId && lock.lockToken === lockToken;
        if(isExactLock) t.delete(lockRef);
      });
    }catch(e){ console.warn('잠금 해제 실패', e); }
  }
  // 화면을 껐다 켜거나 사진 촬영 후 복귀하면 하트비트 타이머가 멈춰 있었을 수 있으므로 즉시 재확인
  document.addEventListener('visibilitychange', ()=>{
    if(document.visibilityState === 'visible' && activeDateLogLockScheduleId) renewDateLogDraftLock(activeDateLogLockScheduleId);
  });
  window.addEventListener('focus', ()=>{
    if(activeDateLogLockScheduleId) renewDateLogDraftLock(activeDateLogLockScheduleId);
  });
  window.addEventListener('pageshow', ()=>{
    if(activeDateLogLockScheduleId) renewDateLogDraftLock(activeDateLogLockScheduleId);
  });

  function setDateLogSourceSchedule(item){
    dateLogSourceSchedule = item ? {
      id: item.id, title: item.title || '데이트 일정', sourceWishId: item.sourceWishId || null,
      date: item.date || '', time: item.time || '', endDate: item.endDate || '', endTime: item.endTime || '',
      location: item.location || '',
      lat: typeof item.lat === 'number' ? item.lat : null,
      lng: typeof item.lng === 'number' ? item.lng : null,
    } : null;
    const row = document.getElementById('dateLogSourceScheduleRow');
    const title = document.getElementById('dateLogSourceScheduleTitle');
    row.classList.toggle('hidden', !dateLogSourceSchedule);
    title.textContent = dateLogSourceSchedule ? dateLogSourceSchedule.title : '';
  }

  async function startDateLogFromSchedule(item){
    if(!item) return;
    let myLog;
    try{
      myLog = await getMyDateLogForSchedule(item.id);
    }catch(e){
      console.error('내 연결 기록 확인 실패', e);
      alert('내가 남긴 기록이 있는지 확인하지 못했어.\n인터넷 연결을 확인하고 다시 눌러줘.');
      return;
    }
    // 나는 이미 작성했으므로 내 기록으로 이동
    if(myLog){
      navigateToItem('datelog', myLog.id);
      return;
    }

    showLoadingOverlay('확인 중이야...');
    let lockResult;
    try{
      lockResult = await acquireDateLogDraftLock(item.id);
    }catch(e){
      hideLoadingOverlay();
      console.error('잠금 확보 실패', e);
      alert('작성을 시작하지 못했어. 인터넷 연결을 확인하고 다시 눌러줘.');
      return;
    }
    hideLoadingOverlay();

    if(!lockResult.acquired){
      if(lockResult.existingId){
        // 그 사이 내 기록이 이미 만들어졌음 (다른 기기 등) - 그리로 이동
        navigateToItem('datelog', dateLogDocIdForSchedule(item.id, identity));
        return;
      }
      alert('다른 기기에서 이미 이 기록을 작성 중이야.\n잠시 후 다시 시도해줘.');
      return;
    }

    if(!activateTab('datelog')){
      // 방금 확보한 잠금 정보를 넣어야 releaseDateLogDraftLock()이 정확히 해제할 수 있음
      activeDateLogLockScheduleId = item.id;
      activeDateLogLockToken = lockResult.lockToken;
      await releaseDateLogDraftLock();
      return;
    }

    resetDatelogForm();
    setDateLogSourceSchedule(item);
    activeDateLogLockScheduleId = item.id;
    activeDateLogLockToken = lockResult.lockToken;
    startDateLogLockHeartbeat(item.id);

    document.getElementById('dateLogDate').value = item.date || localDateStr();
    document.getElementById('dateLogLocation').value = item.location || '';
    pendingDateLogGeo = (typeof item.lat === 'number' && typeof item.lng === 'number') ? { lat: item.lat, lng: item.lng } : null;

    // 제목은 자동으로 채우되, 각자 자유롭게 고쳐 쓸 수 있음
    document.getElementById('dateLogTitle').value = item.title || '';
    document.getElementById('dateLogTime').value = item.time || '';
    if(item.endDate){
      document.getElementById('dateLogEndDate').value = item.endDate;
      document.getElementById('dateLogEndTime').value = item.endTime || '';
      setRangeToggleState('dateLogEndDateRow', 'dateLogRangeToggleBtn', true);
    } else {
      document.getElementById('dateLogEndDate').value = '';
      document.getElementById('dateLogEndTime').value = '';
      setRangeToggleState('dateLogEndDateRow', 'dateLogRangeToggleBtn', false);
    }
    dateLogSelectedParticipants = getDisplayParticipants(item).slice();
    renderParticipantChips('dateLogParticipantRow', dateLogSelectedParticipants);
  }

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
    // 연결된 일정이 있으면 표시만 복원 (이미 만들어진 기록을 고치는 거라 잠금은 새로 걸지 않음)
    setDateLogSourceSchedule(item.sourceScheduleId ? {
      id: item.sourceScheduleId,
      title: item.sourceScheduleTitle || '데이트 일정',
      sourceWishId: item.sourceWishId || null
    } : null);
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
    if(item.endDate){
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
  function resetDatelogForm(skipLockRelease){
    editingDatelogId = null;
    document.getElementById('dateLogTitle').value='';
    document.getElementById('dateLogLocation').value='';
    document.getElementById('dateLogLocationStatus').classList.add('hidden');
    document.getElementById('dateLogLocationResults').classList.add('hidden');
    pendingDateLogGeo = null;
    setDateLogSourceSchedule(null);
    if(!skipLockRelease) releaseDateLogDraftLock();
    else { activeDateLogLockScheduleId = null; activeDateLogLockToken = null; stopDateLogLockHeartbeat(); }
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
    clearDraftAutosave('draft_datelog');
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
        pendingDateLogGeo = null;
        const statusEl = document.getElementById('dateLogLocationStatus');
        statusEl.classList.add('hidden');
        statusEl.textContent = '';
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
      pendingDateLogGeo = null;
      const statusEl = document.getElementById('dateLogLocationStatus');
      statusEl.classList.add('hidden');
      statusEl.textContent = '';
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
  document.getElementById('dateLogCancelBtn').addEventListener('click', ()=> resetDatelogForm());
// 1. 기록하기 / 수정 완료 버튼
  async function saveNewDateLogForSchedule(scheduleId, data, pendingPhotos){
    showLoadingOverlay('저장 중이야...');
    let uploadedPhotos = [];
    try{
      uploadedPhotos = await uploadPhotos(pendingPhotos, (pct) => showLoadingOverlay(`저장 중이야... ${pct}%<br>사진 업로드 중이야`));
      const docId = dateLogDocIdForSchedule(scheduleId, identity);
      const recordRef = db.collection('datelog').doc(docId);
      const lockRef = db.collection('datelogDraftLocks').doc(dateLogLockId(scheduleId));
      const deviceId = getOrCreateDeviceId();
      const myToken = activeDateLogLockToken;

      const result = await db.runTransaction(async t => {
        const recordSnap = await t.get(recordRef);
        const lockSnap = await t.get(lockRef);
        const lock = lockSnap.exists ? lockSnap.data() : null;
        const ownsLock = lock && lock.owner === identity && lock.deviceId === deviceId && lock.lockToken === myToken;

        if(recordSnap.exists){
          // 이미 기록이 있어도, 그게 내 잠금이라면 남겨두지 않고 같이 정리함
          if(ownsLock) t.delete(lockRef);
          return 'exists';
        }
        if(!ownsLock) return 'lost';
        t.set(recordRef, { ...data, photos: uploadedPhotos, author: identity, createdAt: Date.now() });
        t.delete(lockRef);
        return 'created';
      });

      if(result === 'exists'){
        await deletePhotosFromStorage(uploadedPhotos);
        alert('내 기록이 이미 저장되어 있어!\n기존 기록으로 이동할게.');
        activeDateLogLockScheduleId = null; activeDateLogLockToken = null; stopDateLogLockHeartbeat();
        resetDatelogForm(/*skipLockRelease=*/true);
        navigateToItem('datelog', docId);
        return false;
      }
      if(result === 'lost'){
        await deletePhotosFromStorage(uploadedPhotos);
        activeDateLogLockScheduleId = null; activeDateLogLockToken = null; stopDateLogLockHeartbeat();

        let retryLock = null;
        try{
          retryLock = await acquireDateLogDraftLock(scheduleId);
        }catch(e){
          console.warn('작성 잠금 재확보 실패', e);
        }

        if(retryLock && retryLock.acquired){
          activeDateLogLockScheduleId = scheduleId;
          activeDateLogLockToken = retryLock.lockToken;
          startDateLogLockHeartbeat(scheduleId);
          alert('작성 잠금이 만료되어 새로 확보했어.\n작성 내용은 그대로야. 저장 버튼을 한 번 더 눌러줘.');
          return false;
        }
        if(retryLock && retryLock.existingId){
          alert('내 기록이 이미 저장되어 있어!\n기존 기록으로 이동할게.');
          resetDatelogForm(/*skipLockRelease=*/true);
          navigateToItem('datelog', retryLock.existingId);
          return false;
        }
        alert('다른 기기에서 이 기록을 작성 중이야.\n작성 내용은 화면에 남겨뒀어. 다른 기기의 작업이 끝난 뒤 다시 시도해줘.');
        return false;
      }
      // 저장 트랜잭션에서 이미 잠금 문서를 지웠으니, 여기서는 전역 상태와 하트비트만 정리(중복 삭제 시도 방지)
      resetDatelogForm(/*skipLockRelease=*/true);
      return true;
    }catch(e){
      console.error('일정 연결 기록 저장 실패', e);
      if(uploadedPhotos.length > 0) await deletePhotosFromStorage(uploadedPhotos);
      alert('기록을 저장하지 못했어.\n작성한 내용은 그대로 남겨뒀어.');
      return false;
    }finally{
      hideLoadingOverlay();
    }
  }
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

    const data = {
      title,
      date,
      memo: document.getElementById('dateLogMemo').value.trim(),
      location: location,
      time: document.getElementById('dateLogTime').value || null,
      endDate: document.getElementById('dateLogEndDate').value || null,
      endTime: document.getElementById('dateLogEndTime').value || null,
      lat: geo ? geo.lat : null,
      lng: geo ? geo.lng : null,
      participants: dateLogSelectedParticipants.slice(),
      sourceScheduleId: dateLogSourceSchedule ? dateLogSourceSchedule.id : null,
      sourceScheduleTitle: dateLogSourceSchedule ? dateLogSourceSchedule.title : null,
      sourceWishId: dateLogSourceSchedule ? dateLogSourceSchedule.sourceWishId : null,
    };

    // 일정에 연결된 "새" 기록이면, 사람별 고정 문서 ID + 트랜잭션으로 중복을 막는
    // 전용 저장 경로를 씀. 수정이거나 일정과 무관한 기록이면 기존 saveItem 그대로 사용
    if(!editingDatelogId && dateLogSourceSchedule){
      await saveNewDateLogForSchedule(dateLogSourceSchedule.id, data, pendingDateLogPhotos);
      return;
    }

    await saveItem(
      'datelog',
      !!editingDatelogId,
      editingDatelogId,
      data,
      pendingDateLogPhotos,
      resetDatelogForm
    );
  });
  
// 2. 클릭 이벤트 (수정/삭제)
  document.getElementById('dateLogList').addEventListener('click', (e) => {
    const editBtn = e.target.closest('[data-edit-datelog]');
    const delBtn = e.target.closest('[data-del-datelog]');
    const sourceScheduleBtn = e.target.closest('[data-open-source-schedule]');
    const sourceWishBtn = e.target.closest('[data-open-source-wish]');
    const editId = editBtn && editBtn.dataset.editDatelog;
    const delId = delBtn && delBtn.dataset.delDatelog;

    if (editId) startEditDatelog(dateLogs.find(s => s.id === editId));
    else if (delId) deleteItem('datelog', delId, dateLogs.find(s => s.id === delId));
    else if (sourceScheduleBtn) navigateToItem('schedule', sourceScheduleBtn.dataset.openSourceSchedule);
    else if (sourceWishBtn) navigateToItem('wish', sourceWishBtn.dataset.openSourceWish);
  });

  // ---- 자유게시판 ----
  let editingBoardId = null;
  let boardPinEnabled = false;
  setupPhotoPicker('boardPhotoInput','boardPhotoBtn','boardPhotoPreviewWrap', ()=>pendingBoardPhotos, (v)=>{ pendingBoardPhotos = v; });
  setupAuthorFilterRow('boardFilterRow', ()=>boardAuthorFilter, (v)=>{ boardAuthorFilter = v; }, renderBoard);
  setupDraftAutosave('draft_board', ['boardBody']);
  document.getElementById('boardPinToggle').addEventListener('click', ()=>{
    boardPinEnabled = !boardPinEnabled;
    document.getElementById('boardPinToggle').classList.toggle('active', boardPinEnabled);
  });

  function startEditBoard(item){
    editingBoardId = item.id;
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
    document.getElementById('boardBody').value = '';
    if(document.getElementById('boardBody')._autoGrowResize) document.getElementById('boardBody')._autoGrowResize();
    revokePendingPhotoUrls(pendingBoardPhotos);
    pendingBoardPhotos = [];
    renderPhotoPreviewGrid('boardPhotoPreviewWrap', ()=>pendingBoardPhotos, (v)=>{ pendingBoardPhotos = v; });
    boardPinEnabled = false;
    document.getElementById('boardPinToggle').classList.remove('active');
    document.getElementById('boardAddBtn').textContent = '남기기';
    document.getElementById('boardCancelBtn').classList.add('hidden');
    clearDraftAutosave('draft_board');
  }
  document.getElementById('boardCancelBtn').addEventListener('click', resetBoardForm);

  document.getElementById('boardAddBtn').addEventListener('click', async () => {
    const body = document.getElementById('boardBody').value.trim();
    // 제목 없이 한마디만 남기는 구조라, 본문 텍스트나 사진 중 하나라도 있어야 등록 가능
    if (!body && pendingBoardPhotos.length === 0) return;
    const data = { body, pinned: boardPinEnabled };
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
  setupDraftAutosave('draft_letter', ['letterTitle', 'letterBody']);

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
    clearDraftAutosave('draft_letter');
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
    const unsubscribe = query.onSnapshot(snap=>{
      const items = [];
      snap.forEach(doc=> items.push({ id: doc.id, ...doc.data() }));
      onData(items);
    }, err=>{ console.error(collectionName+' 구독 오류', err); });
    return rememberUnsubscribe(unsubscribe);
  }

  let unsubscribeFns = [];
  function rememberUnsubscribe(unsubscribe){
    if(typeof unsubscribe === 'function') unsubscribeFns.push(unsubscribe);
    return unsubscribe;
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
  let pushToastNotifId = null;
  function showPushToast(title, tab, itemId, commentTs, replyTs, centered, notifId){
    pushToastTab = tab || null;
    pushToastItemId = itemId || null;
    pushToastCommentTs = commentTs || null;
    pushToastReplyTs = replyTs || null;
    pushToastNotifId = notifId || null;
    document.getElementById('pushToastTitle').textContent = title || '';
    document.getElementById('pushToastBody').textContent = '';
    const toast = document.getElementById('pushToast');
    toast.classList.toggle('centered', !!centered);
    toast.classList.remove('hidden');
    clearTimeout(pushToastTimer);
    pushToastTimer = setTimeout(()=>{ toast.classList.add('hidden'); pushToastNotifId = null; }, 5000);
  }
  document.getElementById('pushToast').addEventListener('click', ()=>{
    document.getElementById('pushToast').classList.add('hidden');
    clearTimeout(pushToastTimer);
    const notifId = pushToastNotifId;
    pushToastNotifId = null;
    const navigated = (pushToastItemId && pushToastTab)
      ? navigateToItem(pushToastTab, pushToastItemId, pushToastCommentTs, pushToastReplyTs)
      : (pushToastTab ? activateTab(pushToastTab) : false);
    // 작성 중인 내용 때문에 이동이 취소됐다면 읽음 처리도 하지 않음
    if(notifId && navigated) markNotifRead(notifId);
  });

  async function setupPushNotifications(){
    try{
      // 로그인 사용자가 확정되기 전에는 토큰을 저장하지 않음
      if(!identity) return;
      if(!('serviceWorker' in navigator) || !('Notification' in window)) return;

      await navigator.serviceWorker.register('firebase-messaging-sw.js');
      // 방금 처음 등록된 서비스워커는 install/activate가 아직 안 끝나서
      // register()가 돌려주는 registration의 active가 이 시점엔 null일 수 있음
      // (특히 이 기기에서 처음 쓰는 경우). navigator.serviceWorker.ready는
      // "활성화까지 확실히 끝난" 워커를 기다려주므로, 이걸 getToken()에도 그대로 씀.
      const registration = await navigator.serviceWorker.ready;
      if(registration.active) registration.active.postMessage({ type: 'GET_SW_VERSION' });

      const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
      if(permission !== 'granted') return;
      const messaging = firebase.messaging();
      const token = await messaging.getToken({ vapidKey: VAPID_KEY, serviceWorkerRegistration: registration });
      if(token){
        const deviceId = getOrCreateDeviceId();
        const devicesRef = db.collection('fcmTokens').doc(identity).collection('devices');
        // 예전 버전에서 다른 deviceId로 같은 토큰이 저장돼있을 수 있어서(예: 저장 키
        // 마이그레이션 과정 등), 같은 사용자 안에서 같은 토큰의 중복 문서를 정리함
        // (안 지우면 같은 알림이 그 기기로 두 번 갈 수 있음)
        const sameTokenSnap = await devicesRef.where('token', '==', token).get();
        const batch = db.batch();
        sameTokenSnap.forEach((doc) => { if(doc.id !== deviceId) batch.delete(doc.ref); });
        batch.set(devicesRef.doc(deviceId), { token, updatedAt: Date.now(), userAgent: navigator.userAgent || '' }, { merge: true });
        await batch.commit();
      }
      if(foregroundMessageUnsubscribe){
        foregroundMessageUnsubscribe();
        foregroundMessageUnsubscribe = null;
      }
      foregroundMessageUnsubscribe = messaging.onMessage((payload)=>{
        const data = payload.data || {};
        showPushToast(data.title, data.tab, data.itemId, data.commentTs, data.replyTs, false, data.notifId);
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
    watchNotifications();
    watchDailyQuestion();

    // [나머지 3개] 앱을 처음 켤 때 다 같이 무겁게 불러오지 않고,
    // 그 탭을 처음 열 때 그때 불러오도록 지연시킴 (아래 startCollectionWatcher 참고).
    // 다만 홈 화면의 "최근 활동/1년 전 오늘" 기능을 위해, 잠깐 쉬는 시간(유휴시간)에
    // 백그라운드로 조용히 불러와 두기는 함 (탭을 누르면 그 즉시 당겨서 불러옴).
    const lazyCollections = ['wish', 'datelog', 'letter', 'board'];
    const loadRestInBackground = () => { if(identity) lazyCollections.forEach(startCollectionWatcher); };
    if('requestIdleCallback' in window){
      requestIdleCallback(loadRestInBackground, {timeout: 2000});
    } else {
      setTimeout(loadRestInBackground, 1200);
    }
  }

  function watchAnniversaries(){
    rememberUnsubscribe(
      db.collection('anniversaries').onSnapshot(snap=>{
        anniversaries = [];
        snap.forEach(doc=> anniversaries.push({ id: doc.id, ...doc.data() }));
        renderHome();
        renderAnnivExistingList();
      }, err=>console.error('기념일 구독 실패', err))
    );
  }

  // ---- 오늘의 질문 ----
  let todayQuestionData = null;
  let dailyQuestionEditMode = false; // "수정" 버튼을 눌러서 입력창이 열려있는 상태인지
  let dailyQuestionUnsubscribe = null;
  let dailyQuestionWatchedDate = null;
  let dailyQuestionRolloverTimer = null;
  // 오늘 날짜 문서가 아직 없으면 만듦 - 트랜잭션으로 처리해서, 가족 여러 명이 거의 동시에
  // 앱을 처음 열어도 서로 덮어쓰지 않고 안전하게 딱 하나만 만들어짐
  async function ensureTodayQuestion(dateStr){
    dateStr = dateStr || localDateStr();
    const ref = db.collection('dailyQuestions').doc(dateStr);
    try{
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if(snap.exists) return;
        const idx = dailyQuestionIndexFor(dateStr);
        const bankEntry = DAILY_QUESTION_BANK[idx];
        // 뱅크 항목이 문자열이면 한 줄 답변형, poll()로 만든 객체면 투표형
        const docData = (bankEntry && typeof bankEntry === 'object' && bankEntry.type === 'poll')
          ? { questionId: idx, question: bankEntry.question, type: 'poll', options: bankEntry.options, answers: {} }
          : { questionId: idx, question: bankEntry, answers: {} };
        tx.set(ref, docData);
      });
    }catch(e){ console.error('오늘의 질문 준비 실패', e); }
  }
  function watchDailyQuestion(){
    const dateStr = localDateStr();
    if(dailyQuestionWatchedDate === dateStr) return; // 이미 오늘 날짜를 구독 중이면 그대로 둠
    if(dailyQuestionUnsubscribe){ dailyQuestionUnsubscribe(); dailyQuestionUnsubscribe = null; }
    dailyQuestionWatchedDate = dateStr;
    dailyQuestionEditMode = false;

    // 날짜가 바뀌었을 때 기존 입력칸을 먼저 제거함 - 안 그러면 어제 답변이나
    // 입력하던 값이 오늘 질문 자리에 잠깐이라도 그대로 보일 수 있음
    todayQuestionData = null;
    renderDailyQuestionCard();

    ensureTodayQuestion(dateStr);
    dailyQuestionUnsubscribe = db.collection('dailyQuestions').doc(dateStr).onSnapshot(snap=>{
      todayQuestionData = snap.exists ? snap.data() : null;
      renderDailyQuestionCard();
    }, err=>console.error('오늘의 질문 구독 실패', err));

    // 앱을 안 끄고 자정을 넘기면 계속 어제 질문을 구독하고 있게 되므로,
    // 1분마다 날짜가 바뀌었는지 확인해서 바뀌었으면 자동으로 오늘 질문으로 갈아탐
    if(!dailyQuestionRolloverTimer){
      dailyQuestionRolloverTimer = setInterval(()=>{
        if(identity){
          watchDailyQuestion();
          renderTodayUsCard();
        }
      }, 60 * 1000);
    }
  }
  function stopDailyQuestionWatch(){
    if(dailyQuestionUnsubscribe){ dailyQuestionUnsubscribe(); dailyQuestionUnsubscribe = null; }
    dailyQuestionWatchedDate = null;
    if(dailyQuestionRolloverTimer){ clearInterval(dailyQuestionRolloverTimer); dailyQuestionRolloverTimer = null; }
  }
  // 지난 질문은 실시간으로 계속 볼 필요가 없어서, 열 때 한 번만 조회함(지속 구독 안 함)
  let dailyQuestionArchiveExpanded = new Set();
  async function openDailyQuestionArchive(targetDate){
    const overlay = document.getElementById('dailyQuestionArchiveOverlay');
    const results = document.getElementById('dailyQuestionArchiveResults');
    overlay.classList.remove('hidden');
    results.innerHTML = '<div class="empty-state">불러오는 중이야...</div>';
    try{
      // 가족 4명용 소규모 앱이라 전체 기간을 그냥 다 불러옴 (개수 제한 없음).
      // 문서 ID 기준 정렬 쿼리는 빼고 단순 조회 후 앱에서 정렬 - 혹시 모를 쿼리
      // 관련 문제(색인 등)를 피하기 위함
      const snap = await db.collection('dailyQuestions').get();
      const items = [];
      snap.forEach(doc => {
        // 오늘 날짜는 홈 카드에서 이미 보고 있으니 아카이브에서는 그 전날들만 보여줌
        if(doc.id === localDateStr()) return;
        const data = doc.data() || {};

        // 예전 버전에서 질문이 객체 형태로 저장됐을 수도 있어 안전하게 처리
        const rawQuestion = data.question;
        const question = typeof rawQuestion === 'string'
          ? rawQuestion
          : (rawQuestion && typeof rawQuestion.question === 'string' ? rawQuestion.question : '');

        const answers = (data.answers && typeof data.answers === 'object' && !Array.isArray(data.answers))
          ? data.answers : {};

        items.push({ date: String(doc.id), question, answers });
      });
      if(items.length === 0){
        results.innerHTML = '<div class="empty-state"><span class="empty-emoji">💭</span>아직 쌓인 지난 질문이 없어.</div>';
        return;
      }
      // 특정 날짜(예: 지난 질문 알림을 눌러서 들어온 경우)로 바로 온 거라면 미리 펼쳐둠
      if(targetDate) dailyQuestionArchiveExpanded.add(targetDate);
      // Firestore 쿼리에서 정렬하지 않고 앱에서 날짜 역순으로 정렬
      items.sort((a,b) => b.date.localeCompare(a.date));
      // 월별로 묶어서 표시 (YYYY-MM 기준)
      const groups = {};
      items.forEach(it => {
        const monthKey = it.date.slice(0, 7); // "2026-07"
        (groups[monthKey] = groups[monthKey] || []).push(it);
      });
      const monthKeys = Object.keys(groups).sort((a,b)=> b.localeCompare(a));
      results.innerHTML = monthKeys.map(monthKey => {
        const [y, m] = monthKey.split('-');
        const rows = groups[monthKey].map(it => {
          const day = Number(it.date.slice(8, 10));
          const isOpen = dailyQuestionArchiveExpanded.has(it.date);
          const answersHTML = ALL_NAMES.map(name => {
            const rawAnswer = it.answers[name];
            // 현재 형식은 {text, updatedAt}이지만, 예전 문서에 문자열만 들어있어도 표시되게 함
            const answerText = typeof rawAnswer === 'string'
              ? rawAnswer
              : (rawAnswer && typeof rawAnswer.text === 'string' ? rawAnswer.text : '');
            return `<div class="daily-q-archive-answer-row">
              <span class="daily-q-archive-answer-name color-${colorKeyOf(name)}">${escapeHTML(name)}</span>
              <span class="daily-q-archive-answer-text ${answerText ? '' : 'daily-q-answer-empty'}">${answerText ? escapeHTML(answerText) : '답하지 않았어'}</span>
            </div>`;
          }).join('');
          return `<div class="daily-q-archive-row" data-archive-date="${it.date}">
            <span class="daily-q-archive-day">${day}일</span>
            <span class="daily-q-archive-question">${escapeHTML(it.question)}</span>
          </div>
          <div class="daily-q-archive-answers ${isOpen ? '' : 'hidden'}" data-archive-answers="${it.date}">${answersHTML}</div>`;
        }).join('');
        return `<div class="daily-q-archive-month-label">${y}년 ${Number(m)}월</div>${rows}`;
      }).join('');
      // 질문 행을 누르면 그날 네 명의 답변이 펼쳐짐 (다시 누르면 접힘)
      results.querySelectorAll('[data-archive-date]').forEach(row=>{
        row.addEventListener('click', ()=>{
          const date = row.dataset.archiveDate;
          const answersEl = results.querySelector(`[data-archive-answers="${date}"]`);
          if(!answersEl) return;
          const isOpen = dailyQuestionArchiveExpanded.has(date);
          if(isOpen){ dailyQuestionArchiveExpanded.delete(date); answersEl.classList.add('hidden'); }
          else { dailyQuestionArchiveExpanded.add(date); answersEl.classList.remove('hidden'); }
        });
      });
      // 특정 날짜로 찾아온 거라면, 그 행까지 스크롤하고 잠깐 강조
      if(targetDate){
        const targetRow = results.querySelector(`[data-archive-date="${targetDate}"]`);
        if(targetRow) scrollToEl(targetRow);
      }
    }catch(e){
      console.error('지난 질문 불러오기 실패', e);
      const errorDetail = (e && (e.code || e.message)) ? String(e.code || e.message) : 'unknown-error';
      results.innerHTML = `
        <div class="empty-state">
          불러오지 못했어. 잠시 후 다시 시도해줘.
          <div style="margin-top:8px;font-size:11px;opacity:.65;">${escapeHTML(errorDetail)}</div>
        </div>
      `;
    }
  }
  document.getElementById('dailyQuestionArchiveCloseBtn').addEventListener('click', ()=>{
    document.getElementById('dailyQuestionArchiveOverlay').classList.add('hidden');
  });

  function renderDailyQuestionCard(){
    const card = document.getElementById('dailyQuestionCard');
    if(!card) return;
    if(!todayQuestionData){
      card.innerHTML = `<div class="home-next-label">💭 오늘의 질문</div><div class="home-next-sub">질문을 불러오는 중이야...</div>`;
      return;
    }
    const answers = todayQuestionData.answers || {};
    // type이 없는 예전 질문 문서는 텍스트형으로 취급 (마이그레이션 불필요)
    const questionType = todayQuestionData.type || 'text';

    if(questionType === 'poll'){
      const options = todayQuestionData.options || [];
      const myChoice = answers[identity] ? answers[identity].text : null;
      card.innerHTML = `
        <div class="home-next-label">💭 오늘의 질문</div>
        <div class="daily-q-text">${escapeHTML(todayQuestionData.question || '')}</div>
        <div class="daily-q-poll-options">
          ${options.map((opt, idx) => {
            const voters = ALL_NAMES.filter(name => answers[name] && answers[name].text === opt);
            const isMine = myChoice === opt;
            return `<button type="button" class="daily-q-poll-btn ${isMine ? 'active' : ''}" data-poll-idx="${idx}" data-poll-text="${escapeHTML(opt)}">
              <span class="daily-q-poll-btn-text">${escapeHTML(opt)}</span>
              ${voters.length > 0 ? `<span class="daily-q-poll-voters">${voters.map(n => escapeHTML(n)).join(' · ')}</span>` : ''}
            </button>`;
          }).join('')}
        </div>
        <button type="button" class="daily-q-archive-link" id="dailyQuestionArchiveBtn">💭 지난 질문 모아보기</button>
      `;
      card.querySelectorAll('.daily-q-poll-btn').forEach(btn=>{
        btn.addEventListener('click', ()=> submitDailyQuestionPollAnswer(Number(btn.dataset.pollIdx), btn.dataset.pollText));
      });
      const archiveBtn = document.getElementById('dailyQuestionArchiveBtn');
      if(archiveBtn) archiveBtn.addEventListener('click', openDailyQuestionArchive);
      return;
    }

    // 다른 사람 답변이 도착해서 다시 그려질 때, 내가 아직 저장 안 하고 입력 중이던
    // 내용까지 같이 날아가지 않도록 미리 기억해뒀다가 다시 그린 뒤 복원함
    const prevInput = document.getElementById('dailyQuestionInput');
    const wasFocused = prevInput === document.activeElement;
    const prevTyped = prevInput ? prevInput.value : null;
    const prevSelStart = prevInput ? prevInput.selectionStart : null;
    const prevSelEnd = prevInput ? prevInput.selectionEnd : null;
    const mine = answers[identity];
    const hasAnswered = !!mine;
    const savedMine = (mine && mine.text) || '';
    // 아직 답 안 했으면 항상 입력창 노출, 답했으면 "수정"을 눌렀을 때만 입력창 노출
    const showInput = !hasAnswered || dailyQuestionEditMode;
    // 아직 저장 안 한 채로 타이핑 중이던 값이 있으면(저장된 값과 다르면) 그걸 우선 보여주고,
    // 수정 모드로 막 들어온 거라면 기존 답변을 미리 채워둠(처음부터 다시 안 써도 되게)
    const valueToShow = (prevTyped !== null && prevTyped !== savedMine) ? prevTyped : savedMine;

    card.innerHTML = `
      <div class="home-next-label">💭 오늘의 질문</div>
      <div class="daily-q-text">${escapeHTML(todayQuestionData.question || '')}</div>
      <div class="daily-q-answers">
        ${ALL_NAMES.map(name => {
          const a = answers[name];
          const isMine = name === identity;
          if(isMine && hasAnswered && !dailyQuestionEditMode){
            return `<div class="daily-q-row daily-q-row-mine">
              <span class="daily-q-name color-${colorKeyOf(name)}">${name}</span>
              <span class="daily-q-answer">${escapeHTML(a.text)}</span>
              <button type="button" class="daily-q-edit-btn" id="dailyQuestionEditBtn">수정</button>
            </div>`;
          }
          return `<div class="daily-q-row ${isMine ? 'daily-q-row-mine' : ''}">
            <span class="daily-q-name color-${colorKeyOf(name)}">${name}</span>
            <span class="daily-q-answer ${a ? '' : 'daily-q-answer-empty'}">${a ? escapeHTML(a.text) : '아직 답하지 않았어'}</span>
          </div>`;
        }).join('')}
      </div>
      ${showInput ? `
        <div class="daily-q-my-row">
          <input type="text" id="dailyQuestionInput" maxlength="60" placeholder="답변을 적어봐" value="${escapeHTML(valueToShow)}">
          <button type="button" id="dailyQuestionSubmitBtn">${hasAnswered ? '저장' : '답하기'}</button>
        </div>
        ${hasAnswered ? `<button type="button" class="daily-q-edit-cancel-btn" id="dailyQuestionEditCancelBtn">취소</button>` : ''}
      ` : ''}
      <button type="button" class="daily-q-archive-link" id="dailyQuestionArchiveBtn">💭 지난 질문 모아보기</button>
    `;
    const editBtn = document.getElementById('dailyQuestionEditBtn');
    if(editBtn){
      editBtn.addEventListener('click', ()=>{
        dailyQuestionEditMode = true;
        renderDailyQuestionCard();
        const newInput = document.getElementById('dailyQuestionInput');
        if(newInput) newInput.focus();
      });
    }
    const editCancelBtn = document.getElementById('dailyQuestionEditCancelBtn');
    if(editCancelBtn){
      editCancelBtn.addEventListener('click', ()=>{
        dailyQuestionEditMode = false;
        renderDailyQuestionCard();
      });
    }
    const submitBtn = document.getElementById('dailyQuestionSubmitBtn');
    if(submitBtn){
      submitBtn.addEventListener('click', submitDailyQuestionAnswer);
    }
    const input = document.getElementById('dailyQuestionInput');
    if(input){
      input.addEventListener('keydown', (e)=>{ if(e.key === 'Enter') submitDailyQuestionAnswer(); });
      if(wasFocused){
        input.focus();
        if(prevSelStart !== null) input.setSelectionRange(prevSelStart, prevSelEnd);
      }
    }
    const archiveBtn = document.getElementById('dailyQuestionArchiveBtn');
    if(archiveBtn) archiveBtn.addEventListener('click', openDailyQuestionArchive);
  }
  function submitDailyQuestionPollAnswer(optionIndex, optionText){
    if(!identity) return;
    const dateStr = localDateStr();
    // 질문을 보고 있는 사이 날짜가 바뀌었다면, 어제 질문에 잘못 저장하지 않도록 멈춤
    if(dailyQuestionWatchedDate !== dateStr){
      watchDailyQuestion();
      alert('날짜가 바뀌어서 오늘의 질문을 새로 불러왔어. 다시 골라줘!');
      return;
    }
    const fieldPath = `answers.${identity}`;
    db.collection('dailyQuestions').doc(dateStr).update({
      [fieldPath]: { text: optionText, optionIndex, updatedAt: Date.now() }
    }).catch(err => {
      console.error('오늘의 질문 투표 저장 실패', err);
      alert('답변을 저장하지 못했어. 잠시 후 다시 시도해줘.');
    });
  }
  function submitDailyQuestionAnswer(){
    if(!identity) return;
    const dateStr = localDateStr();

    // 질문을 보고 있는 사이 날짜가 바뀌었다면, 어제 질문의 답을 오늘 문서에
    // 잘못 저장하지 않도록 멈추고 오늘 질문으로 다시 불러옴
    if(dailyQuestionWatchedDate !== dateStr){
      watchDailyQuestion();
      alert('날짜가 바뀌어서 오늘의 질문을 새로 불러왔어. 새 질문에 답해줘!');
      return;
    }

    const input = document.getElementById('dailyQuestionInput');
    if(!input) return;
    const text = input.value.trim();
    if(!text) return;

    // 기존 답변과 완전히 같으면 서버에 다시 쓰지 않고 그냥 수정 모드만 닫음
    const savedText = (todayQuestionData && todayQuestionData.answers && todayQuestionData.answers[identity] && todayQuestionData.answers[identity].text) || '';
    if(text === savedText){
      dailyQuestionEditMode = false;
      renderDailyQuestionCard();
      return;
    }

    const fieldPath = `answers.${identity}`;
    db.collection('dailyQuestions').doc(dateStr).update({ [fieldPath]: { text, updatedAt: Date.now() } })
      .then(()=>{
        dailyQuestionEditMode = false;
        renderDailyQuestionCard();
      })
      .catch(err => {
        console.error('오늘의 질문 답변 저장 실패', err);
        alert('답변을 저장하지 못했어. 잠시 후 다시 시도해줘.');
      });
  }

  // ---- 오늘의 한 장 ----
  // board 컬렉션을 그대로 재사용함(postType:'dailyPhoto'로만 구분) - 그래서 사진 업로드,
  // 좋아요, 댓글, 답글, 알림 코드를 새로 안 만들어도 다 그대로 작동함.
  // 문서 ID를 "daily_이름_날짜"로 고정해서, 하루에 한 장만 남게(다시 올리면 그 문서를 덮어씀).
  let pendingDailyPhotoPhotos = [];
  function dailyPhotoDocId(name, dateStr){
    return `daily_${colorKeyOf(name)}_${dateStr}`;
  }
  // ---- 오늘의 한 장 모아보기 (추억 탭 서브탭) ----
  // boards 배열은 복작방 최근 100개 제한을 같이 쓰기 때문에, 오래 쓰다 보면 오래된
  // 오늘의 한 장이 그 100개 밖으로 밀려나 아카이브에서 사라질 수 있음 - 그래서 별도로
  // 전체를 한 번만 조회해서 씀 (실시간 구독은 아님 - 지난 기록 보는 용도라 필요 없음)
  let dailyPhotoArchiveFilter = 'all';
  let dailyPhotoArchiveItems = [];
  let dailyPhotoArchiveVisibleItems = [];
  let dailyPhotoArchiveLoaded = false;
  async function loadDailyPhotoArchive(){
    const list = document.getElementById('dailyPhotoArchiveList');
    if(!list) return;
    list.innerHTML = '<div class="empty-state">사진을 불러오는 중이야...</div>';
    try{
      const snap = await db.collection('board').where('postType', '==', 'dailyPhoto').get();
      dailyPhotoArchiveItems = snap.docs
        .map(doc => ({ id: doc.id, ...doc.data() }))
        .filter(it => getItemPhotos(it).length > 0)
        .sort((a,b) => String(b.date||'').localeCompare(String(a.date||'')));
      dailyPhotoArchiveLoaded = true;
      renderDailyPhotoArchive();
    }catch(e){
      console.error('오늘의 한 장 아카이브 불러오기 실패', e);
      list.innerHTML = '<div class="empty-state">사진을 불러오지 못했어. 잠시 후 다시 시도해줘.</div>';
    }
  }
  function dailyPhotoArchiveThumbHTML(item){
    const photo = getItemPhotos(item)[0];
    // createdAt이 아니라 date 필드를 씀 - 사진을 교체해도 date는 원래 날짜 그대로 유지되기 때문
    const dt = new Date((item.date || localDateStr()) + 'T00:00:00');
    const dateStr = `${dt.getMonth()+1}.${dt.getDate()}`;
    return `<div class="dp-archive-thumb" data-photo-post-id="${item.id}">
      <img src="${photo}" loading="lazy">
      <span class="dp-archive-thumb-name color-${colorKeyOf(item.author)}">${item.author||''}</span>
      <span class="dp-archive-thumb-date">${dateStr}</span>
    </div>`;
  }
  function renderDailyPhotoArchive(){
    const list = document.getElementById('dailyPhotoArchiveList');
    if(!list) return;
    if(!dailyPhotoArchiveLoaded) return; // 아직 조회 전이면(로딩 문구가 떠있는 채) 여기서는 아무것도 안 함
    const filtered = dailyPhotoArchiveFilter === 'all'
      ? dailyPhotoArchiveItems
      : dailyPhotoArchiveItems.filter(b => b.author === dailyPhotoArchiveFilter);
    dailyPhotoArchiveVisibleItems = filtered.slice();
    if(filtered.length === 0){
      list.innerHTML = '<div class="empty-state"><span class="empty-emoji">📸</span>아직 쌓인 오늘의 한 장이 없어.</div>';
      return;
    }
    // 이번 달/지난달 구분 없이 전부 YYYY-MM 기준으로 균일하게 묶어서, 모든 달이
    // 예외 없이 3열 격자로 표시되게 함 (date 필드 기준 - createdAt이 아님)
    const groups = {};
    filtered.forEach(item => {
      const monthKey = (item.date || '').slice(0, 7) || '기타';
      (groups[monthKey] = groups[monthKey] || []).push(item);
    });
    const monthKeys = Object.keys(groups).sort((a,b)=> b.localeCompare(a));
    list.innerHTML = monthKeys.map(monthKey => {
      const [y, m] = monthKey.split('-');
      const label = (y && m) ? `${y}년 ${Number(m)}월` : '날짜 미상';
      return `<div class="dp-archive-month-label">${label}</div>
        <div class="dp-archive-grid">${groups[monthKey].map(dailyPhotoArchiveThumbHTML).join('')}</div>`;
    }).join('');
    // 사진을 누르면 먼저 확대뷰로 감상함. 현재 사람 필터에 보이는 사진 전체를
    // 같은 순서로 넘겨서 좌우 스와이프로 연속해서 볼 수 있게 함.
    list.querySelectorAll('[data-photo-post-id]').forEach(el=>{
      el.addEventListener('click', ()=>{
        const entries = dailyPhotoArchiveVisibleItems
          .map(item => ({ item, photo: getItemPhotos(item)[0] }))
          .filter(entry => !!entry.photo);
        const index = entries.findIndex(entry => entry.item.id === el.dataset.photoPostId);
        if(index < 0 || typeof openPhotoLightbox !== 'function') return;
        openPhotoLightbox(
          entries.map(entry => entry.photo),
          index,
          entries.map(entry => entry.item.id)
        );
      });
    });
  }
  setupAuthorFilterRow('dailyPhotoArchiveFilterRow', ()=>dailyPhotoArchiveFilter, (v)=>{ dailyPhotoArchiveFilter = v; }, renderDailyPhotoArchive);

  function upsertBoardItem(item){
    const index = boards.findIndex(b => b.id === item.id);
    if(index >= 0) boards[index] = item;
    else boards.push(item);
  }
  function removeBoardItem(id){
    const index = boards.findIndex(b => b.id === id);
    if(index >= 0) boards.splice(index, 1);
  }
  // 아카이브의 사진은 최근 100개(boards) 제한 밖에 있을 수 있어서, navigateToItem()이
  // 찾지 못해 "불러오지 못했다"는 안내가 뜰 수 있음 - 열기 전에 boards에 임시로 넣어주고,
  // 보는 동안 좋아요·댓글이 계속 갱신되도록 그 문서만 따로 실시간 구독함.
  // openedArchivePhotoId는 "내가 임시로 끼워넣은 것"만 표시함 - 원래 최근 100개
  // 안에 있던 글이면 임시가 아니므로 여기 기록하지 않고, 나중에 지우지도 않음.
  let openedArchivePhotoId = null;
  let openedArchivePhotoUnsubscribe = null;
  function clearOpenedArchivePhoto(){
    if(openedArchivePhotoUnsubscribe){
      openedArchivePhotoUnsubscribe();
      openedArchivePhotoUnsubscribe = null;
    }
    if(openedArchivePhotoId){
      removeBoardItem(openedArchivePhotoId);
      openedArchivePhotoId = null;
    }
  }
  function openDailyPhotoArchivePost(id){
    const cachedItem = dailyPhotoArchiveItems.find(item => item.id === id);
    if(!cachedItem) return;

    // 이전에 임시로 열어뒀던 다른 과거 사진이 있으면 먼저 정리 (연달아 여러 개 봐도 안 쌓이게)
    clearOpenedArchivePhoto();

    // 이미 최근 100개 안에 있는 글이면 "임시"가 아니므로, 나중에 지울 대상으로 표시하지 않음
    const alreadyInRecentBoards = boards.some(b => b.id === id);
    upsertBoardItem(cachedItem);
    renderBoard(); // navigateToItem이 카드를 찾으려면 먼저 DOM에 존재해야 함

    const navigated = navigateToItem('board', id);
    if(!navigated){
      // 작성 중인 내용 때문에 이동이 취소됐다면, 임시로 넣었던 것도 그대로 되돌림
      if(!alreadyInRecentBoards){ removeBoardItem(id); renderBoard(); }
      return;
    }
    if(!alreadyInRecentBoards) openedArchivePhotoId = id;

    openedArchivePhotoUnsubscribe = db.collection('board').doc(id).onSnapshot(snap=>{
      if(!snap.exists){
        // 보는 도중에 삭제된 경우 - 화면에서도 지움
        removeBoardItem(id);
        dailyPhotoArchiveItems = dailyPhotoArchiveItems.filter(item => item.id !== id);
        if(openedArchivePhotoId === id) clearOpenedArchivePhoto();
        if(getCurrentActiveTab() === 'board') renderBoard();
        return;
      }
      const updatedItem = { id: snap.id, ...snap.data() };
      upsertBoardItem(updatedItem);
      const archiveIndex = dailyPhotoArchiveItems.findIndex(item => item.id === id);
      if(archiveIndex >= 0) dailyPhotoArchiveItems[archiveIndex] = updatedItem;
      if(getCurrentActiveTab() === 'board') renderBoard();
    }, err => console.error('과거 오늘의 한 장 구독 실패', err));
  }

  // null이면 오늘 처음 올리는 것, 기존 게시물을 넘기면 그 사진을 교체하는 모드
  let dailyPhotoEditingPost = null;
  function openDailyPhotoModal(existingPost){
    if(!identity) return;
    dailyPhotoEditingPost = existingPost || null;
    pendingDailyPhotoPhotos = existingPost ? getItemPhotos(existingPost).slice() : [];
    document.getElementById('dailyPhotoCaptionInput').value = existingPost ? (existingPost.body || '') : '';
    document.getElementById('dailyPhotoSaveBtn').textContent = existingPost ? '교체하기' : '올리기';
    renderPhotoPreviewGrid('dailyPhotoPreviewWrap', ()=>pendingDailyPhotoPhotos, (v)=>{ pendingDailyPhotoPhotos = v; });
    document.getElementById('dailyPhotoModal').classList.remove('hidden');
  }
  // ---- 오늘의 한 장 전용 16:9 자르기 (팬 + 핀치줌/휠줌 후 캔버스로 정확히 잘라냄) ----
  (function(){
    const modal = document.getElementById('dailyPhotoCropModal');
    const viewport = document.getElementById('cropViewport');
    const img = document.getElementById('cropImg');
    const retryBtn = document.getElementById('cropRetryBtn');
    const confirmBtn = document.getElementById('cropConfirmBtn');

    let naturalW = 0, naturalH = 0;
    let baseW = 0, baseH = 0; // 뷰포트를 꽉 채우는(cover) 기준 크기
    let baseCoverScale = 1;   // 원본 1px당 baseW/baseH 배율
    let userZoom = 1;         // 사용자가 추가로 확대한 배율 (1 이상)
    let panX = 0, panY = 0;
    let viewportWidth = 0;
    let viewportHeight = 0;

    let isPanning = false, isPinching = false;
    let startPanX = 0, startPanY = 0, startTouchX = 0, startTouchY = 0;
    let startDist = 0, startZoom = 1;

    function clampPan(){
      const halfW = (baseW * userZoom) / 2, halfH = (baseH * userZoom) / 2;
      const maxPanX = Math.max(0, halfW - viewportWidth / 2);
      const maxPanY = Math.max(0, halfH - viewportHeight / 2);
      panX = Math.min(maxPanX, Math.max(-maxPanX, panX));
      panY = Math.min(maxPanY, Math.max(-maxPanY, panY));
    }
    function applyTransform(){
      clampPan();
      img.style.width = baseW + 'px';
      img.style.height = baseH + 'px';
      img.style.transform = `translate(-50%, -50%) translate(${panX}px, ${panY}px) scale(${userZoom})`;
    }

    function loadImageIntoCrop(file){
      cropImageReady = false;
      confirmBtn.disabled = true;

      const fail = () => {
        alert('사진을 불러오지 못했어. 다른 사진으로 다시 시도해줘.');
        closeCropModal();
      };

      const reader = new FileReader();
      reader.onload = (e)=>{
        img.onload = ()=>{
          naturalW = img.naturalWidth;
          naturalH = img.naturalHeight;
          if(!naturalW || !naturalH){ fail(); return; }
          // 테두리를 제외한 실제 내부 너비/높이 사용
          viewportWidth = viewport.clientWidth;
          viewportHeight = viewport.clientHeight;
          // 가로·세로 모두 빈 공간 없이 채우는 cover 배율
          baseCoverScale = Math.max(viewportWidth / naturalW, viewportHeight / naturalH);
          baseW = naturalW * baseCoverScale;
          baseH = naturalH * baseCoverScale;
          userZoom = 1; panX = 0; panY = 0;
          applyTransform();
          cropImageReady = true;
          confirmBtn.disabled = false;
        };
        img.onerror = fail;
        img.src = e.target.result;
      };
      reader.onerror = fail;
      reader.readAsDataURL(file);
    }

    let pendingCropFile = null;
    let cropImageReady = false;
    window.openDailyPhotoCropModal = function(file){
      pendingCropFile = file;
      modal.classList.remove('hidden');
      loadImageIntoCrop(file);
    };
    function closeCropModal(){
      modal.classList.add('hidden');
      // src를 비울 때 불필요한 오류 이벤트가 발생하지 않도록 먼저 해제
      img.onload = null;
      img.onerror = null;
      img.removeAttribute('src');
      pendingCropFile = null;
      cropImageReady = false;
      confirmBtn.disabled = true;
      isPanning = false;
      isPinching = false;
    }
    retryBtn.addEventListener('click', ()=>{
      closeCropModal();
      document.getElementById('dailyPhotoPickInput').click();
    });

    function touchDist(touches){
      const dx = touches[0].clientX - touches[1].clientX;
      const dy = touches[0].clientY - touches[1].clientY;
      return Math.sqrt(dx*dx + dy*dy);
    }
    viewport.addEventListener('touchstart', (e)=>{
      if(e.touches.length === 2){
        isPinching = true; isPanning = false;
        startDist = touchDist(e.touches);
        startZoom = userZoom;
      } else if(e.touches.length === 1){
        isPanning = true; isPinching = false;
        startTouchX = e.touches[0].clientX - panX;
        startTouchY = e.touches[0].clientY - panY;
      }
    }, {passive: true});
    viewport.addEventListener('touchmove', (e)=>{
      if(isPinching && e.touches.length === 2){
        e.preventDefault();
        const dist = touchDist(e.touches);
        userZoom = Math.min(4, Math.max(1, startZoom * (dist / startDist)));
        applyTransform();
      } else if(isPanning && e.touches.length === 1){
        e.preventDefault();
        panX = e.touches[0].clientX - startTouchX;
        panY = e.touches[0].clientY - startTouchY;
        applyTransform();
      }
    }, {passive: false});
    viewport.addEventListener('touchend', ()=>{ isPanning = false; isPinching = false; });

    // 데스크탑 대응: 드래그로 팬, 휠로 확대/축소
    viewport.addEventListener('mousedown', (e)=>{
      isPanning = true;
      startTouchX = e.clientX - panX;
      startTouchY = e.clientY - panY;
    });
    window.addEventListener('mousemove', (e)=>{
      if(!isPanning) return;
      panX = e.clientX - startTouchX;
      panY = e.clientY - startTouchY;
      applyTransform();
    });
    window.addEventListener('mouseup', ()=>{ isPanning = false; });
    viewport.addEventListener('wheel', (e)=>{
      e.preventDefault();
      userZoom = Math.min(4, Math.max(1, userZoom - e.deltaY * 0.01));
      applyTransform();
    }, {passive: false});

    confirmBtn.addEventListener('click', ()=>{
      if(!pendingCropFile || !cropImageReady) return;
      cropImageReady = false;
      confirmBtn.disabled = true;

      const totalScale = baseCoverScale * userZoom;
      const renderedLeft = viewportWidth/2 + panX - (baseW * userZoom)/2;
      const renderedTop = viewportHeight/2 + panY - (baseH * userZoom)/2;
      const srcX = -renderedLeft / totalScale;
      const srcY = -renderedTop / totalScale;
      const srcWidth = viewportWidth / totalScale;
      const srcHeight = viewportHeight / totalScale;

      // 기존 900×900과 전체 픽셀 수가 거의 같은 16:9 크기
      const outputWidth = 1200;
      const outputHeight = 675;
      const canvas = document.createElement('canvas');
      canvas.width = outputWidth; canvas.height = outputHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, srcX, srcY, srcWidth, srcHeight, 0, 0, outputWidth, outputHeight);

      const isPng = pendingCropFile.type === 'image/png';
      canvas.toBlob((blob)=>{
        if(!blob){
          cropImageReady = true;
          confirmBtn.disabled = false;
          alert('사진을 처리하지 못했어. 다시 시도해줘.');
          return;
        }
        // 이전에 골랐던 임시 사진이 있으면 메모리 정리 후 교체
        revokePendingPhotoUrls(pendingDailyPhotoPhotos);
        pendingDailyPhotoPhotos = [{ url: URL.createObjectURL(blob), blob }];
        renderPhotoPreviewGrid('dailyPhotoPreviewWrap', ()=>pendingDailyPhotoPhotos, (v)=>{ pendingDailyPhotoPhotos = v; });
        closeCropModal();
      }, isPng ? 'image/png' : 'image/jpeg', isPng ? undefined : 0.6);
    });
  })();

  function closeDailyPhotoModal(){
    revokePendingPhotoUrls(pendingDailyPhotoPhotos);
    pendingDailyPhotoPhotos = [];
    dailyPhotoEditingPost = null;
    document.getElementById('dailyPhotoPickInput').value = '';
    document.getElementById('dailyPhotoCaptionInput').value = '';
    renderPhotoPreviewGrid('dailyPhotoPreviewWrap', ()=>pendingDailyPhotoPhotos, (v)=>{ pendingDailyPhotoPhotos = v; });
    document.getElementById('dailyPhotoModal').classList.add('hidden');
  }
  document.getElementById('dailyPhotoPickBtn').addEventListener('click', ()=> document.getElementById('dailyPhotoPickInput').click());
  document.getElementById('dailyPhotoPickInput').addEventListener('change', ()=>{
    const input = document.getElementById('dailyPhotoPickInput');
    const file = input.files && input.files[0];
    input.value = '';
    if(!file) return;
    openDailyPhotoCropModal(file);
  });
  document.getElementById('dailyPhotoCancelBtn').addEventListener('click', closeDailyPhotoModal);
  document.getElementById('dailyPhotoSaveBtn').addEventListener('click', async ()=>{
    if(!identity) return;
    if(pendingDailyPhotoPhotos.length === 0){ alert('사진을 먼저 골라줘.'); return; }

    const isReplacing = !!dailyPhotoEditingPost;
    const dateStr = localDateStr();

    // 교체 모달을 열어둔 채로 자정을 넘긴 경우 - 어제 게시물에 오늘 사진이 잘못 합쳐지는 것 방지
    if(isReplacing && dailyPhotoEditingPost.date !== dateStr){
      alert('날짜가 바뀌었어. 오늘의 한 장에서 다시 사진을 골라줘!');
      closeDailyPhotoModal();
      renderTodayUsCard();
      return;
    }
    if(isReplacing && !confirm('오늘의 한 장을 교체할까? (좋아요·댓글은 그대로 남아)')) return;

    const saveBtn = document.getElementById('dailyPhotoSaveBtn');
    if(saveBtn.disabled) return; // 빠르게 두 번 눌러 중복 업로드되는 것 방지
    saveBtn.disabled = true;

    const caption = document.getElementById('dailyPhotoCaptionInput').value.trim();
    const docId = isReplacing ? dailyPhotoEditingPost.id : dailyPhotoDocId(identity, dateStr);
    const oldPhotoUrls = isReplacing ? getItemPhotos(dailyPhotoEditingPost).slice() : [];

    showLoadingOverlay('오늘의 한 장을 올리는 중이야...');
    try{
      // 사진은 필수라서, 일반 게시물처럼 "사진 없이 저장할까?" 경로(saveWithPhotoFallback)를
      // 쓰지 않음 - 업로드 실패하면 그냥 실패로 처리하고, 사진 없는 문서가 만들어지지 않게 함
      const photos = await uploadPhotos(pendingDailyPhotoPhotos, (pct) => showLoadingOverlay(`올리는 중이야... ${pct}%`));
      if(photos.length === 0) throw new Error('업로드된 사진이 없어');

      const ref = db.collection('board').doc(docId);
      if(isReplacing){
        // 기존 반응·댓글·작성 시각·게시물 종류는 건드리지 않음
        await ref.update({ photos, body: caption, updatedAt: Date.now() });
        // Firestore 저장이 성공한 다음에만 이전 사진을 정리함 (실패해도 치명적이지 않으니 조용히 무시)
        const photosToDelete = oldPhotoUrls.filter(url => !photos.includes(url));
        await Promise.allSettled(photosToDelete.map(async (url) => {
          try{ await storage.refFromURL(url).delete(); }
          catch(err){ console.warn('이전 오늘의 한 장 사진 삭제 실패:', err); }
        }));
      } else {
        await ref.set({
          postType: 'dailyPhoto', author: identity, date: dateStr,
          photos, body: caption, likes: [], comments: [], createdAt: Date.now()
        });
      }
      closeDailyPhotoModal();
    }catch(err){
      console.error('오늘의 한 장 저장 실패:', err);
      // 모달과 선택한 사진은 그대로 남겨서 다시 시도할 수 있게 함
      alert('오늘의 한 장을 저장하지 못했어.\n인터넷 연결을 확인하고 다시 시도해줘.');
    }finally{
      hideLoadingOverlay();
      saveBtn.disabled = false;
    }
  });

  // ---- 알림함 (안 읽은 알림 배지 + 목록) ----
  let unreadNotifications = [];

  function watchNotifications(){
    if(!identity) return;
    rememberUnsubscribe(
      db.collection('notifications').doc(identity).collection('items')
        .where('read', '==', false)
        .onSnapshot(snap => {
          unreadNotifications = [];
          snap.forEach(doc => unreadNotifications.push({ id: doc.id, ...doc.data() }));
          unreadNotifications.sort((a,b) => (b.createdAt||0) - (a.createdAt||0));
          updateNotifBadge();
          renderNotifResults();
        }, err => console.error('알림함 구독 실패', err))
    );
  }

  function updateNotifBadge(){
    const count = unreadNotifications.length;
    const dot = document.getElementById('notifBadgeCount');
    if(dot){
      if(count > 0){
        dot.textContent = count > 99 ? '99+' : String(count);
        dot.classList.remove('hidden');
      } else {
        dot.classList.add('hidden');
      }
    }
    // 앱 아이콘 배지 (지원하는 브라우저/기기에서만 - 미지원이어도 에러 없이 그냥 무시됨)
    if('setAppBadge' in navigator){
      if(count > 0) navigator.setAppBadge(count).catch(()=>{});
      else if('clearAppBadge' in navigator) navigator.clearAppBadge().catch(()=>{});
    }
  }

  function markNotifRead(notifId){
    if(!identity || !notifId) return;
    db.collection('notifications').doc(identity).collection('items').doc(notifId)
      .update({ read: true }).catch(err => console.error('알림 읽음 처리 실패', err));
    // 이 알림을 보낼 때 같은 ID를 "태그"로 같이 심어뒀어서, 그 태그로 잠금화면/알림창의
    // 해당 알림도 정확히 콕 집어서 지울 수 있음
    postToActiveServiceWorker({ type: 'CLOSE_NOTIFICATION', tag: notifId });
  }

  // 앱이 완전히 꺼진 상태에서 알림을 눌러 콜드 스타트된 경우, 서비스워커의 postMessage를
  // 받을 기존 창이 없어서 그 경로로는 읽음 처리가 안 됨. 대신 알림 주소 자체에
  // ?notif=ID를 담아 보내뒀다가, 로그인 완료 시점에 이걸 읽어서 처리함.
  function handleNotifQueryParam(){
    const params = new URLSearchParams(window.location.search);
    const notifId = params.get('notif');
    if(notifId){
      markNotifRead(notifId);
      // 주소에서 지워서, 나중에 새로고침해도 같은 처리가 반복되지 않게 함
      params.delete('notif');
      // 삼성인터넷 강제 이동용으로 붙였던 캐시버스팅 값도 같이 정리 (기능상 필수는 아니고, 주소가 지저분해지지 않게 하는 용도)
      params.delete('_push');
      const newSearch = params.toString();
      const newUrl = window.location.pathname + (newSearch ? `?${newSearch}` : '') + window.location.hash;
      history.replaceState(null, '', newUrl);
    }
  }

  function renderNotifResults(){
    const container = document.getElementById('notifResults');
    if(!container) return;
    if(unreadNotifications.length === 0){
      container.innerHTML = '<div class="empty-state" style="padding:30px 10px;">안 읽은 알림이 없어.</div>';
      return;
    }
    container.innerHTML = unreadNotifications.map((n,i) => `
      <div class="search-result-item notif-item" data-notif-idx="${i}">
        <div style="flex:1; min-width:0;">
          <div class="search-result-title">${escapeHTML(n.title || '')}</div>
          ${n.body ? `<div class="search-result-sub">${escapeHTML((n.body||'').slice(0,44))}</div>` : ''}
        </div>
        <button type="button" class="notif-dismiss-btn" data-notif-dismiss="${i}">✕</button>
      </div>
    `).join('');
    container.querySelectorAll('[data-notif-idx]').forEach(el=>{
      el.addEventListener('click', ()=>{
        const idx = Number(el.dataset.notifIdx);
        const n = unreadNotifications[idx];
        if(!n) return;
        const navigated = n.itemId ? navigateToItem(n.tab, n.itemId, n.commentTs, n.replyTs) : activateTab(n.tab);
        // 작성 중인 내용 때문에 이동이 취소됐다면, 오버레이도 안 닫고 읽음 처리도 안 함
        if(navigated){
          closeNotifOverlay();
          markNotifRead(n.id);
        }
      });
    });
    container.querySelectorAll('[data-notif-dismiss]').forEach(btn=>{
      btn.addEventListener('click', (e)=>{
        e.stopPropagation();
        const idx = Number(btn.dataset.notifDismiss);
        const n = unreadNotifications[idx];
        if(n) markNotifRead(n.id);
      });
    });
  }

  function openNotifOverlay(){
    document.getElementById('notifOverlay').classList.remove('hidden');
    renderNotifResults();
  }
  function closeNotifOverlay(){
    document.getElementById('notifOverlay').classList.add('hidden');
  }
  document.getElementById('notifBellBtn').addEventListener('click', openNotifOverlay);
  document.getElementById('notifCloseBtn').addEventListener('click', closeNotifOverlay);
  document.getElementById('notifClearAllBtn').addEventListener('click', async ()=>{
    if(unreadNotifications.length === 0) return;
    if(!confirm(`안 읽은 알림 ${unreadNotifications.length}개를 전부 지울까?`)) return;
    const batch = db.batch();
    unreadNotifications.forEach(n => {
      batch.delete(db.collection('notifications').doc(identity).collection('items').doc(n.id));
    });
    try{
      // Firestore 삭제가 성공한 뒤에만 시스템 알림을 닫음 (순서가 바뀌면, 네트워크
      // 문제로 Firestore 삭제가 실패했을 때 시스템 알림만 사라지고 앱 안 알림함엔
      // 그대로 남아있는 불일치가 생길 수 있음)
      await batch.commit();
      postToActiveServiceWorker({ type: 'CLEAR_ALL_NOTIFICATIONS' });
    }catch(err){
      console.error('알림 전체 삭제 실패', err);
      alert('알림을 지우지 못했어. 잠시 후 다시 시도해줘.');
    }
  });

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
    rememberUnsubscribe(
      db.collection('profiles').onSnapshot(snap=>{
        profiles = {};
        snap.forEach(doc=>{ profiles[doc.id] = doc.data(); });
        renderTodayUsCard();
      }, err=>console.error('프로필 구독 실패', err))
    );
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

  function stopAllWatchers(){
    const currentUnsubscribes = unsubscribeFns.splice(0);
    currentUnsubscribes.forEach((unsubscribe)=>{
      try{ unsubscribe(); }catch(e){ /* 이미 해제된 구독은 무시 */ }
    });
    if(typeof clearOpenedArchivePhoto === 'function') clearOpenedArchivePhoto();
    if(typeof clearOpenedNotificationTarget === 'function') clearOpenedNotificationTarget();
    if(typeof releaseDateLogDraftLock === 'function' && activeDateLogLockScheduleId) releaseDateLogDraftLock();
    stopDailyQuestionWatch();
    watchersStarted = false;
    visitWatchStarted = false;
    Object.keys(collectionWatchersStarted).forEach((key)=>{ collectionWatchersStarted[key] = false; });
    unreadNotifications = [];

    // 로그아웃 후 다른 계정으로 로그인했을 때, 새 구독 데이터가 도착하기 전
    // 아주 잠깐이라도 이전 계정 화면이 보이지 않도록 캐시된 데이터도 비움
    // (앱 화면 자체는 로그인 게이트 뒤에 숨겨지므로 지금 당장 다시 그릴 필요는 없음)
    schedule = []; wishes = []; dateLogs = []; letters = []; boards = []; anniversaries = [];
    profiles = {};
    todayQuestionData = null;
    openCommentSections.clear();
    openPostDetails.clear();
    openReplyInputs.clear();

    updateNotifBadge();
    renderNotifResults();
  }
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
      watch(scheduleQuery, 'schedule', items=>{
        schedule = preserveOpenedNotificationTarget('schedule', items);
        renderSchedule(); renderCalendar(); renderHome();
      });
    } else if(tabName === 'wish'){
      const wishQuery = db.collection('wishlist').orderBy('createdAt', 'desc').limit(100);
      watch(wishQuery, 'wishlist', items=>{
        wishes = preserveOpenedNotificationTarget('wish', items);
        renderWish(); renderHome();
      });
    } else if(tabName === 'datelog'){
      const dateLogQuery = db.collection('datelog').orderBy('date', 'desc').limit(100);
      watch(dateLogQuery, 'datelog', items=>{
        dateLogs = preserveOpenedNotificationTarget('datelog', items);
        renderDateLog(); renderHome();
      });
    } else if(tabName === 'board'){
      const boardQuery = db.collection('board').orderBy('createdAt', 'desc').limit(100);
      watch(boardQuery, 'board', items=>{
        boards = preserveOpenedNotificationTarget('board', items);
        // 지금 임시로 열어서 보고 있는 과거 사진이 최근 100개 안에 없으면, 목록이 새로
        // 갱신될 때 같이 사라지지 않도록 다시 끼워넣음
        if(openedArchivePhotoId && !boards.some(b => b.id === openedArchivePhotoId)){
          const cached = dailyPhotoArchiveItems.find(item => item.id === openedArchivePhotoId);
          if(cached) boards.push(cached);
        }
        renderBoard(); renderHome();
      });
    } else if(tabName === 'letter'){
      const letterQuery = db.collection('letters').orderBy('createdAt', 'desc').limit(100);
      watch(letterQuery, 'letters', items=>{
        letters = preserveOpenedNotificationTarget('letter', items);
        renderLetters(); renderHome();
      });
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
      
      // 삭제할 정확한 댓글 객체 찾기 (시간으로 특정 - 삭제 버튼은 본인 것이거나 소정일 때만 보이니, 여기선 author로 다시 안 걸러도 됨)
      const targetComment = (item.comments || []).find(c => c.ts === ts);
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
              if (c.ts === ts) {
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
                const newReplies = (c.replies || []).filter(r => r.ts !== replyTs);
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
      tab:'wish', label:'하고 싶은 것', ts: it.createdAt || 0,
      title: it.title, sub: it.body || '', item: it,
      match: `${it.title||''} ${it.body||''}`.toLowerCase()
    }));
    dateLogs.forEach(it => items.push({
      tab:'datelog', label:'함께한 날', ts: it.createdAt || new Date(it.date+'T00:00:00').getTime(),
      title: it.title, sub: it.memo || it.location || '', item: it,
      match: `${it.title||''} ${it.memo||''} ${it.location||''}`.toLowerCase()
    }));
    boards.forEach(it => items.push({
      tab:'board', label:'복작방', ts: it.createdAt || 0,
      title: boardPreviewText(it), sub: it.body || '', item: it,
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

  // schedule/wish/datelog/board/letter 각각의 배열을 읽고/쓰고/다시 그리는 방법을
  // 한곳에 모아둠 - navigateToItem()과 ensureNotificationTargetLoaded()에서 공용으로 씀
  const TAB_DATA_ACCESS = {
    schedule: { col: 'schedule', getArr: () => schedule, setArr: (v) => { schedule = v; }, render: renderSchedule },
    wish:     { col: 'wishlist', getArr: () => wishes,   setArr: (v) => { wishes = v; },   render: renderWish },
    datelog:  { col: 'datelog',  getArr: () => dateLogs, setArr: (v) => { dateLogs = v; }, render: renderDateLog },
    board:    { col: 'board',    getArr: () => boards,   setArr: (v) => { boards = v; },   render: renderBoard },
    letter:   { col: 'letters',  getArr: () => letters,  setArr: (v) => { letters = v; },  render: renderLetters },
  };

  // 게시물이 로컬 배열(이미 화면에 그려질 준비가 된 데이터)에 있을 때, 알림이 가리키는
  // 위치가 접힌 영역(월별 그룹, 완료한 위시, 지난 일정) 안에 있으면 미리 펼쳐둠
  function expandGroupsForItem(tab, item){
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
    } else if(tab === 'schedule' && isPast(item)){
      showPastSchedule = true;
    }
  }

  // 최근 개수/기간 제한(복작방·위시·함께한날·편지 최근 100개, 일정 최근 3개월) 밖에
  // 있는 오래된 알림 대상은 로컬 배열에 없어서 화면에 못 그려짐 - 그 문서 하나만
  // Firestore에서 개별로 가져와 임시로 배열에 끼워넣고, 그 문서만 따로 실시간 구독해서
  // 보는 동안 수정·삭제가 반영되게 함. "임시"이므로 다 보고 나면(탭 이탈/다른 대상으로
  // 이동/로그아웃/삭제됨) 반드시 배열에서도 실제로 빼줘야 함 - clearOpenedNotificationTarget()
  // 하나로 그 정리를 전부 처리함(구독 해제 + 배열에서 제거 + 다시 그리기).
  let openedNotificationTarget = null; // { tab, item }
  let openedNotificationTargetUnsubscribe = null;
  function clearOpenedNotificationTarget(){
    if(openedNotificationTargetUnsubscribe){
      openedNotificationTargetUnsubscribe();
      openedNotificationTargetUnsubscribe = null;
    }
    const target = openedNotificationTarget;
    openedNotificationTarget = null;
    if(!target) return;
    const access = TAB_DATA_ACCESS[target.tab];
    if(!access) return;
    access.setArr(access.getArr().filter(item => item.id !== target.item.id));
    access.render();
  }
  function preserveOpenedNotificationTarget(tab, items){
    const target = openedNotificationTarget;
    if(!target || target.tab !== tab) return items;
    if(items.some(item => item.id === target.item.id)){
      // 일반 최근 목록 구독에 정식으로 들어왔으니, 더 이상 "임시"가 아님 -
      // 보호 표시와 개별 구독만 해제하고 배열은 그대로 둠(이미 items 안에 있으니까)
      if(openedNotificationTargetUnsubscribe){
        openedNotificationTargetUnsubscribe();
        openedNotificationTargetUnsubscribe = null;
      }
      openedNotificationTarget = null;
      return items;
    }
    return [...items, target.item];
  }
  async function ensureNotificationTargetLoaded(tab, itemId){
    const access = TAB_DATA_ACCESS[tab];
    if(!access) return;
    if(access.getArr().some(it => it.id === itemId)) return; // 이미 있으면 할 일 없음
    try{
      const snap = await db.collection(access.col).doc(itemId).get();
      if(!snap.exists) return;
      // 조회하는 사이 실시간 구독으로 이미 들어왔을 수도 있으니 다시 한번 확인
      const latestArr = access.getArr();
      if(latestArr.some(it => it.id === itemId)) return;
      const fetchedItem = { id: snap.id, ...snap.data() };
      access.setArr([...latestArr, fetchedItem]);
      // 혹시 전에 다른 임시 대상을 보호하고 있었다면 먼저 정리
      if(openedNotificationTarget && openedNotificationTarget.item.id !== itemId){
        clearOpenedNotificationTarget();
      }
      openedNotificationTarget = { tab, item: fetchedItem };
      expandGroupsForItem(tab, fetchedItem);
      access.render();
      // 댓글/답글 알림이었다면, 이제 막 로드된 게시물에도 댓글창 열림 상태를 반영
      if(pendingScrollTarget && pendingScrollTarget.tab === tab && pendingScrollTarget.itemId === itemId && pendingScrollTarget.commentTs && TAB_TO_COL[tab]){
        openCommentSections.add(`${TAB_TO_COL[tab]}-${itemId}`);
      }
      tryConsumePendingScroll(); // 방금 그려졌으니 바로 한 번 더 시도

      // 이 문서 하나만 따로 실시간 구독 - 보는 동안 수정되면 화면도 갱신되고,
      // 삭제되면 화면에서 지우고 안내함
      openedNotificationTargetUnsubscribe = db.collection(access.col).doc(itemId).onSnapshot(snap2=>{
        if(!openedNotificationTarget || openedNotificationTarget.tab !== tab || openedNotificationTarget.item.id !== itemId) return;
        if(!snap2.exists){
          clearOpenedNotificationTarget();
          showPushToast('삭제된 게시물이야', null, null, null, null, true);
          return;
        }
        const updatedItem = { id: snap2.id, ...snap2.data() };
        openedNotificationTarget.item = updatedItem;
        access.setArr(access.getArr().map(item => item.id === itemId ? updatedItem : item));
        expandGroupsForItem(tab, updatedItem);
        access.render();
      }, err => console.error('알림 대상 개별 구독 실패', err));
    }catch(e){
      console.error('알림 대상 개별 조회 실패', e);
    }
  }

  function navigateToItem(tab, itemId, commentTs, replyTs){
    // 오늘의 질문 알림은 게시글 문서가 아니라 홈 카드(또는 지난 질문 아카이브)를 가리킴.
    // itemId가 "daily-question" 또는 "daily-question-2026-07-14"처럼 날짜가 붙어서 옴.
    // (콜론이 아니라 대시로 구분함 - 콜론은 URL 해시를 나눌 때 구분자와 겹쳐서 날짜가
    // commentTs 자리로 밀려버리는 문제가 있었음)
    const itemIdStr = String(itemId);
    const datedQuestionMatch = itemIdStr.match(/^daily-question-(\d{4}-\d{2}-\d{2})$/);
    if(tab === 'home' && (itemIdStr === 'daily-question' || datedQuestionMatch)){
      const datePart = datedQuestionMatch ? datedQuestionMatch[1] : null;
      if(!datePart || datePart === localDateStr()){
        // 날짜가 없거나(예전 알림) 오늘 질문이면 기존처럼 홈 카드로 스크롤
        if(!activateTab('home')) return false;
        const card = document.getElementById('dailyQuestionCard');
        if(card) scrollToEl(card);
      } else {
        // 지난 질문이면 홈으로 전환한 뒤(아카이브를 닫아도 자연스럽게 홈에 있도록)
        // 아카이브를 열고 그 날짜 행으로 바로 스크롤+펼침
        if(!activateTab('home')) return false;
        openDailyQuestionArchive(datePart);
      }
      return true;
    }
    // 상태 변경/반응 알림도 마찬가지로, 홈의 오늘의 우리 카드까지 정확히 스크롤함
    if(tab === 'home' && itemId === 'today-us'){
      if(!activateTab('home')) return false;
      const card = document.getElementById('todayUsCard');
      if(card) scrollToEl(card);
      return true;
    }

    if(!activateTab(tab)) return false; // 작성 중인 내용 때문에 이동이 취소됐으면 여기서 멈춤

    // 그 탭에 필터가 걸려있으면(예: 특정 사람 것만 보기), 알림으로 찾아온 게시글이
    // 필터에 가려서 화면에 안 그려질 수 있음 -> 무조건 "전체 보기"로 풀어서
    // 대상이 반드시 화면에 나타나게 함
    if(tab === 'schedule'){
      // 일정은 사람 필터랑 별개로, 달력에서 특정 날짜를 눌러서 생기는 날짜 필터도 있음 -
      // 이것도 안 풀면 "7월 15일만 보는 중"일 때 7월 20일 알림을 못 찾는 문제가 있었음
      const hadScheduleFilter = !!calendarFilterDate || scheduleFilterNames.length > 0;
      calendarFilterDate = null;
      if(scheduleFilterNames.length > 0){
        scheduleFilterNames = [];
        renderScheduleFilterRow();
      }
      if(hadScheduleFilter) renderCalendar(); // 달력 자체에도 필터가 반영되니 다시 그림
    } else if(tab === 'letter' && letterFilterTarget !== 'all'){
      letterFilterTarget = 'all';
      document.querySelectorAll('#letterFilterRow .filter-chip').forEach(b=>{
        b.classList.toggle('active', b.dataset.letterFilter === 'all');
      });
    } else if(tab === 'wish' && wishAuthorFilter !== 'all'){
      wishAuthorFilter = 'all';
      document.querySelectorAll('#wishFilterRow [data-author-filter]').forEach(b=>{
        b.classList.toggle('active', b.dataset.authorFilter === 'all');
      });
    } else if(tab === 'datelog' && dateLogAuthorFilter !== 'all'){
      dateLogAuthorFilter = 'all';
      document.querySelectorAll('#dateLogFilterRow [data-author-filter]').forEach(b=>{
        b.classList.toggle('active', b.dataset.authorFilter === 'all');
      });
    } else if(tab === 'board' && boardAuthorFilter !== 'all'){
      boardAuthorFilter = 'all';
      document.querySelectorAll('#boardFilterRow [data-author-filter]').forEach(b=>{
        b.classList.toggle('active', b.dataset.authorFilter === 'all');
      });
    }

    openPostDetails.add(itemId); // 데이터가 아직 안 왔어도, 오면 열려있도록 미리 기억해둠

    let item = null;
    if(tab === 'schedule') item = schedule.find(x=>x.id===itemId);
    else if(tab === 'wish') item = wishes.find(x=>x.id===itemId);
    else if(tab === 'datelog') item = dateLogs.find(x=>x.id===itemId);
    else if(tab === 'board') item = boards.find(x=>x.id===itemId);
    else if(tab === 'letter') item = letters.find(x=>x.id===itemId);

    // 지금 이동하려는 대상이 이전에 개별 조회해서 보호해두던 것과 다르면, 그 보호는 해제함
    // (더 이상 보고 있는 대상이 아니니 다음 실시간 갱신 때 굳이 지켜줄 필요 없음)
    if(openedNotificationTarget && !(openedNotificationTarget.tab === tab && openedNotificationTarget.item.id === itemId)){
      clearOpenedNotificationTarget();
    }

    if(item){
      expandGroupsForItem(tab, item);
    } else {
      // 최근 개수/기간 제한(예: 복작방 최근 100개, 일정 최근 3개월) 밖에 있는
      // 오래된 알림 대상일 수 있음 - 서버에서 그 문서 하나만 개별로 가져와서 임시로
      // 목록에 끼워넣음. 백그라운드로 진행하고, 없으면(진짜 삭제) 기존 확인 절차가
      // 알아서 "삭제된 게시물이야" 안내로 이어짐
      ensureNotificationTargetLoaded(tab, itemId);
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

    // 즉시 시도와 렌더 훅으로도 목표를 찾지 못하는 경우를 위한 최후의 안전장치.
    //
    // 4초가 됐는데 게시물 카드조차 없으면 Firestore 서버에서 문서 존재 여부를 확인:
    //   - 문서가 없으면 "삭제된 게시물이야"
    //   - 문서가 있으면 로딩이 늦은 것이므로 조금 더 기다림
    //
    // 게시물은 나타났지만 댓글/답글만 없으면 tryConsumePendingScroll()에서
    // 별도로 빠르게 확인해 안내함.
    let pollCount = 0;
    let postDeletionCheckStarted = false;

    scrollPollInterval = setInterval(() => {
      pollCount++;

      if(!pendingScrollTarget){
        clearScrollState();
        return;
      }

      const targetSnapshot = { ...pendingScrollTarget };
      const card = document.querySelector(
        `[data-item-id="${targetSnapshot.itemId}"]`
      );

      // 0.5초 × 8회 = 약 4초.
      // 게시물 카드가 여전히 없을 때만 삭제 여부를 확인함.
      if(
        pollCount === 8 &&
        !card &&
        !postDeletionCheckStarted
      ){
        postDeletionCheckStarted = true;
        verifyDeletedPostTarget(targetSnapshot);
      }

      // 최대 10초까지 기다렸는데도 못 찾았고,
      // 서버에서 삭제됐다는 확인도 되지 않았다면 네트워크/로딩 문제로 안내.
      if(pollCount > 20){
        clearScrollState();
        showPushToast(
          '게시글을 불러오지 못했어. 잠시 후 다시 시도해줘',
          null,
          null
        );
        return;
      }

      tryConsumePendingScroll();
    }, 500);
    return true;
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

  // ---- 내 활동 모아보기 (내가 쓴 글 + 내가 쓴 댓글/답글) ----
  const MY_ACTIVITY_COLLECTIONS = [
    { list: () => schedule, tab:'schedule', label:'일정',
      getTitle: it => it.title, getSub: it => it.memo || fmtShortDate(it.date),
      getTs: it => it.createdAt || new Date(it.date+'T00:00:00').getTime() },
    { list: () => wishes, tab:'wish', label:'하고 싶은 것',
      getTitle: it => it.title, getSub: it => it.body || '', getTs: it => it.createdAt || 0 },
    { list: () => dateLogs, tab:'datelog', label:'함께한 날',
      getTitle: it => it.title, getSub: it => it.memo || it.location || '',
      getTs: it => it.createdAt || new Date(it.date+'T00:00:00').getTime() },
    { list: () => boards, tab:'board', label:'복작방',
      getTitle: it => boardPreviewText(it), getSub: it => it.body || '', getTs: it => it.createdAt || 0 },
    { list: () => letters, tab:'letter', label:'편지',
      getTitle: it => it.title || (it.body||'').slice(0,20), getSub: it => it.body || '', getTs: it => it.createdAt || 0 },
  ];

  function buildMyActivityIndex(){
    if(!identity) return [];
    const items = [];
    MY_ACTIVITY_COLLECTIONS.forEach(({ list, tab, label, getTitle, getSub, getTs }) => {
      list().forEach(it => {
        if(it.author === identity){
          items.push({ kind:'post', tab, label:`내가 쓴 ${label}`, ts:getTs(it), title:getTitle(it), sub:getSub(it), itemId:it.id });
        }
        (it.comments || []).forEach(c => {
          if(c.author === identity && !c.deleted){
            items.push({ kind:'comment', tab, label:`${label}에 남긴 댓글`, ts:c.ts, title:getTitle(it), sub:c.text || '', itemId:it.id, commentTs:c.ts });
          }
          (c.replies || []).forEach(r => {
            if(r.author === identity){
              items.push({ kind:'comment', tab, label:`${label}에 남긴 답글`, ts:r.ts, title:getTitle(it), sub:r.text || '', itemId:it.id, commentTs:c.ts, replyTs:r.ts });
            }
          });
        });
      });
    });
    return items.sort((a,b)=> b.ts - a.ts);
  }

  let myActivityCategory = 'all';
  function renderMyActivityResults(){
    const container = document.getElementById('myActivityResults');
    let index = buildMyActivityIndex();
    if(myActivityCategory !== 'all') index = index.filter(r => r.kind === myActivityCategory);

    if(index.length === 0){
      container.innerHTML = '<div class="empty-state" style="padding:30px 10px;">아직 활동이 없어.</div>';
      return;
    }
    container.innerHTML = index.map((r,i) => `
      <div class="search-result-item" data-my-activity-idx="${i}">
        <span class="search-result-label">${r.label}</span>
        <div>
          <div class="search-result-title">${escapeHTML(r.title || '')}</div>
          ${r.sub ? `<div class="search-result-sub">${escapeHTML(r.sub.slice(0,44))}</div>` : ''}
        </div>
      </div>
    `).join('');
    container.querySelectorAll('[data-my-activity-idx]').forEach((el,i)=>{
      el.addEventListener('click', ()=>{
        closeMyActivityOverlay();
        navigateToItem(index[i].tab, index[i].itemId, index[i].commentTs, index[i].replyTs);
      });
    });
  }

  function openMyActivityOverlay(){
    document.getElementById('myActivityOverlay').classList.remove('hidden');
    myActivityCategory = 'all';
    document.querySelectorAll('#myActivityCategoryRow .activity-cat-btn').forEach(b=> b.classList.toggle('active', b.dataset.myCat === 'all'));
    renderMyActivityResults();
  }
  function closeMyActivityOverlay(){
    document.getElementById('myActivityOverlay').classList.add('hidden');
  }
  document.getElementById('myActivityCloseBtn').addEventListener('click', closeMyActivityOverlay);
  document.querySelectorAll('#myActivityCategoryRow .activity-cat-btn').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      document.querySelectorAll('#myActivityCategoryRow .activity-cat-btn').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      myActivityCategory = btn.dataset.myCat;
      renderMyActivityResults();
    });
  });
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
    rememberUnsubscribe(
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
      }, err=>console.error('방문자 수 구독 실패', err))
    );
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
        handleNotifQueryParam(); // 콜드 스타트 시 URL에 담겨온 notif ID 읽음 처리
        // 로그인 전에 서비스워커 이동정보가 먼저 도착했다면 지금 처리
        if(deferredNavigateMessage){
          const msg = deferredNavigateMessage;
          deferredNavigateMessage = null;
          handleServiceWorkerNavigate(msg);
        }
        trackVisit();
        watchVisitCounter();
        if('Notification' in window && Notification.permission === 'granted'){
          setupPushNotifications();
        } else {
          maybeShowNotifPrompt();
        }
      } else if(user && !EMAIL_MAP[user.email]){
        loginInProgress = false;
        if(foregroundMessageUnsubscribe){
          foregroundMessageUnsubscribe();
          foregroundMessageUnsubscribe = null;
        }
        clearTransientNavigationState();
        stopAllWatchers();
        identity = null;
        updateIdentityChip();
        firebase.auth().signOut();
        showGate('이 구글 계정은 사용할 수 없어.<br>백씨스터즈 멤버 계정으로만 로그인해줘.');
      } else if(!loginInProgress){
        // 로그인 처리 중에 이 콜백이 user=null 상태로 한 번 더 불릴 때가 있는데,
        // 그때는 "로그인 중이야..." 문구를 이 기본 문구로 덮어쓰지 않게 함.
        // 여기서는 clearTransientNavigationState()를 부르지 않음 - 이 분기는 "아직
        // 로그인 전" 상태에서 정상적으로도 매번 거치는 곳이라, 알림을 눌러서 앱에
        // 들어왔지만 로그인이 필요한 경우 저장해둔 이동정보(특히 아이폰의 도착 시점
        // 저장분)를 로그인도 하기 전에 지워버리면 안 됨. 명시적 로그아웃/차단된 계정
        // 분기에서만 정리하면 됨.
        stopAllWatchers();
        identity = null;
        updateIdentityChip();
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
