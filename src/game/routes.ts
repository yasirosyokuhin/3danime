export interface Landmark {
  name: string;
  lon: number;
  lat: number;
  /** 実際の標高[m]。表示とマーカー配置の目安（実際の高さは DEM から取る） */
  elevation: number;
  kind: 'hut' | 'peak' | 'crater' | 'start';
}

export interface Route {
  id: string;
  name: string;
  subtitle: string;
  /** 出発地点 */
  start: { lon: number; lat: number };
  /** 山頂（ゴール） */
  goal: { lon: number; lat: number; elevation: number; name: string };
  /** ゴール判定の半径[m] */
  goalRadius: number;
  difficulty: 1 | 2 | 3 | 4;
  description: string;
  landmarks: Landmark[];
}

export interface Mountain {
  id: string;
  name: string;
  /** 地形読み込みの中心 */
  center: { lon: number; lat: number };
  /** 中心から東西南北に何 m 読み込むか */
  radiusMeters: number;
  /** 標高タイルのズーム（大きいほど精細） */
  zoom: number;
  /** 自動判定時の妥当性チェックに使う想定標高レンジ */
  expectedElevation: { min: number; max: number };
  /** 見た目のパラメータ */
  treeLine: number;
  snowLine: number;
  routes: Route[];
}

const KENGAMINE = {
  lon: 138.72743,
  lat: 35.36055,
  elevation: 3776,
  name: '剣ヶ峰',
};

export const FUJI: Mountain = {
  id: 'fuji',
  name: '富士山',
  center: { lon: 138.7274, lat: 35.3606 },
  radiusMeters: 7000,
  zoom: 14,
  expectedElevation: { min: 300, max: 3800 },
  treeLine: 2400,
  snowLine: 3350,
  routes: [
    {
      id: 'fujinomiya',
      name: '富士宮ルート',
      subtitle: '南面・最短距離',
      start: { lon: 138.7365, lat: 35.3356 },
      goal: { ...KENGAMINE },
      goalRadius: 60,
      difficulty: 2,
      description:
        '五合目の標高が最も高く、山頂までの距離が最短。そのぶん平均斜度はきつい。剣ヶ峰に直接出られる唯一のルート。',
      landmarks: [
        { name: '富士宮口五合目', lon: 138.7365, lat: 35.3356, elevation: 2380, kind: 'start' },
        { name: '新六合目', lon: 138.7345, lat: 35.3387, elevation: 2490, kind: 'hut' },
        { name: '元祖七合目', lon: 138.7318, lat: 35.3454, elevation: 3010, kind: 'hut' },
        { name: '八合目', lon: 138.7306, lat: 35.3489, elevation: 3250, kind: 'hut' },
        { name: '九合五勺', lon: 138.7295, lat: 35.3546, elevation: 3590, kind: 'hut' },
        { ...KENGAMINE, kind: 'peak' },
      ],
    },
    {
      id: 'yoshida',
      name: '吉田ルート',
      subtitle: '北面・最も一般的',
      start: { lon: 138.7332, lat: 35.3939 },
      goal: { ...KENGAMINE },
      goalRadius: 60,
      difficulty: 1,
      description:
        '山小屋が最も多く、傾斜も比較的緩やか。距離は長いが登りやすい。山頂火口を半周して剣ヶ峰へ。',
      landmarks: [
        { name: 'スバルライン五合目', lon: 138.7332, lat: 35.3939, elevation: 2305, kind: 'start' },
        { name: '六合目', lon: 138.7355, lat: 35.3877, elevation: 2390, kind: 'hut' },
        { name: '七合目', lon: 138.7385, lat: 35.3806, elevation: 2700, kind: 'hut' },
        { name: '本八合目', lon: 138.7350, lat: 35.3705, elevation: 3400, kind: 'hut' },
        { name: '久須志岳', lon: 138.7318, lat: 35.3660, elevation: 3715, kind: 'peak' },
        { ...KENGAMINE, kind: 'peak' },
      ],
    },
    {
      id: 'gotemba',
      name: '御殿場ルート',
      subtitle: '東面・標高差2300m',
      start: { lon: 138.7818, lat: 35.3308 },
      goal: { ...KENGAMINE },
      goalRadius: 60,
      difficulty: 3,
      description:
        '新五合目が標高1440mと低く、山頂までの標高差は2300m超。山小屋も少なく、延々と続く砂礫の斜面を登る消耗戦。',
      landmarks: [
        { name: '御殿場口新五合目', lon: 138.7818, lat: 35.3308, elevation: 1440, kind: 'start' },
        { name: '次郎坊', lon: 138.7745, lat: 35.3369, elevation: 1920, kind: 'hut' },
        { name: '七合目', lon: 138.7530, lat: 35.3488, elevation: 3030, kind: 'hut' },
        { name: '赤岩八合館', lon: 138.7462, lat: 35.3533, elevation: 3290, kind: 'hut' },
        { name: '銀明水', lon: 138.7350, lat: 35.3585, elevation: 3700, kind: 'hut' },
        { ...KENGAMINE, kind: 'peak' },
      ],
    },
    {
      id: 'osawa',
      name: '大沢崩れ 直登',
      subtitle: '西面・登山道なし',
      start: { lon: 138.6890, lat: 35.3560 },
      goal: { ...KENGAMINE },
      goalRadius: 60,
      difficulty: 4,
      description:
        '日本最大級の侵食谷を正面から詰める非公式ルート。逃げ場のない急斜面と崩落地形が延々と続く。ハーケンなしでは登り切れない。',
      landmarks: [
        { name: '大沢崩れ 取付', lon: 138.6890, lat: 35.3560, elevation: 2150, kind: 'start' },
        { name: '大沢崩れ 源頭', lon: 138.7080, lat: 35.3580, elevation: 3100, kind: 'crater' },
        { name: '白山岳', lon: 138.7238, lat: 35.3665, elevation: 3756, kind: 'peak' },
        { ...KENGAMINE, kind: 'peak' },
      ],
    },
  ],
};

export const MOUNTAINS: Mountain[] = [FUJI];

export function difficultyLabel(d: number): string {
  return ['', '初級', '中級', '上級', 'エキスパート'][d] ?? '';
}
