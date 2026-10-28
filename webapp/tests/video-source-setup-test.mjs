// Self-test for the "start analysis pauses immediately" defect.
//
// Root cause chain (observed 2026-10-28 in production logs):
//   ensureServerVideoSource() threw '请重新选择原视频' with fatal:true.
//   runWindowQueue() treated fatal as "stop the whole queue", so only SCREEN-0
//   was attempted (elapsed_ms=0, zero server-side video requests).
//   The workflow then reported '全课初筛尚未完成' and looked like a pause.
//
// This test pins the three parts of the fix:
//   1. a setup error (missing video file) is no longer fatal
//   2. a fatal provider error still stops the queue and leaves the rest pending
//   3. a per-window permanent error still lets the remaining windows run
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../frontend/classroom.html', import.meta.url), 'utf8');
const source = html.slice(html.indexOf('  async function runWindowQueue('), html.indexOf('  function coverageSeconds('));

const queue = new Function(`${source};return runWindowQueue;`)();
const noWait = async () => {};

// 1. A missing video file is a setup error, not a provider-wide failure.
//    It must not carry fatal:true, otherwise one bad window cancels the rest.
const setup = html.slice(html.indexOf('  async function ensureServerVideoSource('), html.indexOf("  $('#cancelClip').onclick"));
assert.ok(/if\(!file\)throw Object\.assign\(new Error\('请重新选择原视频'\),\{fatal:false\}\)/.test(setup),
  'missing video file must not be marked fatal');
assert.ok(/if\(file\.size>1\.5\*1024\*1024\*1024\)throw Object\.assign\(new Error\('原视频超过1.5GB，请压缩后重试。'\),\{fatal:true\}\)/.test(setup),
  'an oversized video is a permanent setup failure and stays fatal');

// The queue still stops for a genuine provider-wide failure and leaves the rest pending.
const auth = [{ id: 'a', status: 'pending' }, { id: 'b', status: 'pending' }];
let authCalls = 0;
await queue(auth, async () => { authCalls++; throw Object.assign(new Error('credential expired'), { fatal: true }); }, new AbortController().signal, () => {}, noWait);
assert.equal(authCalls, 1, 'a fatal provider error stops the queue after one attempt');
assert.deepEqual(auth.map(w => w.status), ['failed', 'pending'], 'remaining windows stay pending after a fatal error');

// A per-window permanent failure must not cancel the other windows.
const permanent = [{ id: 'bad', status: 'pending' }, { id: 'good', status: 'pending' }];
await queue(permanent, async w => { if (w.id === 'bad') throw new Error('invalid media'); }, new AbortController().signal, () => {}, noWait);
assert.deepEqual(permanent.map(w => w.status), ['failed', 'analyzed'], 'a per-window failure does not stop the queue');

// 3. The workflow checks for a missing video file before the screening queue runs,
//    so the user gets a clear instruction instead of a generic "screening incomplete".
const start = html.slice(html.indexOf('  async function startAssessment('));
assert.ok(start.includes("if(!useCompletedScreening&&!$('#videoFile').files[0])throw new Error("),
  'screening checks for the video file before running the queue');
assert.ok(start.includes("if(recommendedWindows.some(w=>w.status!=='analyzed'&&w.status!=='deferred')&&!$('#videoFile').files[0])throw new Error("),
  'the clip queue checks for the video file before running');

// The upload step is only attempted once per session and reused afterwards.
assert.ok(/if\(serverVideoSource\?\.file===file&&serverVideoSource\.identity===identity\)/.test(setup),
  'an uploaded video source is reused for later windows');

console.log('Video source setup errors: missing file is not fatal, oversized video stays fatal');
console.log('Queue semantics: provider-wide fatal stops the queue, per-window failures do not');
console.log('Workflow: missing video file is reported before the screening queue starts');
