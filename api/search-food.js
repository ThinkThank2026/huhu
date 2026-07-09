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
  const category = (req.query.category || '').toString().trim();

  if (!q && !category) {
    res.status(400).json({ error: '검색어(q) 또는 카테고리(category)가 필요합니다.' });
    return;
  }

  const apiKey = process.env.MFDS_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'MFDS_API_KEY 환경변수가 설정되지 않았습니다.' });
    return;
  }

  const paramObj = {
    serviceKey: apiKey, // URLSearchParams가 알아서 인코딩해줌 (디코딩된 키를 그대로 넣어야 함)
    type: 'json',
    numOfRows: '30',
    pageNo: '1',
  };
  if (q) paramObj.FOOD_NM_KR = q;
  if (category) paramObj.FOOD_CAT1_NM = category;

  const params = new URLSearchParams(paramObj);

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

    // 실제 응답 포맷: { header: {...}, body: { items: [...], totalCount, ... } } (response 래퍼 없음)
    const header = data?.header;
    if (header && header.resultCode && header.resultCode !== '00') {
      res.status(502).json({
        error: '공공데이터포털 API 오류',
        resultCode: header.resultCode,
        resultMsg: header.resultMsg,
      });
      return;
    }

    let items = data?.body?.items;
    if (!items) items = [];
    if (!Array.isArray(items)) items = [items]; // 결과가 1건이면 배열이 아니라 객체로 오는 경우가 있음

    function parseGrams(servingSize) {
      if (!servingSize) return 100;
      const match = String(servingSize).match(/([\d.]+)\s*g/i);
      return match ? parseFloat(match[1]) : 100;
    }

    const rawResults = items.map((item) => {
      const name = pickField(item, NAME_KEYS);
      const kcalRaw = pickField(item, KCAL_KEYS);
      const kcal = kcalRaw !== null ? parseFloat(kcalRaw) || 0 : null;
      const grams = parseGrams(item.SERVING_SIZE);
      return {
        name: name || '(이름 확인 필요)',
        // 기준량이 제각각(100g, 150g 등)일 수 있으므로 100g 기준으로 정규화해서 비교/평균
        kcalPer100g: kcal !== null ? (kcal / grams) * 100 : null,
        category: item.FOOD_CAT1_NM || null,
      };
    });

    // 같은 이름의 항목(레시피 샘플)이 여러 개면 100g당 칼로리를 평균내어 하나로 합침
    const grouped = new Map();
    for (const r of rawResults) {
      if (!grouped.has(r.name)) {
        grouped.set(r.name, { name: r.name, category: r.category, kcalValues: [] });
      }
      if (r.kcalPer100g !== null) grouped.get(r.name).kcalValues.push(r.kcalPer100g);
    }

    const results = Array.from(grouped.values()).map((g) => ({
      name: g.name,
      kcal: g.kcalValues.length > 0
        ? Math.round(g.kcalValues.reduce((sum, v) => sum + v, 0) / g.kcalValues.length)
        : null,
      servingSize: '100g',
      category: g.category,
      sampleCount: g.kcalValues.length,
    }));

    // 칼로리 필드를 아직 못 찾은 경우를 대비해, 첫 번째 결과의 원본 필드를 함께 보내줌 (진단용)
    const responsePayload = { results };
    if (items.length > 0 && results[0] && results[0].kcal === null) {
      responsePayload.debugFirstItemRaw = items[0];
    }
    if (items.length === 0) {
      // 결과가 아예 없을 때: totalCount와 원본 응답 일부를 함께 보내 원인 파악을 돕는다
      responsePayload.debugTotalCount = data?.body?.totalCount ?? null;
      responsePayload.debugRawPreview = JSON.stringify(data).slice(0, 800);
    }

    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json(responsePayload);
  } catch (e) {
    res.status(500).json({ error: '서버 오류', message: e.message });
  }
}
