/**
 * Deterministic guards that decide whether a model-proposed claim is really
 * something the user said.
 *
 * The epistemic boundary this milestone exists to hold cannot be delegated to a
 * prompt. These functions are pure, unit-tested, and run on every candidate:
 *
 *   1. the excerpt must be literally present in the user's message
 *   2. the sentence containing it must carry an explicit first-person stance
 *      marker — the user speaking about their own thinking
 *   3. that sentence must not be reporting someone else's view
 *
 * Guard 3 is what stops "I read a paper arguing that retrieval practice
 * improves memory" from becoming "the user believes retrieval practice improves
 * memory". Guard 2 stops a bare fact ("Transformers are used in ChatGPT") from
 * becoming a belief.
 *
 * Both guards are conservative on purpose. Missing a real claim costs nothing
 * permanent; inventing one corrupts the record of how this person thinks.
 */

/**
 * Explicit first-person stance markers. A claim is only accepted when the user
 * is visibly speaking for themselves; "I" alone is not enough, because "I read
 * that X" is also first person.
 */
const STANCE_MARKERS: RegExp[] = [
  /\bi\s+(think|believe|feel|reckon|hold|maintain|argue|suspect|doubt|disagree|agree)\b/,
  /\bi'?m\s+(interested|curious|convinced|skeptical|sceptical|trying|working|planning|hoping|learning|building)\b/,
  /\bi\s+(want|need|plan|intend|hope|aim|prefer|like|love|care|wonder|struggle)\b/,
  /\bi'?ve\s+(come to|always|never|been)\b/,
  /\bi'?d\s+(like|prefer|rather)\b/,
  /\bmy\s+(goal|view|position|take|opinion|belief|hunch|plan|intent|intention|sense)\b/,
  /\bin\s+my\s+(view|opinion|experience|mind)\b/,
  /\bi\s+am\s+(interested|curious|convinced|skeptical|sceptical|trying|working|planning)\b/,
  // Explicit self-description: "I'm a researcher", "I am new to this".
  /\bi'?m\s+(a|an|the|new|not|still|fairly|quite|very|pretty)\b/,
  /\bi\s+am\s+(a|an|the|new|not|still|fairly|quite|very|pretty)\b/,
];

/**
 * Markers that the sentence is relaying someone else's position. Their presence
 * disqualifies the sentence even when a stance marker is also present, because
 * disentangling "I read X and agree" from "I read X" is exactly the judgement
 * this layer must not make on the user's behalf.
 */
const REPORTED_SPEECH_MARKERS: RegExp[] = [
  /\bi\s+(read|saw|heard|watched|found|encountered|came across|skimmed)\b/,
  /\baccording to\b/,
  /\bthe\s+(paper|article|author|study|book|post|talk|video|docs?|documentation)\b/,
  /\bthey\s+(say|said|argue|argued|claim|claimed|found)\b/,
  /\b(argues?|argued|claims?|claimed|suggests?|suggested|states?|reports?|posits?)\s+that\b/,
  /\bit\s+(says|said)\b/,
  /\bciting\b/,
];

/** Splits on sentence terminators and newlines, keeping each piece's offset. */
export function sentenceSpans(text: string): Array<{ start: number; end: number; text: string }> {
  const spans: Array<{ start: number; end: number; text: string }> = [];
  const pattern = /[^.!?\n]+[.!?]*\n*|\n+/g;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    const raw = match[0];
    if (raw.trim().length === 0) continue;
    spans.push({ start, end: start + raw.length, text: raw });
  }
  return spans.length > 0 ? spans : [{ start: 0, end: text.length, text }];
}

/** The sentence containing a span, used as the window both guards inspect. */
export function containingSentence(text: string, charStart: number, charEnd: number): string {
  const spans = sentenceSpans(text);
  const covering = spans.filter((span) => span.start < charEnd && span.end > charStart);
  return covering.length > 0 ? covering.map((span) => span.text).join(" ") : text;
}

export function hasStanceMarker(sentence: string): boolean {
  const normalized = sentence.toLowerCase();
  return STANCE_MARKERS.some((pattern) => pattern.test(normalized));
}

export function hasReportedSpeechMarker(sentence: string): boolean {
  const normalized = sentence.toLowerCase();
  return REPORTED_SPEECH_MARKERS.some((pattern) => pattern.test(normalized));
}

/**
 * Locates the excerpt in the message.
 *
 * Case-insensitive so a model that reformats capitalisation still resolves, but
 * the returned span always indexes the message's own characters — the stored
 * excerpt is sliced from the source, never taken from the model.
 */
export function locateExcerpt(
  content: string,
  excerpt: string,
): { charStart: number; charEnd: number } | null {
  const needle = excerpt.trim();
  if (!needle) return null;
  const charStart = content.toLowerCase().indexOf(needle.toLowerCase());
  if (charStart === -1) return null;
  const charEnd = charStart + needle.length;
  if (charEnd > content.length) return null;
  return { charStart, charEnd };
}
