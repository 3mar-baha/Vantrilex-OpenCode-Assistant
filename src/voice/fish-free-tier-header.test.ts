import { describe, expect, test } from 'vitest';
import { fishHeaders, fishRequestBody, TTS_MODEL } from './tts.js';

// The Fish free tier is selected by an HTTP HEADER named `model`. Probed live
// against api.fish.audio on 2026-09-28, all four combinations:
//
//   model as header              -> 200, audio returned
//   model in the JSON body       -> 402 "Insufficient API credit"
//   no model at all              -> 402 "Insufficient API credit"
//   model header + full body     -> 200, audio returned
//
// The failure mode is what makes this worth a test: 402 blames the account's
// balance, so an engineer chasing it tops up credit that was never the problem
// and the next request 402s identically. Nothing in the code said the header was
// load-bearing — it was one line in an inline object, invisible to the suite,
// and moving it into `fishRequestBody` would look like a cleanup.

describe('the free model is selected by header, not by body field', () => {
  test('the model is present as a header', () => {
    expect(fishHeaders('k')['model']).toBe('s2.1-pro-free');
  });

  test('the header value is the free tier, not a paid model', () => {
    // A paid slug here is the bug this whole test exists to catch: it 402s on an
    // account with free credit remaining, and the error says "credit".
    expect(TTS_MODEL).toBe('s2.1-pro-free');
    expect(fishHeaders('k')['model']).toBe(TTS_MODEL);
  });

  test('the model is NOT a body field', () => {
    // This is the assertion that fails if someone tidies `model` out of the
    // headers and into the request body, where Fish ignores it.
    const body = fishRequestBody('مرحبا', 'ref-1');
    expect(body).not.toHaveProperty('model');
    expect(Object.keys(body)).not.toContain('model');
  });

  test('the auth and content-type headers are intact', () => {
    const h = fishHeaders('secret-key');
    expect(h['Authorization']).toBe('Bearer secret-key');
    expect(h['Content-Type']).toBe('application/json');
    expect(h['Accept']).toBe('audio/mpeg');
  });

  test('header key casing is exactly what the API documents', () => {
    // Lower-case `model`, not `Model`. HTTP header names are case-insensitive so
    // a server ought to accept either, but the documented form is lower-case and
    // this pins us to it rather than to a lucky acceptance.
    expect(Object.keys(fishHeaders('k'))).toContain('model');
  });

  test('the key never appears in the body', () => {
    // Belt and braces: a key in a JSON body is a key in a proxy log.
    const serialised = JSON.stringify(fishRequestBody('مرحبا', 'ref-1'));
    expect(serialised).not.toContain('secret-key');
  });
});
