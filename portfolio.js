/* 홍스랩 제작사례 목록 — index.html, portfolio.html 이 함께 사용 */
const PORTFOLIO=[
 ['https://라이칸짐.com/','라이칸짐 연수점 홈페이지','헬스장·피트니스'],
 ['http://xn--bj0bp80c9gb.com/','정글짐 내수점 홈페이지','헬스장·피트니스'],
 ['http://soksiwon-air.com/','속시원 에어컨 견적 웹앱','웹앱·서비스 업체'],
 ['https://www.woojunggift.com/','우정티켓 홈페이지','서비스 업체'],
 ['https://www.doorguard24.com/','도어가드24 홈페이지','서비스 업체'],
 ['https://gingmoji00.mycafe24.com/','깅모지 쇼핑몰','쇼핑몰'],
 ['https://nbh0000.github.io/gds-site/','(주)지디에스 홈페이지','기업 홈페이지'],
 ['https://www.yeongyeolochangkmc.co.kr/','연결한의원 청주오창 홈페이지','병원·의원'],
 ['https://elecmanagepartners.com/','전기관리파트너스 홈페이지','서비스 업체'],
 ['https://withthelake.com/','위드더레이크 홈페이지','브랜드 사이트'],
 ['https://antaean.kr/','안태인펜싱클럽 홈페이지','학원·클럽'],
 ['https://clearcheolgeo.com/','클리어철거 홈페이지','시공 업체'],
 ['https://cardly.kr/','Cardly 웹앱','웹앱'],
 ['https://pajufreewaycilcenter.co.kr/','파주자유로장애인자립생활센터 홈페이지','기관·단체'],
 ['https://nbh0000.github.io/shuttledraw/app/','셔틀드로우 웹앱','웹앱'],
 ['https://nbh0000.github.io/daehyun-industry-web/','(주)대현산업 홈페이지','기업 홈페이지'],
 ['https://nbh0000.github.io/phoneshop-web/','폰다이렉트 홈페이지','판매·유통'],
 ['https://nbh0000.github.io/renderfit-preview/','렌더핏 웹앱','웹앱'],
 ['https://gunaminc.kr/','(주)구남종합인력 홈페이지','서비스 업체'],
 ['https://cheheompick.kr/','체험픽 웹앱','웹앱·플랫폼']
];
/* 한글 도메인은 mshots 가 거부(403)해서 직접 찍은 /shots/<punycode>.jpg 사용 */
const shot=(url,w)=>{let h='';try{h=new URL(url).hostname}catch(e){}return /(^|\.)xn--/.test(h)?`/shots/${h}.jpg`:`https://s.wordpress.com/mshots/v1/${encodeURIComponent(url)}?w=${w}`};
