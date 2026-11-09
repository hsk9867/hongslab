/* 홍스랩 서브 페이지 공통 타이포그래피 효과
   화면에 들어오는 순서대로: 작은 제목은 자간이 좁혀지며, 소제목은 글자 단위로 올라오고,
   본문은 흐림에서 선명하게, 목록은 한 줄씩 차례로, 큰 숫자는 튀어 오르며 나타난다.
   제목(h1·h2)의 단어 롤업과 카드(.rv) 등장은 각 페이지의 기존 스크립트가 맡는다. */
(()=>{
  const d=document,root=d.documentElement,main=d.querySelector('main');
  if(!main||matchMedia('(prefers-reduced-motion: reduce)').matches||!('IntersectionObserver' in window))return;
  root.classList.add('tfx');
  const done=new WeakSet();
  const skip=el=>done.has(el)||el.classList.contains('fx')||!!el.closest('form,#result,.tm-modal,.bill,[data-tfx-off],noscript,script');
  const tagged=[];
  const tag=(el,cls)=>{if(skip(el))return false;done.add(el);el.classList.add(cls);tagged.push([el,cls]);return true};
  const each=(sel,fn)=>main.querySelectorAll(sel).forEach(fn);

  /* 1) 작은 제목(아이브로우): 자간 수축 */
  each('.eyebrow',el=>{const ls=getComputedStyle(el).letterSpacing;if(tag(el,'tx-track'))el.style.setProperty('--ls',ls)});

  /* 2) 소제목: 글자 단위 등장 (낱말이 줄 끝에서 쪼개지지 않게 낱말 단위로 묶는다) */
  each('h3, .card>b, #talk .cols b',el=>{
    if(skip(el)||el.querySelector('a,button,input'))return;
    const label=el.textContent.replace(/\s+/g,' ').trim();if(!label||label.length>40)return;
    let i=0;
    const walk=n=>{[...n.childNodes].forEach(c=>{
      if(c.nodeType===3){
        const frag=d.createDocumentFragment();
        c.textContent.split(/(\s+)/).forEach(w=>{
          if(!w)return;
          if(/^\s+$/.test(w)){frag.appendChild(d.createTextNode(' '));return}
          const wd=d.createElement('span');wd.className='wd';
          [...w].forEach(ch=>{const s=d.createElement('span');s.className='c';s.textContent=ch;s.style.setProperty('--i',i++);wd.appendChild(s)});
          frag.appendChild(wd);
        });
        n.replaceChild(frag,c);
      }else if(c.nodeType===1&&c.tagName!=='BR'&&c.tagName!=='SVG')walk(c);
    })};
    walk(el);
    if(i)tag(el,'tx-chars');
  });

  /* 3) 목록 · 접이식 질문: 한 줄씩 차례로 */
  each('ul,ol,dl,.tip,.note,.who,.faq-list,#faqs .group',box=>{
    if(box.closest('form,#result,.bill,nav'))return;
    let i=0;[...box.children].forEach(c=>{if(/^(LI|DT|DD|SPAN|DIV|DETAILS)$/.test(c.tagName)&&!c.classList.contains('rv')&&!c.classList.contains('st')&&tag(c,'tx-up'))c.style.setProperty('--i',Math.min(i++,8))});
  });
  each('details',el=>tag(el,'tx-up'));

  /* 4) 큰 숫자: 튀어 오름 */
  each('.no b, .k, .amt em, .days, #basic .it .no',el=>tag(el,'tx-pop'));

  /* 5) 본문 문단: 흐림 → 선명 (목록 · 접이식 안의 문단은 3번이 이미 맡는다) */
  each('p',el=>{if(!el.closest('li,details,.tx-up'))tag(el,'tx-blur')});

  const io=new IntersectionObserver(en=>en.forEach(e=>{
    if(!e.isIntersecting)return;
    const el=e.target;io.unobserve(el);el.classList.add('in');
    /* 등장이 끝나면 효과용 클래스를 걷어 원래의 hover · transition 으로 돌려 놓는다 (글자 단위 분할은 그대로 둔다) */
    const cls=el.dataset.tx;if(cls!=='tx-chars')setTimeout(()=>{el.classList.remove(cls,'in');if(cls==='tx-track')el.style.removeProperty('--ls')},2400);
  }),{threshold:.12,rootMargin:'0px 0px -4% 0px'});
  tagged.forEach(([el,cls])=>{el.dataset.tx=cls;io.observe(el)});
})();
