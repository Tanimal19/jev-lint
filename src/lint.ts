import { EditorSelection, RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, LayerMarker, RectangleMarker, layer } from "@codemirror/view";
import { h } from "./dom";
import { t } from "./i18n";

export interface Rule {
  id: string;
  name: string;
  condition: string;
  color: string;
  threshold: number;
}
export interface Settings {
  apiKey: string;
  endpoint: string;
  model: string;
  pricePerMTok: number;
  // A period right after one of these doesn't end a sentence.
  abbreviations: string[];
  rules: Rule[];
}
export const DEFAULTS: Omit<Settings, "rules"> = {
  apiKey: "",
  endpoint: "/jev/v1/systemone",
  model: "jev-latest",
  pricePerMTok: 0.042,
  abbreviations: ["Mr.", "Mrs.", "Ms.", "Dr.", "Prof.", "Sr.", "Jr.", "St.", "Mt.", "Rev.", "Gen.", "Capt.", "Lt.",
    "vs.", "e.g.", "i.e.", "cf."],
};
const DEFAULT_THRESHOLD = 0.7;
// Ink colors of a marking pen.
const PALETTE = ["#c8474e", "#d6863a", "#4a74c9", "#4f9a5b", "#8a5fc0", "#2e9c8f"];

export function newRule(existing: Rule[]): Rule {
  const used = new Set(existing.map((r) => r.color.toLowerCase()));
  const color = PALETTE.find((c) => !used.has(c)) ?? PALETTE[existing.length % PALETTE.length];
  return { id: crypto.randomUUID(), name: "", condition: "", color, threshold: DEFAULT_THRESHOLD };
}

// Rules of a fresh install.
const DEFAULT_RULES: [name: string, condition: string][] = [
  ["hedging", "Uses unnecessary hedging or qualifiers (e.g. \"maybe\", \"seems\", \"to some extent\") that weaken the claim"],
  ["ai-sounding", "Reads like AI-generated text: generic, formulaic, grandiose, or full of common AI clichés"],
  ["complicated", "Is too long or too convoluted, and could be split up or rewritten more simply"],
  ["grammar", "Has a grammar, spelling, or punctuation error"],
  ["wordy", "Contains redundant words that could be cut without changing the meaning"],
  ["vague", "Uses vague or unspecific wording, leaving the reader unsure what exactly is meant"],
];

// Default rules whose names aren't among `existing`, colored to avoid the colors already in use.
export function missingDefaultRules(existing: Rule[]): Rule[] {
  const names = new Set(existing.map((r) => r.name));
  return DEFAULT_RULES.filter(([name]) => !names.has(name)).reduce<Rule[]>(
    (added, [name, condition]) => [...added, { ...newRule([...existing, ...added]), name, condition }], []);
}

export const defaultRules = () => missingDefaultRules([]);

export const ruleLabel = (r: Rule) => r.name || r.condition || t.emptyRule;

export type Sentence = { from: number; to: number; text: string };
export type Violation = { rule: Rule; p: number };
export type Hit = { from: number; to: number; violations: Violation[] };
// count is null while the rule hasn't been checked yet.
export type Tally = { rule: Rule; count: number | null };

export type Usage = { inputTokens: number; outputTokens: number; cost: number };
export const emptyUsage = (): Usage => ({ inputTokens: 0, outputTokens: 0, cost: 0 });
export type ApiUsage = { input_tokens: number; output_tokens: number };

const BATCH = 40;

// ---------- CodeMirror highlight ----------
// A slightly irregular wave tile, so the repeated underline reads as hand-drawn rather than mechanical.
const WAVE_W = 24;
const WAVE_H = 5;
// Each further rule's wave is nudged right (out of phase) and down so overlapping waves stay distinguishable.
const WAVE_SHIFT_X = 5;
const WAVE_SHIFT_Y = 1;
const wave = (color: string) =>
  `url("data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' width='${WAVE_W}' height='${WAVE_H}' viewBox='0 0 ${WAVE_W} ${WAVE_H}'>` +
    `<path d='M0 2.5 C2 0.8 4.5 0.6 6.5 2.3 S10.5 4.6 13 2.9 S17.5 0.3 20 2.2 S23 3.6 24 2.5' ` +
    `fill='none' stroke='${color}' stroke-width='1.3' stroke-linecap='round'/></svg>`
  )}")`;

