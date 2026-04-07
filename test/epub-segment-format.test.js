import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyEpubPlaceholderBestEffortTranslation,
  applyEpubPlaceholderTranslation,
  applyEpubTranslationUnit,
  buildEpubPlaceholderPlan,
  parseEpubPlaceholderTranslation
} from '../server/lib/epub-hotpath.js';
import { parseEpubTranslatedSegments } from '../server/lib/task-service.js';

test('EPUB segment parser accepts wrapped translation arrays', () => {
  const translations = parseEpubTranslatedSegments(JSON.stringify({
    translations: ['第一段', '第二段']
  }), 2, 'LiteLLM');

  assert.deepEqual(translations, ['第一段', '第二段']);
});

test('EPUB segment parser accepts nested stringified arrays', () => {
  const translations = parseEpubTranslatedSegments(JSON.stringify({
    result: '["第一段","第二段","第三段"]'
  }), 3, 'LiteLLM');

  assert.deepEqual(translations, ['第一段', '第二段', '第三段']);
});

test('EPUB segment parser reports empty items precisely', () => {
  assert.throws(
    () => parseEpubTranslatedSegments('["第一段","","第三段"]', 3, 'LiteLLM'),
    /segment 2 was empty/i
  );
});

test('EPUB placeholder mode preserves inline structure and protected footnotes', () => {
  const translationUnit = {
    segmentTemplate: '<p><span>__MTS_SEG_0001__ <span class="italic">__MTS_SEG_0002__</span> __MTS_SEG_0003__<a href="#note-76"><sup>__MTS_SEG_0004__</sup></a></span></p>',
    previewTemplate: '__MTS_SEG_0001__ __MTS_SEG_0002__ __MTS_SEG_0003__ __MTS_SEG_0004__',
    segments: [
      { index: 1, token: '__MTS_SEG_0001__', kind: 'text', path: '/p[1]/span[1]/#text[1]', sourceText: 'The worst of the lot,' },
      { index: 2, token: '__MTS_SEG_0002__', kind: 'text', path: '/p[1]/span[1]/span[1]/#text[1]', sourceText: 'Road to Reaction,' },
      { index: 3, token: '__MTS_SEG_0003__', kind: 'text', path: '/p[1]/span[1]/#text[2]', sourceText: 'was discussed.' },
      { index: 4, token: '__MTS_SEG_0004__', kind: 'text', path: '/p[1]/span[1]/a[1]/sup[1]/#text[1]', sourceText: '76' }
    ]
  };

  const plan = buildEpubPlaceholderPlan(translationUnit, { minimumMarkers: 1 });
  assert.ok(plan);
  assert.match(plan.sourceText, /\[\[MTS_OPEN_0002\]\]Road to Reaction,\[\[MTS_CLOSE_0002\]\]/);
  assert.match(plan.sourceText, /\[\[MTS_KEEP_0004\]\]/);

  const applied = applyEpubPlaceholderTranslation({
    blockType: 'paragraph',
    sourceMarkdown: 'The worst of the lot, Road to Reaction, was discussed. 76',
    translationUnit,
    rawTranslation: '其中最糟的是[[MTS_OPEN_0002]]《通往反动之路》[[MTS_CLOSE_0002]]，也被讨论过。[[MTS_KEEP_0004]]',
    providerLabel: 'LiteLLM'
  });

  assert.match(applied.normalizedFragment, /<span class="italic">《通往反动之路》<\/span>/);
  assert.match(applied.normalizedFragment, /<sup>76<\/sup>/);
  assert.match(applied.previewText, /其中最糟的是/);
  assert.match(applied.previewText, /《通往反动之路》/);
});

test('EPUB placeholder parser rejects missing placeholders', () => {
  const translationUnit = {
    segmentTemplate: '<p>__MTS_SEG_0001__ <em>__MTS_SEG_0002__</em></p>',
    segments: [
      { index: 1, token: '__MTS_SEG_0001__', kind: 'text', path: '/p[1]/#text[1]', sourceText: 'Title:' },
      { index: 2, token: '__MTS_SEG_0002__', kind: 'text', path: '/p[1]/em[1]/#text[1]', sourceText: 'Road to Reaction' }
    ]
  };
  const plan = buildEpubPlaceholderPlan(translationUnit, { minimumMarkers: 1 });

  assert.throws(
    () => parseEpubPlaceholderTranslation('标题：《通往反动之路》', plan, 'LiteLLM'),
    /placeholders/i
  );
});

