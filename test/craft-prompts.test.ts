import assert from 'node:assert/strict';
import { test, run } from './harness';
import { arrangePrompt, beatPrompt, focusPrompt, likePrompt, mashupPrompt, mixcheckPrompt, SERVER_INSTRUCTIONS, styleFor } from '../electron/mcp/prompts';

const SONG = 'C:\\Users\\me\\Music\\My Song.mp3';
const isFile = (p: string) => p === SONG;

const ONE_PROMPT = /ONE PROMPT = A FINISHED SONG: build a complete, arranged, mixed song to the end without asking me questions or for my approval along the way/;

function assertBuildFlow(text: string, label: string): void {
  const order = ['get_playbook', 'load_preset', 'write_pattern', 'groove', 'arrange', 'add_transition', 'apply_chain', 'sidechain', 'review_song', 'set_song_info', 'commit_edit'];
  let at = -1;
  for (const step of order) {
    const i = text.indexOf(step, at + 1);
    assert.ok(i > at, `${label}: "${step}" after the previous step\n${text}`);
    at = i;
  }
  assert.match(text, /At most 2 fix rounds/, label);
  assert.match(text, /never the same 8 bars everywhere/i, label);
  assert.match(text, /add_transition at EVERY section boundary/, label);
}

test('SERVER_INSTRUCTIONS: the one-prompt flow and the new tools, under Claude Code\'s 2048-character cut', () => {
  assert.ok(SERVER_INSTRUCTIONS.length <= 2048, `${SERVER_INSTRUCTIONS.length} chars`);
  for (const w of ['ONE PROMPT = A FINISHED SONG', 'without asking questions or for approval mid-build', 'the next prompt edits it', 'get_playbook', 'load_preset', 'find_presets', 'apply_chain (master, buses, sends)', 'save_preset', 'groove', 'add_transition at every section boundary', 'review_song and fix its top issues (max 2 rounds)', 'never open or read the audio with your own file tools', 'Browser, find_samples', 'library_import', 'list_packs'])
    assert.ok(SERVER_INSTRUCTIONS.includes(w), w);
});

test('beat prompt: a genre gives the style card + the full one-prompt build with get_playbook and a short final answer', () => {
  const t = beatPrompt({ genre: 'edm', bpm: '128', key: 'Fm' });
  assert.match(t, /^Make an edm beat in Krypt Studio at 128 bpm in Fm\./);
  assert.match(t, /Style card — edm/);
  assert.match(t, ONE_PROMPT);
  assert.match(t, /Only if I asked for just a loop or a single pattern, make that instead/);
  assert.match(t, /get_playbook \{"genre":"edm","brief":"128 bpm, in Fm"\}/);
  assertBuildFlow(t, 'beat');
  assert.match(t, /find_presets \{"role":"…"\} when a part needs a different sound/);
  assert.match(t, /apply_chain with insert "new" for the drum bus and the reverb \/ delay sends, then route the parts into them/);
  assert.match(t, /Answer briefly: what you made .*the review_song score, and 2-3 one-line edits I could ask for next/);
  assert.match(t, /Use my numbers over the playbook's: set_tempo 128, key Fm in every write_pattern header/);
  assert.match(beatPrompt({ idea: 'a festival big room banger' }), /Style card — edm/);
  const polka = beatPrompt({ genre: 'polka' });
  assert.match(polka, /Style card — polka: no built-in playbook/);
  assertBuildFlow(polka, 'polka');
  const none = beatPrompt({});
  assert.match(none, /No genre given: pick the one that fits/);
  assert.match(none, /get_playbook \{"genre":"<the genre you chose>"\}/);
  assert.deepEqual([styleFor('Big Room').id, styleFor('uk drill').id, styleFor('polka').id], ['edm', 'drill', null]);
});

test('like / beat with a reference: paths go straight to the tools, never the agent\'s own file tools; the playbook build, review and comparison', () => {
  const like = likePrompt({ song: SONG.split(' ')[0], request: SONG.split(' ')[1] }, [...SONG.split(' ').slice(2), 'make', 'it', 'edm'], { isFile });
  assert.match(like, /^Make a song in Krypt Studio like a reference song, as edm\./);
  assert.match(like, /never open, read or inspect my audio files with your own file tools \(each such call makes Claude Code stop and ask me\)/);
  assert.match(like, ONE_PROMPT);
  assert.ok(like.includes(`study_reference {"file":${JSON.stringify(SONG)},"genre":"edm"}`), like);
  assert.ok(like.includes('a muted track "Reference: My Song"'));
  assert.match(like, /get_playbook \{"genre":"edm"\}: the recipe now FOLLOWS the reference/);
  for (const s of ['load_preset', 'transform_notes op "groove"', 'add_transition at every section boundary', 'check_originality', 'review_song: it grades the song against the reference too', 'at most 2 fix rounds', 'Leave the reference track muted', 'the review_song score']) assert.ok(like.includes(s), s);
  assert.ok(like.indexOf('study_reference') < like.indexOf('get_playbook'));
  assert.ok(like.indexOf('get_playbook') < like.indexOf('review_song'));
  const beat = beatPrompt({ idea: `make an edm song like ${SONG}` }, [], { isFile });
  assert.match(beat, /^Make an edm song in Krypt Studio like a reference song\./);
  assert.match(beat, /with your own file tools/);
  assert.match(beat, /Style card — edm/);
});

test('mashup, focus, arrange and mixcheck prompts carry the no-questions rule, transitions and review_song', () => {
  const m = mashupPrompt({ a: 'Song A', b: 'Song B', tune: 'pop' });
  assert.match(m, /Build the whole mashup in one go without asking me for approval along the way/);
  assert.match(m, /The only reason to stop is a missing stem model/);
  assert.match(m, /add_transition at every section boundary/);
  assert.match(m, /review_song for the whole mashup/);
  assert.ok(m.indexOf('render_preview the drop') < m.indexOf('review_song'));
  const f = focusPrompt({ name: 'My beats', profile: 'STYLE PROFILE …', isFocus: true, idea: 'dark and sparse' });
  assert.match(f, ONE_PROMPT);
  for (const s of ['get_playbook with brief "dark and sparse"', 'my references already override', 'transform_notes op "groove"', 'add_transition at every section boundary', 'review_song', 'check_originality']) assert.ok(f.includes(s), s);
  const a = arrangePrompt({ structure: 'intro-drop-break-drop' });
  assert.match(a, /add_transition at every section boundary/);
  assert.match(a, /review_song: fix its arrangement issues/);
  const mc = mixcheckPrompt({ target_lufs: '-9' });
  assert.match(mc, /review_song/);
  assert.match(mc, /apply_chain a master chain preset/);
  assert.match(mc, /aim for -9 LUFS integrated/);
});

await run('craft-prompts');
