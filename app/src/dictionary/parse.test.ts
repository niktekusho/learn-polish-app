import { expect, test } from 'vitest'
import { parseKaikkiLine } from './parse'

const fullEntry = JSON.stringify({
  word: 'zamek',
  pos: 'noun',
  lang_code: 'pl',
  senses: [
    { glosses: ['architecture', 'castle'], raw_glosses: ['(architecture) castle'], tags: [] },
    { glosses: ['lock'] },
  ],
  forms: [
    { form: 'zamku', tags: ['genitive', 'singular'] },
    { form: 'noun-declension', tags: ['table-tags'] },
    { form: '-', tags: ['nominative'] },
    { form: 'zamku', tags: ['genitive', 'singular'] }, // duplicate
  ],
  sounds: [{ audio: 'x.ogg' }, { ipa: '/ˈza.mɛk/' }],
  etymology_text: '  From Proto-Slavic *zamъkъ.  ',
})

test('full entry parses; gloss = last glosses element; junk/dup forms dropped', () => {
  const out = parseKaikkiLine(fullEntry)
  if (out.kind !== 'entry') throw new Error('expected entry')
  expect(out.entry.word).toBe('zamek')
  expect(out.entry.pos).toBe('noun')
  expect(out.entry.ipa).toBe('/ˈza.mɛk/')
  expect(out.entry.etymology).toBe('From Proto-Slavic *zamъkъ.')
  expect(out.entry.isMwe).toBe(false)
  expect(out.entry.senses).toEqual([
    { gloss: 'castle', rawGloss: '(architecture) castle', tags: [] },
    { gloss: 'lock', rawGloss: null, tags: [] },
  ])
  expect(out.entry.forms).toEqual([
    { form: 'zamku', tags: ['genitive', 'singular'] },
  ])
})

test('pure form-of entry is skipped', () => {
  const line = JSON.stringify({
    word: 'zamku',
    pos: 'noun',
    lang_code: 'pl',
    senses: [{ glosses: ['genitive singular of zamek'], form_of: [{ word: 'zamek' }] }],
  })
  expect(parseKaikkiLine(line)).toEqual({ kind: 'skip', reason: 'form-of' })
})

test('non-Polish lang_code is skipped', () => {
  const line = JSON.stringify({
    word: 'Schloss',
    pos: 'noun',
    lang_code: 'de',
    senses: [{ glosses: ['castle'] }],
  })
  expect(parseKaikkiLine(line)).toEqual({ kind: 'skip', reason: 'other-lang' })
})

test('unwanted pos is skipped', () => {
  const line = JSON.stringify({
    word: '-ek',
    pos: 'suffix',
    lang_code: 'pl',
    senses: [{ glosses: ['diminutive'] }],
  })
  expect(parseKaikkiLine(line)).toEqual({ kind: 'skip', reason: 'pos' })
})

test('missing optional fields parse to nulls/empty without throwing', () => {
  const line = JSON.stringify({
    word: 'kot',
    pos: 'noun',
    lang_code: 'pl',
    senses: [{ glosses: ['cat'] }],
  })
  const out = parseKaikkiLine(line)
  if (out.kind !== 'entry') throw new Error('expected entry')
  expect(out.entry.ipa).toBeNull()
  expect(out.entry.etymology).toBeNull()
  expect(out.entry.forms).toEqual([])
})

test('entry with no senses at all is skipped as no-senses', () => {
  const line = JSON.stringify({ word: 'x', pos: 'noun', lang_code: 'pl' })
  expect(parseKaikkiLine(line)).toEqual({ kind: 'skip', reason: 'no-senses' })
})

test('multi-word headword is flagged as MWE', () => {
  const line = JSON.stringify({
    word: 'na pewno',
    pos: 'adv',
    lang_code: 'pl',
    senses: [{ glosses: ['certainly'] }],
  })
  const out = parseKaikkiLine(line)
  if (out.kind !== 'entry') throw new Error('expected entry')
  expect(out.entry.isMwe).toBe(true)
})

test('name entries keep senses but drop forms', () => {
  const line = JSON.stringify({
    word: 'Polska',
    pos: 'name',
    lang_code: 'pl',
    senses: [{ glosses: ['Poland'] }],
    forms: [{ form: 'Polski', tags: ['genitive'] }],
  })
  const out = parseKaikkiLine(line)
  if (out.kind !== 'entry') throw new Error('expected entry')
  expect(out.entry.forms).toEqual([])
})

test('garbage and redirect stubs are unparsable', () => {
  expect(parseKaikkiLine('not json{')).toEqual({ kind: 'skip', reason: 'unparsable' })
  expect(parseKaikkiLine(JSON.stringify({ title: 'x', redirect: 'y' }))).toEqual({
    kind: 'skip',
    reason: 'unparsable',
  })
})
