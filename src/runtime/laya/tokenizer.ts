import { readFileSync } from 'node:fs';

// Laya System-1 runtime tokenizer — M7 L3.
//
// The checkpoint tokenizer is SentencePiece-style BPE (model.type "BPE") with a
// Replace normalizer (space -> "▁"), a Metaspace pre-tokenizer (prepend "▁",
// split on "▁"), 256k vocab / 580k merges, and byte-fallback. This is NOT
// WordPiece; implementing it here keeps the bridge dependency-free while the
// golden-vector test (tokenizer_golden.json, emitted by the authoritative
// Python `tokenizers` lib) proves byte-for-byte parity.
export interface LayaTokenizer {
  encode(text: string, maxLength: number): { inputIds: number[]; attentionMask: number[] };
}

export interface TokenizerJson {
  model: {
    type: string;
    vocab: Record<string, number>;
    merges: Array<string[] | string>;
    byte_fallback?: boolean;
    unk_token?: string;
  };
  normalizer?: { type?: string; pattern?: { String?: string }; content?: string };
  pre_tokenizer?: { type?: string; replacement?: string; prepend_scheme?: string; split?: boolean };
  added_tokens?: Array<{ id: number; content: string; special: boolean }>;
  post_processor?: {
    special_tokens?: Record<string, { ids?: number[] }>;
  };
}

const REPLACEMENT = '▁';

export class LayaBpeTokenizer implements LayaTokenizer {
  private readonly vocab: Map<string, number>;
  private readonly rank: Map<string, number>;
  private readonly byteFallback: boolean;
  private readonly unk: number;
  private readonly bos: number;
  private readonly eos: number;
  private readonly pad = 0;

  constructor(spec: TokenizerJson) {
    if (spec.model.type.toLowerCase() !== 'bpe') {
      throw new Error(`unsupported tokenizer model: ${spec.model.type}`);
    }
    this.vocab = new Map(Object.entries(spec.model.vocab));
    this.rank = new Map();
    for (let i = 0; i < spec.model.merges.length; i += 1) {
      const merge = spec.model.merges[i];
      const pair = typeof merge === 'string' ? merge.split(' ') : merge;
      if (pair.length === 2) this.rank.set(`${pair[0]}\u0000${pair[1]}`, i);
    }
    this.byteFallback = spec.model.byte_fallback === true;
    this.unk = this.vocab.get(spec.model.unk_token ?? '<unk>') ?? 0;
    const specials = spec.post_processor?.special_tokens ?? {};
    this.bos = specials['<bos>']?.ids?.[0] ?? 2;
    this.eos = specials['<eos>']?.ids?.[0] ?? 1;
  }

  static load(path: string): LayaBpeTokenizer {
    const spec = JSON.parse(readFileSync(path, 'utf8') as string) as TokenizerJson;
    return new LayaBpeTokenizer(spec);
  }

  encode(text: string, maxLength: number): { inputIds: number[]; attentionMask: number[] } {
    const ids = [this.bos, ...this.encodeBody(text), this.eos];
    const inputIds = ids.slice(0, maxLength);
    const attentionMask = inputIds.map(() => 1);
    while (inputIds.length < maxLength) {
      inputIds.push(this.pad);
      attentionMask.push(0);
    }
    return { inputIds, attentionMask };
  }

  /** Text -> token ids, excluding bos/eos. Mirrors normalizer + Metaspace + BPE. */
  encodeBody(text: string): number[] {
    if (text.length === 0) return [];
    const normalized = text.replace(/ /g, REPLACEMENT);
    const prefixed = normalized.startsWith(REPLACEMENT) ? normalized : REPLACEMENT + normalized;
    const pieces = prefixed.match(new RegExp(`${REPLACEMENT}[^${REPLACEMENT}]*`, 'gu')) ?? [];
    const ids: number[] = [];
    for (const piece of pieces) ids.push(...this.encodePiece(piece));
    return ids;
  }

  private encodePiece(piece: string): number[] {
    let symbols: string[] = [];
    for (const char of piece) {
      if (this.vocab.has(char)) {
        symbols.push(char);
      } else if (this.byteFallback) {
        for (const byte of Buffer.from(char, 'utf8')) {
          symbols.push(`<0x${byte.toString(16).padStart(2, '0')}>`);
        }
      } else {
        symbols.push(this.unkTokenString());
      }
    }
    symbols = this.merge(symbols);
    return symbols.map((symbol) => this.vocab.get(symbol) ?? this.unk);
  }

  private merge(symbols: string[]): string[] {
    let current = symbols;
    for (;;) {
      let bestRank = Infinity;
      let bestIndex = -1;
      for (let i = 0; i < current.length - 1; i += 1) {
        const r = this.rank.get(`${current[i]}\u0000${current[i + 1]}`);
        if (r !== undefined && r < bestRank) {
          bestRank = r;
          bestIndex = i;
        }
      }
      if (bestIndex === -1) break;
      const left = current[bestIndex];
      const right = current[bestIndex + 1];
      const merged: string[] = [];
      for (let i = 0; i < current.length; ) {
        if (i < current.length - 1 && current[i] === left && current[i + 1] === right) {
          merged.push(left + right);
          i += 2;
        } else {
          merged.push(current[i] as string);
          i += 1;
        }
      }
      current = merged;
    }
    return current;
  }

  private unkTokenString(): string {
    for (const [token, id] of this.vocab) if (id === this.unk) return token;
    return '<unk>';
  }
}