test('EPUB placeholder mode handles footnote-leading blocks with multiple inline titles', () => {
  const translationUnit = {
    segmentTemplate: '<p><span><sup><a href="#ref">__MTS_SEG_0001__</a></sup> __MTS_SEG_0002__ <span class="italic">__MTS_SEG_0003__</span> <span class="italic">__MTS_SEG_0004__</span> __MTS_SEG_0005__</span></p>',
    previewTemplate: '__MTS_SEG_0001__ __MTS_SEG_0002__ __MTS_SEG_0003__ __MTS_SEG_0004__ __MTS_SEG_0005__',
    segments: [
      { index: 1, token: '__MTS_SEG_0001__', kind: 'text', path: '/p[1]/span[1]/sup[1]/a[1]/#text[1]', sourceText: '12' },
      { index: 2, token: '__MTS_SEG_0002__', kind: 'text', path: '/p[1]/span[1]/#text[1]', sourceText: '[Hayek refers to Alfred, Lord Tennyson’s poem “Locksley Hall.” See' },
      { index: 3, token: '__MTS_SEG_0003__', kind: 'text', path: '/p[1]/span[1]/span[1]/#text[1]', sourceText: 'The Poetical Works of Alfred' },
      { index: 4, token: '__MTS_SEG_0004__', kind: 'text', path: '/p[1]/span[1]/span[2]/#text[1]', sourceText: 'Lord Tennyson' },
      { index: 5, token: '__MTS_SEG_0005__', kind: 'text', path: '/p[1]/span[1]/#text[2]', sourceText: '(Boston and New York: Houghton Mifflin, 1892).' }
    ]
  };

  const plan = buildEpubPlaceholderPlan(translationUnit, { minimumMarkers: 1 });
  assert.ok(plan);
  assert.match(plan.sourceText, /^\[\[MTS_KEEP_0001\]\]/);

  const applied = applyEpubPlaceholderTranslation({
    blockType: 'paragraph',
    sourceMarkdown: '12 [Hayek refers to Alfred, Lord Tennyson’s poem “Locksley Hall.” See The Poetical Works of Alfred Lord Tennyson (Boston and New York: Houghton Mifflin, 1892).',
    translationUnit,
    rawTranslation: '[[MTS_KEEP_0001]] [哈耶克此处提到阿尔弗雷德·丁尼生勋爵的诗《洛克斯利庄园》。参见 [[MTS_OPEN_0003]]《阿尔弗雷德诗集》[[MTS_CLOSE_0003]] [[MTS_OPEN_0004]]丁尼生勋爵[[MTS_CLOSE_0004]]（波士顿与纽约：霍顿·米夫林出版社，1892年）。',
    providerLabel: 'LiteLLM'
  });

  assert.match(applied.normalizedFragment, /<a href="#ref">12<\/a>/);
  assert.match(applied.normalizedFragment, /<span class="italic">《阿尔弗雷德诗集》<\/span>/);
  assert.match(applied.normalizedFragment, /<span class="italic">丁尼生勋爵<\/span>/);
  assert.match(applied.previewText, /哈耶克此处提到/);
});

test('EPUB placeholder best-effort fallback strips internal tokens when the model reorders inline titles', () => {
  const translationUnit = {
    segmentTemplate: '<p><span><sup><a href="#ref">__MTS_SEG_0001__</a></sup>__MTS_SEG_0002__<span class="italic">__MTS_SEG_0003__</span>__MTS_SEG_0004__<span class="italic">__MTS_SEG_0005__</span>__MTS_SEG_0006__</span></p>',
    previewTemplate: '__MTS_SEG_0001__ __MTS_SEG_0002__ __MTS_SEG_0003__ __MTS_SEG_0004__ __MTS_SEG_0005__ __MTS_SEG_0006__',
    segments: [
      { index: 1, token: '__MTS_SEG_0001__', kind: 'text', path: '/p[1]/span[1]/sup[1]/a[1]/#text[1]', sourceText: '27' },
      { index: 2, token: '__MTS_SEG_0002__', kind: 'text', path: '/p[1]/span[1]/#text[1]', sourceText: 'See' },
      { index: 3, token: '__MTS_SEG_0003__', kind: 'text', path: '/p[1]/span[1]/span[1]/#text[1]', sourceText: 'Prussian' },
      { index: 4, token: '__MTS_SEG_0004__', kind: 'text', path: '/p[1]/span[1]/#text[2]', sourceText: 'in' },
      { index: 5, token: '__MTS_SEG_0005__', kind: 'text', path: '/p[1]/span[1]/span[2]/#text[1]', sourceText: 'The Decline of the West' },
      { index: 6, token: '__MTS_SEG_0006__', kind: 'text', path: '/p[1]/span[1]/#text[3]', sourceText: 'for details.' }
    ]
  };

  const applied = applyEpubPlaceholderBestEffortTranslation({
    blockType: 'paragraph',
    sourceMarkdown: '27 See Prussian in The Decline of the West for details.',
    translationUnit,
    rawTranslation: '[[MTS_KEEP_0001]] 参见[[MTS_OPEN_0005]]《西方的没落》[[MTS_CLOSE_0005]]中关于[[MTS_OPEN_0003]]普鲁士式[[MTS_CLOSE_0003]]的讨论。',
    providerLabel: 'LiteLLM'
  });

  assert.match(applied.normalizedFragment, /<a href="#ref">27<\/a>/);
  assert.match(applied.previewText, /参见《西方的没落》中关于普鲁士式的讨论/);
  assert.doesNotMatch(applied.normalizedFragment, /MTS_/);
  assert.equal(applied.structureSignature, 'inline-placeholder-best-effort');
});

test('EPUB preview preserves line breaks from XHTML br elements', () => {
  const translationUnit = {
    segmentTemplate: '<blockquote><span>__MTS_SEG_0001__<br class="calibre11" />__MTS_SEG_0002__<br class="calibre11" />__MTS_SEG_0003__</span></blockquote>',
    previewTemplate: '> __MTS_SEG_0001__ __MTS_SEG_0002__ __MTS_SEG_0003__',
    segments: [
      { index: 1, token: '__MTS_SEG_0001__', kind: 'text', path: '/blockquote[1]/span[1]/#text[1]', sourceText: 'Line one' },
      { index: 2, token: '__MTS_SEG_0002__', kind: 'text', path: '/blockquote[1]/span[1]/#text[2]', sourceText: 'Line two' },
      { index: 3, token: '__MTS_SEG_0003__', kind: 'text', path: '/blockquote[1]/span[1]/#text[3]', sourceText: 'Line three' }
    ]
  };

  const applied = applyEpubTranslationUnit({
    blockType: 'blockquote',
    sourceMarkdown: '> Line one\n> Line two\n> Line three',
    translationUnit,
    translatedSegments: ['第一行', '第二行', '第三行']
  });

  assert.equal(applied.previewText, '> 第一行\n> 第二行\n> 第三行');
});
