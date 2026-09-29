export type Lang = "en" | "zh-TW";

// Each language's name, written in that language.
export const LANGS: Record<Lang, string> = { en: "English", "zh-TW": "繁體中文" };

const en = {
  lintPanel: "Lint panel",
  runLint: "Run lint",
  clear: "Clear",
  clearHighlights: "Clear highlights",
  settings: "Settings",
  togglePanel: "Toggle lint panel",
  close: "Close",

  needKeyAndRule: "Set API key and at least one lint rule first",
  runFailed: (failed: number, total: number, message: string) => `Jev error (${failed}/${total} rules): ${message}`,
  runDone: (checked: number, rules: number) => `Jev: ${checked} new sentence check(s) across ${rules} rule(s)`,
  runError: (message: string) => `Jev error: ${message}`,

  emptyRule: "(empty rule)",
  ruleColor: "Rule color",
  ruleName: "Rule name",
  untitledRule: "Untitled rule",
  deleteRule: "Delete rule",
  condition: "Condition",
  conditionPlaceholder: "e.g. The sentence makes a claim without evidence",
  threshold: "Threshold",

  sentenceDetails: "Sentence details",
  violations: "Violations",
  rules: "Rules",
  usage: "Usage",
  judgedBy: (model: string, percent: number) => `judged by ${model} · flags at ${percent}%`,
  cardHint: "alt + ↑/↓ steps through marks · esc closes",
  noLintRules: "No lint rules",
  noRulesYet: "No rules yet",
  jumpToNext: "Jump to next violation",
  addRule: "+ Add rule",
  session: "Session",
  total: "Total",
  inputTokens: "Input tokens",
  outputTokens: "Output tokens",
  cost: "Cost",
  resetTotal: "Reset total",

  words: "words",
  sentences: "sentences",
  minutes: "min",

  language: "Language",
  apiKey: "TypeSafe API key",
  apiKeyDesc: "Stored in this browser's localStorage.",
  endpoint: "API endpoint",
  endpointDesc: "The default goes through the Vite dev/preview proxy, since the API doesn't allow browser origins.",
  model: "Model",
  price: "Price per 1M input tokens (USD)",
  priceDesc: "Used to estimate cost in the usage section. Output tokens are free.",
  abbreviations: "Abbreviations",
  abbreviationsDesc:
    "A period right after these doesn't end a sentence. Separate with spaces; case-sensitive, include the period.",
};

const zhTW: typeof en = {
  lintPanel: "檢查面板",
  runLint: "執行檢查",
  clear: "清除",
  clearHighlights: "清除標記",
  settings: "設定",
  togglePanel: "開關檢查面板",
  close: "關閉",

  needKeyAndRule: "請先設定 API 金鑰，並至少建立一條檢查規則",
  runFailed: (failed, total, message) => `Jev 錯誤（${failed}/${total} 條規則）：${message}`,
  runDone: (checked, rules) => `Jev：以 ${rules} 條規則檢查了 ${checked} 個新句子`,
  runError: (message) => `Jev 錯誤：${message}`,

  emptyRule: "（空白規則）",
  ruleColor: "規則顏色",
  ruleName: "規則名稱",
  untitledRule: "未命名規則",
  deleteRule: "刪除規則",
  condition: "條件",
  conditionPlaceholder: "例如：句子提出主張卻沒有佐證",
  threshold: "門檻",

  sentenceDetails: "句子詳情",
  violations: "違規",
  rules: "規則",
  usage: "用量",
  judgedBy: (model, percent) => `由 ${model} 判定 · 達 ${percent}% 即標記`,
  cardHint: "alt + ↑/↓ 切換標記 · esc 關閉",
  noLintRules: "沒有檢查規則",
  noRulesYet: "還沒有規則",
  jumpToNext: "跳到下一個違規",
  addRule: "+ 新增規則",
  session: "本次",
  total: "累計",
  inputTokens: "輸入 token",
  outputTokens: "輸出 token",
  cost: "費用",
  resetTotal: "重設累計",

  words: "字",
  sentences: "句",
  minutes: "分鐘",

  language: "語言",
  apiKey: "TypeSafe API 金鑰",
  apiKeyDesc: "儲存在這個瀏覽器的 localStorage。",
  endpoint: "API 端點",
  endpointDesc: "API 不接受瀏覽器來源的請求，所以預設經由 Vite 的 dev/preview proxy 轉送。",
  model: "模型",
  price: "每 100 萬輸入 token 的價格（美元）",
  priceDesc: "用來估算用量區塊裡的費用。輸出 token 不收費。",
  abbreviations: "縮寫",
  abbreviationsDesc: "緊接在這些縮寫後的句點不算句子結尾。以空白分隔；區分大小寫，須包含句點。",
};

const STRINGS: Record<Lang, typeof en> = { en, "zh-TW": zhTW };

export let lang: Lang = "en";
export let t = en;

export function setLang(l: Lang) {
  lang = l;
  t = STRINGS[l];
  document.documentElement.lang = l === "zh-TW" ? "zh-Hant" : "en";
}

export const isLang = (v: unknown): v is Lang => typeof v === "string" && Object.keys(LANGS).includes(v);

export const detectLang = (): Lang => (navigator.language.toLowerCase().startsWith("zh") ? "zh-TW" : "en");
