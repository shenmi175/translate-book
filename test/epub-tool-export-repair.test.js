import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('EPUB export repair writes text slots against stable original locations', () => {
  const script = String.raw`
import importlib.util

spec = importlib.util.spec_from_file_location("epub_tool", "scripts/epub_tool.py")
epub_tool = importlib.util.module_from_spec(spec)
spec.loader.exec_module(epub_tool)

root = epub_tool.parse_xml_string('<p><span>A<span>B</span>C<span>D</span>E</span></p>')
epub_tool.apply_translated_segments(root, ['', '乙', '', '丁', '尾'])
outer = root[0]

assert outer.text == ''
assert outer[0].text == '乙'
assert outer[0].tail == ''
assert outer[1].text == '丁'
assert outer[1].tail == '尾'
`;

  const result = spawnSync('python3', ['-c', script], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8'
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('EPUB bilingual insertion accepts repaired fragments with empty text slots', () => {
  const script = String.raw`
import importlib.util

spec = importlib.util.spec_from_file_location("epub_tool", "scripts/epub_tool.py")
epub_tool = importlib.util.module_from_spec(spec)
spec.loader.exec_module(epub_tool)

root = epub_tool.parse_xml_string('<body><p><span>A<span>B</span>C<span>D</span>E</span></p></body>')
source = root[0]
translated = epub_tool.clone_element(source)
epub_tool.apply_translated_segments(translated, ['', '乙', '', '丁', '尾'])
epub_tool.insert_translated_element_after(root, source, translated)

assert len(root) == 2
assert root[1].attrib.get('data-mts-role') == 'translation'
assert root[1][0].text == ''
assert root[1][0][0].text == '乙'
assert root[1][0][0].tail == ''
assert root[1][0][1].text == '丁'
assert root[1][0][1].tail == '尾'
`;

  const result = spawnSync('python3', ['-c', script], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8'
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('EPUB translation-only merge accepts repaired fragments with empty text slots', () => {
  const script = String.raw`
import importlib.util

spec = importlib.util.spec_from_file_location("epub_tool", "scripts/epub_tool.py")
epub_tool = importlib.util.module_from_spec(spec)
spec.loader.exec_module(epub_tool)

source = epub_tool.parse_xml_string('<p><span>A<span>B</span>C<span>D</span>E</span></p>')
translated = epub_tool.clone_element(source)
epub_tool.apply_translated_segments(translated, ['', '乙', '', '丁', '尾'])
epub_tool.merge_translated_element(source, translated)
outer = source[0]

assert outer.text == ''
assert outer[0].text == '乙'
assert outer[0].tail == ''
assert outer[1].text == '丁'
assert outer[1].tail == '尾'
`;

  const result = spawnSync('python3', ['-c', script], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8'
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
});