// One wavy underline per violated rule, overlapping under the text. Inline bottom padding extends the background
// area under the text without changing line height.
function squiggles(colors: string[]): string {
  const n = colors.length;
  return [
    `background-image: ${colors.map(wave).join(", ")}`,
    `background-position: ${colors.map((_, i) =>
      `${i * WAVE_SHIFT_X}px calc(100% - ${(n - 1 - i) * WAVE_SHIFT_Y}px)`).join(", ")}`,
    `background-size: ${WAVE_W}px ${WAVE_H}px`,
    "background-repeat: repeat-x",
    `padding-bottom: ${(n - 1) * WAVE_SHIFT_Y + WAVE_H - 2}px`,
  ].join("; ");
}

export const setHits = StateEffect.define<Hit[]>();
export const clearHits = StateEffect.define<null>();

export const hitField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(clearHits)) deco = Decoration.none;
      if (e.is(setHits)) {
        const b = new RangeSetBuilder<Decoration>();
        for (const h of [...e.value].sort((a, b) => a.from - b.from)) {
          b.add(h.from, h.to, Decoration.mark({
            class: "jev-hit",
            attributes: { style: squiggles(h.violations.map((v) => v.rule.color)) },
            violations: h.violations,
          }));
        }
        deco = b.finish();
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// Start of the highlighted sentence under the mouse, or null.
const setHover = StateEffect.define<number | null>();

const hoverField = StateField.define<number | null>({
  create: () => null,
  update(pos, tr) {
    if (pos !== null) pos = tr.changes.mapPos(pos);
    for (const e of tr.effects) {
      if (e.is(setHover)) pos = e.value;
      if (e.is(setHits) || e.is(clearHits)) pos = null;
    }
    return pos;
  },
});

function hoverTo(view: EditorView, pos: number | null) {
  if (view.state.field(hoverField) !== pos) view.dispatch({ effects: setHover.of(pos) });
}

// Start of any sentence under the mouse, highlighted or not, or null.
const setHoverSentence = StateEffect.define<number | null>();

const hoverSentenceField = StateField.define<number | null>({
  create: () => null,
  update(pos, tr) {
    if (pos !== null) pos = tr.changes.mapPos(pos);
    for (const e of tr.effects) if (e.is(setHoverSentence)) pos = e.value;
    return pos;
  },
});

function hoverSentenceTo(view: EditorView, pos: number | null) {
  if (view.state.field(hoverSentenceField) !== pos) view.dispatch({ effects: setHoverSentence.of(pos) });
}

// Start of the sentence whose text is under the point. Blank space past a line's end or in the padding is outside
// every sentence, even though posAtCoords snaps it to the nearest position.
function sentenceStartAt(view: EditorView, x: number, y: number): number | null {
  const { pos, assoc } = view.posAndSideAtCoords({ x, y }, false);
  const char = assoc > 0 ? pos : pos - 1;
  const s = view.state.field(sentenceField).list.find((s) => s.from <= char && char < s.to);
  if (!s) return null;
  const box = view.coordsAtPos(char, 1);
  if (!box || x < box.left || x > box.right || y < box.top || y > box.bottom) return null;
  return s.from;
}

// Start of the highlighted sentence whose details card is open, or null.
const setActive = StateEffect.define<number | null>();

export const activeField = StateField.define<number | null>({
  create: () => null,
  update(pos, tr) {
    if (pos !== null) pos = tr.changes.mapPos(pos);
    for (const e of tr.effects) {
      if (e.is(setActive)) pos = e.value;
      if (e.is(clearHits)) pos = null;
      // A re-run keeps the card open as long as the sentence is still highlighted.
      if (e.is(setHits) && !e.value.some((h) => h.from === pos)) pos = null;
    }
    return pos;
  },
});

export function activate(view: EditorView, pos: number | null) {
  if (view.state.field(activeField) !== pos) view.dispatch({ effects: setActive.of(pos) });
}

export const closeActive = (view: EditorView) => {
  if (view.state.field(activeField) === null) return false;
  activate(view, null);
  return true;
};

// Moves the open card to the next (dir 1) or previous (dir -1) highlighted sentence, wrapping around.
export function stepActive(view: EditorView, dir: 1 | -1): boolean {
  const current = view.state.field(activeField);
  if (current === null) return false;
  const starts: number[] = [];
  view.state.field(hitField).between(0, view.state.doc.length, (from) => { starts.push(from); });
  if (!starts.length) return false;
  const i = starts.indexOf(current);
  const next = i < 0 ? starts[dir > 0 ? 0 : starts.length - 1] : starts[(i + dir + starts.length) % starts.length];
  view.dispatch({ effects: [setActive.of(next), EditorView.scrollIntoView(next, { y: "nearest", yMargin: 80 })] });
  return true;
}

// The highlighted sentence under `target`: either its margin labels, or its text. A sentence's mark may be split
// into several spans by other decorations; any of them identifies it.
function hitStartAt(view: EditorView, target: EventTarget | null): number | null {
  const row = (target as HTMLElement).closest?.<HTMLElement>(".jev-margin-row");
  if (row) return Number(row.dataset.start);
  const span = (target as HTMLElement).closest?.(".jev-hit");
  if (!span) return null;
  const pos = view.posAtDOM(span);
  let start: number | null = null;
  view.state.field(hitField).between(pos, pos, (from, to) => {
    if (from <= pos && pos < to) start = from;
  });
  return start;
}

const hoverTracker = EditorView.domEventHandlers({
  mousemove(e, view) {
    const hit = hitStartAt(view, e.target);
    hoverTo(view, hit);
    hoverSentenceTo(view, hit ?? sentenceStartAt(view, e.clientX, e.clientY));
  },
  mouseleave(_e, view) {
    hoverTo(view, null);
    hoverSentenceTo(view, null);
  },
  click(e, view) {
    const start = hitStartAt(view, e.target);
    if (start !== null) activate(view, start);
  },
});

// ---------- Margin labels ----------
// One label column per sentence, starting at the height of the sentence's first line. The row spans from the
// content's left edge to the scroller's right edge; a shrinkable spacer as wide as the content pushes the labels
// into the right margin, and gives way (so labels overlap the text, right-aligned) when the margin is too narrow.
const MAX_LABELS = 3;
// Exclamation marks after a label, by how sure Jev is.
const emphasis = (p: number) => (p >= 0.95 ? "!!" : p >= 0.85 ? "!" : "");

// A pen stroke from the end of the sentence's first line to its labels.
const LEADER = `<svg viewBox="0 0 100 8" preserveAspectRatio="none"><path d="M0 5 C 25 2.5, 60 6.5, 100 3.5" `
  + `fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" vector-effect="non-scaling-stroke"/></svg>`;

class MarginRow implements LayerMarker {
  readonly key: string;
  // `leaderStart` is where the first line's text ends, relative to `left`. `start` is the sentence's document
  // position, which lets hovering the labels count as hovering the sentence.
  constructor(
    readonly left: number, readonly top: number, readonly width: number, readonly lineHeight: number,
    readonly spacer: number, readonly leaderStart: number, readonly violations: Violation[], readonly start: number,
    readonly dim: boolean, readonly expanded: boolean
  ) {
    this.key = violations.map((v) => `${v.rule.color}|${ruleLabel(v.rule)}|${v.p}`).join("\n");
  }
  sameLayout(o: LayerMarker): o is MarginRow {
    return o instanceof MarginRow && o.left === this.left && o.top === this.top && o.width === this.width
      && o.lineHeight === this.lineHeight && o.spacer === this.spacer && o.leaderStart === this.leaderStart
      && o.key === this.key;
  }
  eq(o: LayerMarker): boolean {
    return this.sameLayout(o) && o.start === this.start && o.dim === this.dim && o.expanded === this.expanded;
  }
  // Toggle state in place so the transitions can run.
  update(dom: HTMLElement, old: LayerMarker): boolean {
    if (!this.sameLayout(old)) return false;
    this.applyState(dom);
    return true;
  }
  private applyState(dom: HTMLElement) {
    dom.dataset.start = String(this.start);
    dom.classList.toggle("is-dimmed", this.dim);
    dom.classList.toggle("is-expanded", this.expanded);
  }
  draw() {
    const dom = h(null, "div", { cls: "jev-margin-row" });
    Object.assign(dom.style, { left: `${this.left}px`, top: `${this.top}px`, width: `${this.width}px` });
    dom.style.setProperty("--jev-line-height", `${this.lineHeight}px`);
    this.applyState(dom);
    const spacer = h(dom, "div", { cls: "jev-margin-spacer" });
    spacer.style.flexBasis = `${this.spacer}px`;
    const sorted = [...this.violations].sort((a, b) => b.p - a.p);
    // Once the spacer has shrunk past the end of the line, the leader collapses to nothing.
    const leader = h(spacer, "div", { cls: "jev-margin-leader" });
    leader.style.left = `${this.leaderStart}px`;
    leader.style.color = sorted[0].rule.color;
    leader.innerHTML = LEADER;
    const labels = h(dom, "div", { cls: "jev-margin-labels" });
    // Labels past MAX_LABELS are only shown while the row is expanded; until then the last shown one counts them.
    sorted.forEach((v, i) => {
      const label = h(labels, "div", { cls: i < MAX_LABELS ? "jev-margin-label" : "jev-margin-label is-extra" });
      label.style.color = v.rule.color;
      h(label, "span", { text: ruleLabel(v.rule) + emphasis(v.p) });
      if (i === MAX_LABELS - 1 && sorted.length > MAX_LABELS) {
        h(label, "span", { cls: "jev-margin-more", text: `+${sorted.length - MAX_LABELS}` });
      }
    });
    return dom;
  }
}

const marginLabels = layer({
  above: true,
  class: "jev-margin-layer",
  update: (u) => u.docChanged || u.viewportChanged
    || u.startState.field(hitField) !== u.state.field(hitField)
    || u.startState.field(hoverField) !== u.state.field(hoverField)
    || u.startState.field(activeField) !== u.state.field(activeField),
  markers(view) {
    const { scaleX: sx, scaleY: sy, scrollDOM } = view;
    const scroller = scrollDOM.getBoundingClientRect();
    const baseLeft = scroller.left - scrollDOM.scrollLeft * sx;
    const baseTop = scroller.top - scrollDOM.scrollTop * sy;
    const content = view.contentDOM.getBoundingClientRect();
    const left = (content.left - baseLeft) / sx;
    const width = (scroller.left + scrollDOM.clientWidth * sx - content.left) / sx;
    const spacer = content.width / sx;
    const focused = view.state.field(hoverField) ?? view.state.field(activeField);

    const rows: MarginRow[] = [];
    const { from, to } = view.viewport;
    view.state.field(hitField).between(from, to, (start, _end, deco) => {
      if (start < from) return;
      const c = view.coordsAtPos(start, 1);
      if (!c) return;
      const lineEnd = view.moveToLineBoundary(EditorSelection.cursor(start), true).head;
      const endX = view.coordsAtPos(lineEnd, -1)?.right ?? c.right;
      rows.push(new MarginRow(
        left, (c.top - baseTop) / sy, width, (c.bottom - c.top) / sy, spacer, (endX - content.left) / sx,
        deco.spec.violations, start, focused !== null && focused !== start, focused === start,
      ));
    });
    return rows;
  },
});

// ---------- Sentence boxes ----------
// The document's sentences, re-split on every change so their boxes and ids follow the text as it's typed.
export const setAbbreviations = StateEffect.define<string[]>();

type Sentences = { abbreviations: string[]; list: Sentence[] };

export const sentenceField = StateField.define<Sentences>({
  create: () => ({ abbreviations: [], list: [] }),
  update(value, tr) {
    let { abbreviations } = value;
    for (const e of tr.effects) if (e.is(setAbbreviations)) abbreviations = e.value;
    if (!tr.docChanged && abbreviations === value.abbreviations) return value;
    return { abbreviations, list: splitSentences(tr.newDoc.toString(), abbreviations) };
  },
});

// A sentence id above the sentence.
class TagMarker implements LayerMarker {
  constructor(readonly cls: string, readonly text: string, readonly left: number, readonly top: number) {}
  eq(o: LayerMarker): boolean {
    return o instanceof TagMarker && o.cls === this.cls && o.text === this.text && o.left === this.left
      && o.top === this.top;
  }
  draw() {
    const dom = h(null, "div", { cls: this.cls, text: this.text });
    Object.assign(dom.style, { left: `${this.left}px`, top: `${this.top}px` });
    return dom;
  }
}

const sentenceBoxes = layer({
  above: false,
  class: "jev-sentence-layer",
  update: (u) => u.docChanged || u.viewportChanged
    || u.startState.field(sentenceField) !== u.state.field(sentenceField)
    || u.startState.field(activeField) !== u.state.field(activeField)
    || u.startState.field(hoverSentenceField) !== u.state.field(hoverSentenceField),
  markers(view) {
    const { from, to } = view.viewport;
    const active = view.state.field(activeField);
    const hovered = view.state.field(hoverSentenceField);
    const markers: LayerMarker[] = [];
    view.state.field(sentenceField).list.forEach((s, i) => {
      if (s.to <= from || s.from >= to) return;
      const state = s.from === active ? " is-active" : s.from === hovered ? " is-hover" : "";
      const rects = RectangleMarker.forRange(view, `jev-sentence-box${state}`, EditorSelection.range(s.from, s.to));
      if (!rects.length) return;
      const tagCls = s.from === hovered ? "jev-sentence-tag is-hover" : "jev-sentence-tag";
      markers.push(...rects, new TagMarker(tagCls, `s${i}`, rects[0].left, rects[0].top));
    });
    return markers;
  },
});

export const lintExtensions = (abbreviations: string[]) => [
  sentenceField.init((state) => ({ abbreviations, list: splitSentences(state.doc.toString(), abbreviations) })),
  hitField, hoverField, hoverSentenceField, activeField, hoverTracker, sentenceBoxes, marginLabels,
];

// ---------- Sentence splitting ----------
const segmenter = new Intl.Segmenter(undefined, { granularity: "sentence" });

// Lines are split into sentences by Intl.Segmenter, which also breaks after abbreviations followed by a capital
// ("Prof. Smith"). A segment ending in a listed abbreviation or a single-letter initial ("J.") is therefore
// joined with the next one.
export function splitSentences(text: string, abbreviations: string[]): Sentence[] {
  const skip: [number, number][] = [];
  const fm = text.match(/^---\n[\s\S]*?\n---\n/);
  if (fm) skip.push([0, fm[0].length]);
  for (const m of text.matchAll(/```[\s\S]*?```/g)) skip.push([m.index!, m.index! + m[0].length]);
  const inSkip = (pos: number) => skip.some(([a, b]) => pos >= a && pos < b);

  const abbr = new Set(abbreviations);
  const endsWithAbbr = (segment: string) => {
    const word = segment.trimEnd().split(/\s/).pop()!.replace(/^[^\p{L}]+/u, "");
    return abbr.has(word) || /^\p{Lu}\.$/u.test(word);
  };

  const out: Sentence[] = [];
  const push = (start: number, end: number) => {
    const raw = text.slice(start, end);
    const lead = raw.length - raw.trimStart().length;
    const s = raw.trim();
    const from = start + lead;
    if (s.length > 1 && !inSkip(from)) out.push({ from, to: from + s.length, text: s });
  };

  let lineStart = 0;
  for (const line of text.split("\n")) {
    let start = lineStart;
    for (const { segment, index } of segmenter.segment(line)) {
      if (endsWithAbbr(segment)) continue;
      const end = lineStart + index + segment.length;
      push(start, end);
      start = end;
    }
    push(start, lineStart + line.length);
    lineStart += line.length + 1;
  }
  return out;
}

// ---------- Jev call ----------
// Returns P(yes) for each given sentence text.
export async function evaluate(
  s: Settings, condition: string, doc: string, texts: string[], onUsage: (u: ApiUsage) => void
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const batches: Promise<void>[] = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    const chunk = texts.slice(i, i + BATCH);
    const questions: Record<string, unknown> = {};
    chunk.forEach((text, j) => {
      questions[`s${j}`] = {
        type: "noul",
        instructions: {
          sentence: text,
          condition,
          question: "Does `sentence` satisfy `condition`? Use `document` only as context.",
        },
      };
    });

    batches.push(
      fetch(s.endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${s.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: s.model, state: { document: doc }, questions }),
      }).then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
        const json = await res.json();
        onUsage(json.usage);
        for (const [k, a] of Object.entries<any>(json.answers)) {
          out.set(chunk[Number(k.slice(1))], a.noul);
        }
      })
    );
  }
  await Promise.all(batches);
  return out;
}
