import { requestUrl } from "obsidian";
import { CachedHolidayEntry, CountryOption } from "../types";

// [ID 2.5] 해외 공휴일 온디맨드 동기화 (Nager.Date 무료 API + 로컬 캐싱)
// -> API 키 없이 전 세계 110개국 이상의 공휴일을 국가 선택 시 1회만 받아 data.json에 캐싱하고,
//    이후에는 완전 오프라인으로 동작하도록 설계함. (CORS 우회를 위해 옵시디언 공식 requestUrl 사용)

const NAGER_BASE_URL = "https://date.nager.at/api/v3";

/**
 * 오프라인 환경에서도 즉시 선택 가능한 주요 국가 프리셋 목록.
 * (사용자가 원하면 '전체 국가 목록 불러오기'로 110+개국 전체를 동적 로드 가능)
 */
export const CURATED_COUNTRIES: CountryOption[] = [
  { code: "KR", name: "대한민국 (South Korea · 내장 오프라인)" },
  { code: "NONE", name: "공휴일 표시 안 함 (None)" },
  { code: "US", name: "United States (US)" },
  { code: "JP", name: "Japan (JP)" },
  { code: "GB", name: "United Kingdom (GB)" },
  { code: "CA", name: "Canada (CA)" },
  { code: "AU", name: "Australia (AU)" },
  { code: "DE", name: "Germany (DE)" },
  { code: "FR", name: "France (FR)" },
  { code: "ES", name: "Spain (ES)" },
  { code: "IT", name: "Italy (IT)" },
  { code: "NL", name: "Netherlands (NL)" },
  { code: "CH", name: "Switzerland (CH)" },
  { code: "SE", name: "Sweden (SE)" },
  { code: "NO", name: "Norway (NO)" },
  { code: "PL", name: "Poland (PL)" },
  { code: "PT", name: "Portugal (PT)" },
  { code: "AT", name: "Austria (AT)" },
  { code: "BE", name: "Belgium (BE)" },
  { code: "NZ", name: "New Zealand (NZ)" },
  { code: "SG", name: "Singapore (SG)" },
  { code: "HK", name: "Hong Kong (HK)" },
  { code: "CN", name: "China (CN)" },
  { code: "VN", name: "Vietnam (VN)" },
  { code: "ID", name: "Indonesia (ID)" },
  { code: "PH", name: "Philippines (PH)" },
  { code: "BR", name: "Brazil (BR)" },
  { code: "MX", name: "Mexico (MX)" },
  { code: "AR", name: "Argentina (AR)" },
  { code: "TR", name: "Turkey (TR)" },
  { code: "ZA", name: "South Africa (ZA)" },
];

/**
 * Nager.Date PublicHolidays 응답 JSON을 경량 캐시 형식으로 정규화하는 순수 함수.
 */
export function parseNagerHolidayResponse(raw: unknown): CachedHolidayEntry[] {
  if (!Array.isArray(raw)) return [];

  const result: CachedHolidayEntry[] = [];
  const seen = new Set<string>();

  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const date = typeof rec.date === "string" ? rec.date.trim() : "";
    const name = typeof rec.name === "string" ? rec.name.trim() : "";
    const localName =
      typeof rec.localName === "string" ? rec.localName.trim() : name;

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || (!name && !localName)) continue;

    const dedupKey = `${date}::${localName || name}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    result.push({
      date,
      name: name || localName,
      localName: localName || name,
    });
  }

  return result;
}

/**
 * 특정 국가·연도의 공휴일을 Nager.Date API에서 1회 조회함.
 */
export async function fetchNagerHolidaysForYear(
  countryCode: string,
  year: number
): Promise<CachedHolidayEntry[]> {
  const url = `${NAGER_BASE_URL}/PublicHolidays/${year}/${encodeURIComponent(
    countryCode
  )}`;
  const res = await requestUrl({ url, method: "GET", throw: false });

  if (res.status === 204 || res.status === 404) {
    return [];
  }
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`HTTP ${res.status} while fetching ${countryCode}/${year}`);
  }
  return parseNagerHolidayResponse(res.json);
}

/**
 * Nager.Date에서 지원하는 전체 국가(110+개국) 목록을 조회함.
 */
export async function fetchNagerAvailableCountries(): Promise<CountryOption[]> {
  const res = await requestUrl({
    url: `${NAGER_BASE_URL}/AvailableCountries`,
    method: "GET",
    throw: false,
  });
  if (res.status < 200 || res.status >= 300 || !Array.isArray(res.json)) {
    throw new Error(`HTTP ${res.status} while fetching AvailableCountries`);
  }

  const fetched: CountryOption[] = [];
  for (const item of res.json as Array<Record<string, unknown>>) {
    const code = typeof item.countryCode === "string" ? item.countryCode : "";
    const name = typeof item.name === "string" ? item.name : "";
    if (!code || !name || code === "KR") continue;
    fetched.push({ code, name: `${name} (${code})` });
  }

  fetched.sort((a, b) => a.name.localeCompare(b.name));

  return [
    CURATED_COUNTRIES[0], // KR (내장 오프라인)
    CURATED_COUNTRIES[1], // NONE
    ...fetched,
  ];
}

