// api/search-food.js
// Vercel 서버리스 함수: 공공데이터포털의 "식품의약품안전처_식품영양성분DB정보"(FoodNtrCpntDbInfo02)를
// 서버에서 대신 호출해 CORS 문제를 우회합니다.
// 필요한 환경변수: MFDS_API_KEY (공공데이터포털에서 발급받은 "일반 인증키(Decoding)" 값을 그대로 저장)

const ENDPOINT = 'http://apis.data.go.kr/1471000/FoodNtrCpntDbInfo02/getFoodNtrCpntDbInq02';

// 실제 응답에서 값이 들어있을 것으로 예상되는 필드명 후보들 (첫 확인 후 정확한 이름으로 정리 예정)
const NAME_KEYS = ['FOOD_NM_KR', 'DESC_KOR', 'foodNmKr'];
const KCAL_KEYS = ['NUTR_CONT1', 'AMT_NUM1', 'ENERC', 'energy', 'NUTR_CONT01'];

function pickField(obj, keys) {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  }
  return null;
}

export default async function handler(req, res) {
  const q = (req.query.q || '').toString().trim();

  if (!q) {
    res.status(400).json({ error: '검색어(q)가 필요합니다.' });
    return;
  }

  const apiKey = process.env.MFDS_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'MFDS_API_KEY 환경변수가 설정되지 않았습니다.' });
    return;
  }

  const params = new URLSearchParams({
    serviceKey: apiKey, // URLSearchParams가 알아서 인코딩해줌 (디코딩된 키를 그대로 넣어야 함)
    type: 'json',
    numOfRows: '20',
    pageNo: '1',
    FOOD_NM_KR: q,
  });

  const url = `${ENDPOINT}?${params.toString()}`;

  try {
    const upstream = await fetch(url);
    const rawText = await upstream.text();

    let data;
    try {
      data = JSON.parse(rawText);
    } catch (parseErr) {
      res.status(502).json({
        error: '공공데이터포털 서버가 JSON이 아닌 응답을 반환했어요.',
        upstreamStatus: upstream.status,
        rawPreview: rawText.slice(0, 500),
      });
      return;
    }

    // data.go.kr 표준 응답 포맷: { response: { header: {...}, body: { items: { item: [...] } } } }
    const header = data?.response?.header;
    if (header && header.resultCode && header.resultCode !== '00') {
      res.status(502).json({
        error: '공공데이터포털 API 오류',
        resultCode: header.resultCode,
        resultMsg: header.resultMsg,
      });
      return;
    }

    let items = data?.response?.body?.items?.item;
    if (!items) items = [];
    if (!Array.isArray(items)) items = [items]; // 결과가 1건이면 배열이 아니라 객체로 오는 경우가 있음

    const results = items.map((item) => {
      const name = pickField(item, NAME_KEYS);
      const kcalRaw = pickField(item, KCAL_KEYS);
      return {
        name: name || '(이름 확인 필요)',
        kcal: kcalRaw !== null ? Math.round(parseFloat(kcalRaw) || 0) : null,
      };
    });

    // 칼로리 필드를 아직 못 찾은 경우를 대비해, 첫 번째 결과의 원본 필드를 함께 보내줌 (진단용)
    const responsePayload = { results };
    if (items.length > 0 && results[0] && results[0].kcal === null) {
      responsePayload.debugFirstItemRaw = items[0];
    }
    if (items.length === 0) {
      // 결과가 아예 없을 때: totalCount와 원본 응답 일부를 함께 보내 원인 파악을 돕는다
      responsePayload.debugTotalCount = data?.response?.body?.totalCount ?? null;
      responsePayload.debugRawPreview = JSON.stringify(data).slice(0, 800);
    }

    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    res.status(200).json(responsePayload);
  } catch (e) {
    res.status(500).json({ error: '서버 오류', message: e.message });
  }
}
