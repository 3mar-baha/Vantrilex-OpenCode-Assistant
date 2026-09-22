import { readFileSync } from 'node:fs';

// Minimal WordPiece tokenizer over a HuggingFace tokenizer.json (wordpiece model).
// No native deps; the file ships from the Laya checkpoint download (M7 L1).
export interface TokenizerJson {
  model: {
    type: string;
    vocab: Record<string, number>;
    unk_token?: string;
    continuing_subword_prefix?: string;
    cls_token?: string;
    sep_token?: string;
  };
}

export class WordPieceTokenizer {
  private readonly vocab: Map<string, number>;
  private readonly unk: number;
  private readonly cls: number;
  private readonly sep: number;
  private readonly contPrefix: string;

  constructor(spec: TokenizerJson) {
    if (spec.model.type.toLowerCase() !== 'wordpiece') {
      throw new Error(`unsupported tokenizer model: ${spec.model.type}`);
    }
    this.vocab = new Map(Object.entries(spec.model.vocab));
    const get = (token: string | undefined, fallback: string): number => {
      const id = this.vocab.get(token ?? fallback);
      if (id === undefined) throw new Error('tokenizer vocab missing special token');
      return id;
    };
    this.unk = get(spec.model.unk_token, '[UNK]');
    this.cls = get(spec.model.cls_token, '[CLS]');
    this.sep = get(spec.model.sep_token, '[SEP]');
    this.contPrefix = spec.model.continuing_subword_prefix ?? '##';
  }

  static load(path: string): WordPieceTokenizer {
    const spec = JSON.parse(readFileSync(path, 'utf8') as string) as TokenizerJson;
    return new WordPieceTokenizer(spec);
  }

  encode(text: string, maxLength: number): { inputIds: number[]; attentionMask: number[] } {
    const tokens = [this.cls];
    for (const word of text.trim().split(/\s+/).filter((w) => w.length > 0)) {
      tokens.push(...this.encodeWord(word.toLowerCase()));
      if (tokens.length >= maxLength - 1) break;
    }
    tokens.push(this.sep);
    const inputIds = tokens.slice(0, maxLength);
    while (inputIds.length < maxLength) inputIds.push(0);
    const attentionMask = inputIds.map((id, i) => (i < tokens.length ? 1 : 0));
    void this.sep;
    return { inputIds, attentionMask };
  }

  private encodeWord(word: string): number[] {
    const ids: number[] = [];
    let start = 0;
    while (start < word.length) {
      let end = word.length;
      let found: number | null = null;
      while (start < end) {
        const piece = (start === 0 ? '' : this.contPrefix) + word.slice(start, end);
        const id = this.vocab.get(piece);
        if (id !== undefined) {
          found = id;
          break;
        }
        end -= 1;
      }
      if (found === null) {
        ids.push(this.unk);
        break;
      }
      ids.push(found);
      start = end;
    }
    return ids;
  }
}
