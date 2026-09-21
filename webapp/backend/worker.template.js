const PAGE_HTML = __PAGE_HTML__;
const CLASSROOM_HTML = __CLASSROOM_HTML__;
const PRE_SKILL = __PRE_SKILL__;
const POST_SKILL = __POST_SKILL__;
const OUTPUT_SCHEMA = __OUTPUT_SCHEMA__;

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const textDecoder = new TextDecoder("utf-8");
const rateBuckets = new Map();

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function extname(name) {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i).toLowerCase();
}

function concat(chunks) {
  const length = chunks.reduce((n, x) => n + x.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
  return out;
}

function decodeXml(value) {
  return value
    .replace(/<w:tab\/?\s*>|<a:tab\/?\s*>/g, "\t")
    .replace(/<w:br\/?\s*>|<a:br\/?\s*>/g, "\n")
    .replace(/<\/(?:w:p|a:p|w:tr)>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

async function unzip(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65558); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("文件不是有效的 Office 压缩包");
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error("Office 文件目录损坏");
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = textDecoder.decode(bytes.slice(offset + 46, offset + 46 + nameLength));
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = bytes.slice(dataStart, dataStart + compressedSize);
    let data;
    if (method === 0) data = compressed;
    else if (method === 8) {
      const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      data = new Uint8Array(await new Response(stream).arrayBuffer());
    } else throw new Error(`暂不支持 Office 文件中的压缩方式 ${method}`);
    entries.set(name, data);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function extractOpenXml(file, kind) {
  const entries = await unzip(await file.arrayBuffer());
  let names;
  if (kind === ".docx") names = [...entries.keys()].filter(x => /^word\/(document|header\d+|footer\d+)\.xml$/.test(x));
  else names = [...entries.keys()].filter(x => /^ppt\/slides\/slide\d+\.xml$/.test(x)).sort((a,b) => Number(a.match(/\d+/)?.[0]) - Number(b.match(/\d+/)?.[0]));
  if (!names.length) throw new Error("文件中没有找到可读取的正文");
  return names.map((name, i) => `${kind === ".pptx" ? `[幻灯片 ${i + 1}]\n` : ""}${decodeXml(textDecoder.decode(entries.get(name)))}`).join("\n\n");
}

function extractLegacyDoc(buffer) {
  const bytes = new Uint8Array(buffer), view = new DataView(buffer);
  const u16 = (b, o) => new DataView(b.buffer, b.byteOffset, b.byteLength).getUint16(o, true);
  const u32 = (b, o) => new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(o, true);
  if (view.getUint32(0, false) !== 0xd0cf11e0) throw new Error("不是有效的旧版 Word 文件");
  const sectorSize = 1 << view.getUint16(30, true);
  const sector = n => bytes.slice((n + 1) * sectorSize, (n + 2) * sectorSize);
  const fatIds = [];
  for (let i = 0; i < 109; i++) fatIds.push(view.getUint32(76 + i * 4, true));
  let difat = view.getUint32(68, true);
  for (let k = 0; k < view.getUint32(72, true) && difat < 0xfffffffa; k++) {
    const d = sector(difat), dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
    for (let i = 0; i < sectorSize / 4 - 1; i++) fatIds.push(dv.getUint32(i * 4, true));
    difat = dv.getUint32(sectorSize - 4, true);
  }
  const fat = [];
  for (const id of fatIds) if (id < 0xfffffffa) {
    const s = sector(id), sv = new DataView(s.buffer, s.byteOffset, s.byteLength);
    for (let i = 0; i < sectorSize / 4; i++) fat.push(sv.getUint32(i * 4, true));
  }
  const chain = (start, table, reader) => { const out = [], seen = new Set(); let n = start; while (n < 0xfffffffa && !seen.has(n)) { seen.add(n); out.push(reader(n)); n = table[n]; } return concat(out); };
  const directory = chain(view.getUint32(48, true), fat, sector), entries = [];
  for (let o = 0; o + 128 <= directory.length; o += 128) {
    const item = directory.slice(o, o + 128), len = u16(item, 64);
    if (len >= 2) entries.push({ name: new TextDecoder("utf-16le").decode(item.slice(0, len - 2)), type: item[66], start: u32(item, 116), size: u32(item, 120) });
  }
  const root = entries.find(x => x.type === 5); if (!root) throw new Error("Word 文件目录缺失");
  const mini = chain(root.start, fat, sector), miniFatRaw = chain(view.getUint32(60, true), fat, sector), miniFat = [];
  for (let i = 0; i + 4 <= miniFatRaw.length; i += 4) miniFat.push(u32(miniFatRaw, i));
  const stream = name => { const x = entries.find(e => e.name === name); if (!x) throw new Error(`Word 文件缺少 ${name}`); const raw = x.size < 4096 ? chain(x.start, miniFat, n => mini.slice(n * 64, (n + 1) * 64)) : chain(x.start, fat, sector); return raw.slice(0, x.size); };
  const word = stream("WordDocument");
  const table = stream((u16(word, 10) & 0x0200) ? "1Table" : "0Table");
  let o = 32; const csw = u16(word, o); o += 2 + csw * 2; const cslw = u16(word, o); o += 2 + cslw * 4; o += 2;
  const fcClx = u32(word, o + 33 * 8), lcbClx = u32(word, o + 33 * 8 + 4), clx = table.slice(fcClx, fcClx + lcbClx);
  let p = 0; while (clx[p] === 1) p += 3 + u16(clx, p + 1); if (clx[p] !== 2) throw new Error("旧版 Word 正文索引无法读取");
  const length = u32(clx, p + 1), plc = clx.slice(p + 5, p + 5 + length), pieceCount = Math.floor((length - 4) / 12), cps = [];
  for (let i = 0; i <= pieceCount; i++) cps.push(u32(plc, i * 4));
  const parts = [];
  for (let i = 0; i < pieceCount; i++) {
    const po = (pieceCount + 1) * 4 + i * 8, rawPos = u32(plc, po + 2), compressed = (rawPos & 0x40000000) !== 0;
    let pos = rawPos & 0x3fffffff, count = cps[i + 1] - cps[i];
    if (compressed) { pos = Math.floor(pos / 2); parts.push(new TextDecoder("windows-1252").decode(word.slice(pos, pos + count))); }
    else parts.push(new TextDecoder("utf-16le").decode(word.slice(pos, pos + count * 2)));
  }
  return parts.join("").replace(/\x07/g, " | ").replace(/\r/g, "\n").replace(/[\x00-\x06\x08-\x0c\x0e-\x1f]/g, "").replace(/\n{3,}/g, "\n\n").trim();
}

async function extractFile(file) {
  const ext = extname(file.name);
  if ([".txt", ".md"].includes(ext)) return await file.text();
  if ([".docx", ".pptx"].includes(ext)) return await extractOpenXml(file, ext);
  if (ext === ".doc") return extractLegacyDoc(await file.arrayBuffer());
  return null;
}

function parseModelJson(content) {
  const cleaned = String(content || "").replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
  const start = cleaned.indexOf("{"), end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("模型没有返回可读取的评估结果");
  const source = cleaned.slice(start, end + 1);
  let data;
  try { data = JSON.parse(source); }
  catch {
    const escaped = escapeControlsInStrings(source).replace(/,\s*([}\]])/g, "$1");
    data = JSON.parse(escaped);
  }
  if (data && Array.isArray(data.d) && Array.isArray(data.a)) return expandCompactResult(data);
  if (!data || !Array.isArray(data.dimensions) || !Array.isArray(data.suggestions)) throw new Error("模型返回结构不完整");
  return data;
}

const DIMENSION_LABELS = {
  alignment: "内容契合度",
  adequacy: "数量与质量",
  outcomes: "使用成效",
  innovation_feedback: "创新与反馈引用",
  awards: "获奖记录"
};

function compactEvidence(locator) {
  return locator && locator !== "未提供" ? [{ source_id: "materials", locator, kind: "document", excerpt: "" }] : [];
}

function expandCompactResult(data) {
  return {
    version: "1.0",
    mode: data.m === "post" ? "post" : "pre",
    status: data.s || "partial",
    lesson: data.l || "未命名课程",
    summary: data.u || "评估完成",
    tools: (data.t || []).slice(0, 8).map(x => ({ name: x[0] || "未命名教具", goal: x[1] || "", activity: x[2] || "", evidence: compactEvidence(x[3]) })),
    dimensions: data.d.slice(0, 5).map(x => ({ id: x[0], label: DIMENSION_LABELS[x[0]] || x[0], status: x[1] || "unknown", finding: x[2] || "未提供", evidence: compactEvidence(x[3]) })),
    suggestions: data.a.slice(0, 4).map(x => ({ priority: x[0] || "medium", dimension_id: x[1] || "alignment", tool: x[2] || "整体教具", issue: x[3] || "需进一步核实", action: x[4] || "补充材料后复核", location: x[5] || "教案", observe_next: x[6] || "记录学生表现", evidence: compactEvidence(x[7]) })),
    questions: (data.q || []).slice(0, 3),
    limitations: (data.x || []).slice(0, 3)
  };
}

function parseLineResult(content, requestedMode) {
  const cleaned = String(content || "").replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/```[\s\S]*?\n?/g, "").trim();
  const result = { version: "1.0", mode: requestedMode, status: "partial", lesson: "未命名课程", summary: "评估完成", tools: [], dimensions: [], suggestions: [], questions: [], limitations: [] };
  for (const rawLine of cleaned.split(/\r?\n/)) {
    const parts = rawLine.trim().split("\t").map(x => x.trim());
    const type = parts.shift()?.toUpperCase();
    if (type === "META") { result.mode = parts[0] === "post" ? "post" : "pre"; result.status = parts[1] || "partial"; result.lesson = parts[2] || result.lesson; }
    else if (type === "SUMMARY") result.summary = parts.join(" ") || result.summary;
    else if (type === "TOOL" && parts[0]) result.tools.push({ name: parts[0], goal: parts[1] || "", activity: parts[2] || "", evidence: compactEvidence(parts[3]) });
    else if (type === "DIM" && DIMENSION_LABELS[parts[0]]) result.dimensions.push({ id: parts[0], label: DIMENSION_LABELS[parts[0]], status: parts[1] || "unknown", finding: parts[2] || "未提供", evidence: compactEvidence(parts[3]) });
    else if (type === "SUG" && parts[0]) result.suggestions.push({ priority: parts[0], dimension_id: parts[1] || "alignment", tool: parts[2] || "整体教具", issue: parts[3] || "需进一步核实", action: parts[4] || "补充材料后复核", location: parts[5] || "教案", observe_next: parts[6] || "记录学生表现", evidence: compactEvidence(parts[7]) });
    else if (type === "Q" && parts[0]) result.questions.push(parts.join(" "));
    else if (type === "LIMIT" && parts[0]) result.limitations.push(parts.join(" "));
  }
  const found = new Map(result.dimensions.map(x => [x.id, x]));
  result.dimensions = Object.keys(DIMENSION_LABELS).map(id => found.get(id) || ({ id, label: DIMENSION_LABELS[id], status: requestedMode === "pre" && id === "outcomes" ? "not_applicable" : "unknown", finding: "模型未返回该项，请结合补充材料复核。", evidence: [] }));
  result.tools = result.tools.slice(0, 8); result.suggestions = result.suggestions.slice(0, 4); result.questions = result.questions.slice(0, 3); result.limitations = result.limitations.slice(0, 3);
  if (!result.tools.length && !result.suggestions.length && result.summary === "评估完成") throw new Error("模型没有返回可读取的评估结果");
  return result;
}

function parseModelResult(content, requestedMode) {
  try { return parseModelJson(content); }
  catch { return parseLineResult(content, requestedMode); }
}

function escapeControlsInStrings(source) {
  let output = "", inString = false, escaped = false;
  for (const char of source) {
    if (inString && !escaped && char === "\n") { output += "\\n"; continue; }
    if (inString && !escaped && char === "\r") { output += "\\r"; continue; }
    if (inString && !escaped && char === "\t") { output += "\\t"; continue; }
    output += char;
    if (char === '"' && !escaped) inString = !inString;
    escaped = char === "\\" && !escaped;
    if (char !== "\\") escaped = false;
  }
  return output;
}

async function callMiniMax(env, messages, temperature = 0.2, maxCompletionTokens = 2048) {
  const apiBase = String(env.MINIMAX_API_BASE || "https://api.minimaxi.com/v1").replace(/\/$/, "");
  const model = env.MINIMAX_MODEL || "MiniMax-M3";
  const response = await fetch(`${apiBase}/chat/completions`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${env.MINIMAX_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, temperature, top_p: 0.9, max_completion_tokens: maxCompletionTokens })
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`MiniMax 接口请求失败（${response.status}）`);
  const baseCode = payload?.base_resp?.status_code;
  if (baseCode && baseCode !== 0) throw new Error(payload?.base_resp?.status_msg || `MiniMax 返回错误 ${baseCode}`);
  return String(payload?.choices?.[0]?.message?.content || "");
}

function bytesToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

async function callMiniMaxMedia(env, content) {
  const apiBase = String(env.MINIMAX_ANTHROPIC_BASE || new URL(env.MINIMAX_API_BASE || "https://api.minimaxi.com/v1").origin + "/anthropic/v1").replace(/\/$/, "");
  const response = await fetch(`${apiBase}/messages`, {
    method: "POST",
    headers: { "x-api-key": env.MINIMAX_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: env.MINIMAX_MODEL || "MiniMax-M3", max_tokens: 4096, temperature: 0.1, messages: [{ role: "user", content }] })
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.error?.message || `MiniMax 视频接口请求失败（${response.status}）`);
  const text = Array.isArray(payload?.content) ? payload.content.filter(item => item?.type === "text").map(item => item.text || "").join("\n") : "";
  if (!text) throw new Error("MiniMax 没有返回可读取的视频分析结果");
  return text;
}

function parseCandidateResult(content, duration) {
  const cleaned = String(content || "").replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
  const start = cleaned.indexOf("{"), end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("模型没有返回候选节点 JSON");
  const data = JSON.parse(cleaned.slice(start, end + 1));
  const phases = new Set(["baseline", "tool_use", "generalization"]), types = new Set(["instruction", "response", "engagement", "avoidance", "operation", "generalization", "emotion"]);
  const outcomes = new Set(["positive", "negative", "neutral"]), assistance = new Set(["independent", "gesture", "verbal", "model", "physical", "none"]), confidence = new Set(["high", "medium", "low"]);
  const candidates = (Array.isArray(data.candidates) ? data.candidates : []).slice(0, 30).map((item, index) => {
    const from = Math.max(0, Math.min(Number(duration) || Number.MAX_SAFE_INTEGER, Number(item.start_seconds) || 0));
    const to = Math.max(from, Math.min(Number(duration) || Number.MAX_SAFE_INTEGER, Number(item.end_seconds) || from + 10));
    return {
      id: `AI${index + 1}`, start_seconds: from, end_seconds: to,
      phase: phases.has(item.phase) ? item.phase : "tool_use", type: types.has(item.type) ? item.type : "engagement",
      student_id: String(item.student_id || "待确认").slice(0, 20), outcome: outcomes.has(item.outcome) ? item.outcome : "neutral",
      assistance: assistance.has(item.assistance) ? item.assistance : "none", confidence: confidence.has(item.confidence) ? item.confidence : "low",
      note: String(item.note || "").slice(0, 300), reason: String(item.reason || "").slice(0, 200), confirmed: false, source: "ai_candidate"
    };
  }).filter(item => item.note);
  return { summary: String(data.summary || `AI 提取了 ${candidates.length} 个候选节点，请评委逐条复核。`).slice(0, 300), candidates };
}

async function analyzeClassroomVideo(request, env) {
  if (!env.MINIMAX_API_KEY) return json({ error: "尚未配置 MiniMax 模型密钥" }, 503);
  const form = await request.formData();
  const mode = form.get("mode") === "frames" ? "frames" : "video";
  const duration = Math.max(0, Number(form.get("duration")) || 0);
  const lesson = String(form.get("lesson") || "未命名课程").slice(0, 200);
  const goals = String(form.get("goals") || "未提供").slice(0, 6000);
  const instructions = String(form.get("instructions") || "未提供").slice(0, 6000);
  const prompt = `你是特殊教育课堂视频的候选证据提取助手。课程：${lesson}。\n可观察目标：${goals}\n关键指令和预期反应：${instructions}\n视频真实时长：${duration.toFixed(2)} 秒。\n只记录画面或声音中可观察到的事实，不根据面部表情推断内心情绪，不识别人脸身份；无法确认学生编号时写“待确认”。将相近行为合并，最多30条。候选节点只是给评委复核，不能直接评分。${mode === "video" ? "模型可能对视频稀疏采样；请依据提供的真实时长换算并返回实际视频秒数。" : "随后图片按时间顺序提供，每张图片前都有真实视频时间；只能依据这些采样画面提出候选，不要补写两帧之间未观察到的行为。"}\n只返回有效 JSON：{"summary":"简短说明","candidates":[{"start_seconds":12.3,"end_seconds":20.0,"phase":"baseline|tool_use|generalization","type":"instruction|response|engagement|avoidance|operation|generalization|emotion","student_id":"待确认或匿名编号","outcome":"positive|negative|neutral","assistance":"independent|gesture|verbal|model|physical|none","confidence":"high|medium|low","note":"客观事实","reason":"对应目标或指令"}]}。`;
  const content = [{ type: "text", text: prompt }];
  if (mode === "video") {
    const video = form.get("video");
    if (!video || typeof video === "string") return json({ error: "请选择课堂视频" }, 400);
    if (video.size > 20 * 1024 * 1024) return json({ error: "原视频超过 20MB，请使用关键帧分析模式" }, 413);
    const mediaType = ["video/mp4", "video/webm", "video/quicktime"].includes(video.type) ? video.type : extname(video.name) === ".webm" ? "video/webm" : extname(video.name) === ".mov" ? "video/quicktime" : "video/mp4";
    content.push({ type: "video", source: { type: "base64", media_type: mediaType, data: bytesToBase64(await video.arrayBuffer()) } });
  } else {
    const frames = form.getAll("frames").filter(item => typeof item !== "string").slice(0, 36);
    let times;
    try { times = JSON.parse(String(form.get("frame_times") || "[]")); } catch { times = []; }
    const total = frames.reduce((sum, frame) => sum + frame.size, 0);
    if (!frames.length) return json({ error: "没有收到可分析的关键帧" }, 400);
    if (total > 12 * 1024 * 1024) return json({ error: "关键帧总大小超过 12MB" }, 413);
    for (let index = 0; index < frames.length; index++) {
      content.push({ type: "text", text: `[关键帧 ${index + 1}，真实视频时间 ${Number(times[index] || 0).toFixed(1)} 秒]` });
      const mediaType = ["image/jpeg", "image/png", "image/webp"].includes(frames[index].type) ? frames[index].type : "image/jpeg";
      content.push({ type: "image", source: { type: "base64", media_type: mediaType, data: bytesToBase64(await frames[index].arrayBuffer()) } });
    }
  }
  try {
    const result = parseCandidateResult(await callMiniMaxMedia(env, content), duration);
    return json({ ...result, analysis: { mode: mode === "video" ? "native_video" : "sampled_frames", model: env.MINIMAX_MODEL || "MiniMax-M3", duration_seconds: duration, candidate_count: result.candidates.length } });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "视频分析失败" }, 502);
  }
}

async function repairModelJson(env, malformed) {
  const system = `你是 JSON 修复器。只返回有效 JSON，不要解释。不要增加事实。修复标点和被截断的末尾。必须使用这个短格式：{"m":"pre或post","s":"complete或partial或needs_input","l":"课程名","u":"摘要","t":[["教具","目标","活动","依据位置"]],"d":[["维度id","状态","结论","依据位置"]],"a":[["优先级","维度id","教具","问题","行动","修改位置","下次观察","依据位置"]],"q":["追问"],"x":["限制"]}。d 保留 alignment、adequacy、outcomes、innovation_feedback、awards 五项；无法恢复的数组用 []。`;
  const user = `请修复下面的评估结果，并尽量保留已有内容：\n${String(malformed || "").slice(0, 18000)}`;
  return callMiniMax(env, [{ role: "system", content: system }, { role: "user", content: user }], 0.1);
}

async function evaluate(request, env) {
  if (!env.MINIMAX_API_KEY) return json({ error: "评估服务尚未配置模型密钥" }, 503);
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const now = Date.now(), recent = (rateBuckets.get(ip) || []).filter(t => now - t < 10 * 60 * 1000);
  if (recent.length >= 10) return json({ error: "请求较频繁，请十分钟后再试" }, 429);
  recent.push(now); rateBuckets.set(ip, recent);
  const form = await request.formData();
  const mode = form.get("mode") === "post" ? "post" : "pre";
  const description = String(form.get("description") || "").slice(0, 12000);
  const files = form.getAll("files").filter(x => typeof x !== "string");
  if (!files.length && !description.trim()) return json({ error: "请上传教案或填写教学材料说明" }, 400);
  const total = files.reduce((n, f) => n + f.size, 0);
  if (total > 15 * 1024 * 1024) return json({ error: "文件总大小请控制在 15MB 以内" }, 413);
  const materials = [], limitations = [];
  for (const file of files) {
    try {
      const text = await extractFile(file);
      if (text == null) limitations.push(`${file.name}：当前 MiniMax 文本接口不能直接读取该格式，请补充文字描述或转换为 DOCX/PPTX/TXT。`);
      else if (text.trim()) materials.push(`[SOURCE: ${file.name}]\n${text.slice(0, 80000)}`);
      else limitations.push(`${file.name}：未提取到可读文字。`);
    } catch (error) { limitations.push(`${file.name}：${error instanceof Error ? error.message : "解析失败"}`); }
  }
  let bodyText = materials.join("\n\n");
  if (bodyText.length > 150000) { bodyText = bodyText.slice(0, 150000); limitations.push("材料文字较长，本次仅分析前 150000 个字符。"); }
  if (!bodyText && !description.trim()) return json({ error: limitations.join("；") || "没有可供模型分析的文字" }, 422);
  const skill = mode === "post" ? POST_SKILL : PRE_SKILL;
  const system = `${skill}\n\n不要输出 JSON、Markdown、代码围栏或思考过程。只按下面的逐行格式输出，字段之间必须使用一个 TAB 制表符，字段内容中不得出现 TAB 或换行：\nMETA<TAB>pre或post<TAB>complete或partial或needs_input<TAB>课程名\nSUMMARY<TAB>100字内摘要\nTOOL<TAB>教具名<TAB>目标<TAB>活动<TAB>依据位置\nDIM<TAB>维度id<TAB>状态<TAB>80字内结论<TAB>依据位置\nSUG<TAB>优先级<TAB>维度id<TAB>教具<TAB>问题<TAB>行动<TAB>修改位置<TAB>下次观察<TAB>依据位置\nQ<TAB>追问\nLIMIT<TAB>限制\nDIM 必须依次输出 alignment、adequacy、outcomes、innovation_feedback、awards 五行；状态只能是 supported、mixed、concern、unknown、not_applicable。TOOL 最多8行，SUG 最多4行，Q 最多3行，LIMIT 最多3行。依据位置只能来自材料，未知写“未提供”，不得编造页码。输出时用真实制表符替换示例中的 <TAB>。`;
  const user = `评估阶段：${mode === "post" ? "课后" : "课前"}\n教师补充描述：${description || "未提供"}\n解析限制：${limitations.join("；") || "无"}\n\n材料正文：\n${bodyText || "未提取到附件正文，仅依据教师描述。"}`;
  let content;
  try {
    content = await callMiniMax(env, [{ role: "system", content: system }, { role: "user", content: user }]);
    const result = parseModelResult(content, mode);
    result.limitations = [...new Set([...(result.limitations || []), ...limitations])];
    return json(result);
  } catch (error) {
    const message = error instanceof Error && error.message.startsWith("MiniMax 接口") ? error.message : "AI 已完成分析，但报告格式仍不完整，请重新提交一次。";
    return json({ error: message }, 502);
  }
}

const CLASSROOM_TYPES = new Set(["instruction", "response", "engagement", "avoidance", "operation", "generalization", "emotion"]);
const CLASSROOM_PHASES = new Set(["baseline", "tool_use", "generalization"]);
const ASSISTANCE_WEIGHT = { independent: 1, gesture: 0.8, verbal: 0.65, model: 0.45, physical: 0.2, none: 0 };
const CLASSROOM_CRITERIA = {
  B1: "使用教具后学生注意力、主动参与行为变化；回避、抗拒教具的发生频次",
  B2: "借助教具，学生是否更容易理解概念、听懂课堂指令，降低理解难度",
  B3: "基础、发展、提高不同能力层级学生能否独立或在辅助下完成操作，并支持小步骤分层教学",
  B4: "学生借助教具习得的技能能否迁移到本主题其他活动或生活实景",
  B5: "教具使用过程中是否诱发可观察的情绪行为问题，或具有安抚、稳定的正向作用"
};

const MODULE_A_CRITERIA = {
  A1: { label: "主题与目标匹配", criterion: "教具完全服务本主题，紧扣认知、语言、社交、生活技能三维目标，不偏离主题" },
  A2: { label: "孤独症认知适配", criterion: "契合低年段 ASD 特点：具象思维主导、视觉加工优势，规避过于抽象、符号化的设计" },
  A3: { label: "具象化多感官设计", criterion: "支持视觉、触觉、听觉至少 2 种及以上感官输入；有实物 / 模拟情境，不是单纯图片卡片" },
  A4: { label: "安全风险预判", criterion: "无吞咽小零件、无尖锐边角、材质安全；可消毒；可预判学生情绪冲动下的投掷、撕毁风险" },
  A5: { label: "课堂实操可行性", criterion: "数量可满足分组 / 个体使用；结构清晰有视觉提示；便于收纳，适合特教课堂常态化使用" }
};

function parseModuleAResult(content, sourceNames, model) {
  const cleaned = String(content || "").replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
  const start = cleaned.indexOf("{"), end = cleaned.lastIndexOf("}");
  let raw = null;
  if (start >= 0 && end > start) {
    try { raw = JSON.parse(cleaned.slice(start, end + 1)); }
    catch {
      try { raw = JSON.parse(escapeControlsInStrings(cleaned.slice(start, end + 1)).replace(/,\s*([}\]])/g, "$1")); } catch {}
    }
  }
  if (!raw) {
    raw = { summary: "", dimensions: [] };
    for (const line of cleaned.split(/\r?\n/)) {
      let parts = line.trim().replace(/^[-*]\s*/, "").split("\t").map(value => value.trim());
      if (parts.length < 2 && line.includes("|")) parts = line.split("|").map(value => value.trim()).filter(Boolean);
      const type = String(parts.shift() || "").toUpperCase();
      if (type === "SUMMARY") raw.summary = parts.join(" ");
      else if (type === "A" && /^A[1-5]$/.test(String(parts[0] || "").toUpperCase())) raw.dimensions.push({ id: parts[0], score: parts[1], status: parts[2], evidence: parts[3], modification: parts.slice(4).join(" ") });
      else if (/^A[1-5]$/.test(type)) raw.dimensions.push({ id: type, score: parts[0], status: parts[1], evidence: parts[2], modification: parts.slice(3).join(" ") });
    }
  }
  if (!Array.isArray(raw.dimensions) || !raw.dimensions.length) throw new Error("模型没有返回可读取的模块 A 结果");
  const byId = new Map((Array.isArray(raw.dimensions) ? raw.dimensions : []).map(item => [String(item?.id || "").toUpperCase(), item]));
  const dimensions = Object.entries(MODULE_A_CRITERIA).map(([id, definition]) => {
    const item = byId.get(id) || {}, numeric = Number(item.score);
    let score = Number.isInteger(numeric) && numeric >= 1 && numeric <= 5 ? numeric : null;
    const evidence = String(item.evidence || "").trim().slice(0, 1200);
    if (!evidence) score = null;
    const status = ["supported", "mixed", "concern", "unknown"].includes(item.status) ? item.status : score == null ? "unknown" : score >= 4 ? "supported" : score === 3 ? "mixed" : "concern";
    return { id, ...definition, weight: 8, max_score: 5, score, status, evidence: evidence || "现有材料不足，AI 无法形成可核对的客观证据。", modification: String(item.modification || (score == null ? "请补充能直接反映该指标的教案内容、教具说明或实物照片后重新评估。" : "")).trim().slice(0, 800), weighted_score: score == null ? null : Math.round(score / 5 * 8 * 10) / 10 };
  });
  const complete = dimensions.every(item => item.score != null), observed = Math.round(dimensions.reduce((sum, item) => sum + (item.weighted_score || 0), 0) * 10) / 10;
  return {
    version: "1.0", kind: "preclass_adaptation", status: complete ? "complete" : "partial",
    summary: String(raw.summary || (complete ? "AI 已按模块 A 量表完成五项评估。" : "AI 已完成材料核查，部分项目需要补充直接证据。 ")).trim().slice(0, 500),
    dimensions, module_a_score: complete ? observed : null, observed_weighted_score: observed,
    scored_weight: dimensions.filter(item => item.score != null).length * 8,
    audit: { model, generated_at: new Date().toISOString(), source_files: sourceNames, safety_veto: dimensions.find(item => item.id === "A4")?.score === 1 }
  };
}

async function evaluateModuleA(request, env) {
  if (!env.MINIMAX_API_KEY) return json({ error: "尚未配置 MiniMax 模型密钥" }, 503);
  const form = await request.formData(), description = String(form.get("description") || "").slice(0, 12000);
  let basic = {};
  try { basic = JSON.parse(String(form.get("basic") || "{}")); } catch { basic = {}; }
  const files = form.getAll("files").filter(item => typeof item !== "string"), total = files.reduce((sum, file) => sum + file.size, 0);
  if (!files.length && !description.trim()) return json({ error: "请上传教案、教具说明或实物照片，或填写材料说明" }, 400);
  if (total > 18 * 1024 * 1024) return json({ error: "模块 A 材料总大小请控制在 18MB 以内" }, 413);
  const textMaterials = [], imageFiles = [], limitations = [];
  for (const file of files) {
    if (["image/jpeg", "image/png", "image/webp"].includes(file.type)) { imageFiles.push(file); continue; }
    try {
      const extracted = await extractFile(file);
      if (extracted?.trim()) textMaterials.push(`[SOURCE: ${file.name}]\n${extracted.slice(0, 60000)}`);
      else limitations.push(`${file.name}：未提取到可读文字`);
    } catch (error) { limitations.push(`${file.name}：${error instanceof Error ? error.message : "解析失败"}`); }
  }
  const rubric = Object.entries(MODULE_A_CRITERIA).map(([id, item]) => `${id} ${item.label}：${item.criterion}`).join("\n");
  const prompt = `你是孤独症儿童主题式教学教具学具评估助手。请只依据提供的课前材料，严格按照以下模块 A 量表逐项评分，不得编造。\n${rubric}\n评分锚点：5完全达成且可示范；4基本达成仅少量微调；3大体达成但有明显不足；2达成度低需大幅调整；1完全不达标或存在安全风险/严重不适配。每项权重8%。每个有分数的项目必须给出材料中可核对的客观证据，包含文件名及具体内容位置或图片事实；证据不足时分数写 null。A4 必须核查小零件、尖角、材质、消毒、投掷撕毁风险；不能仅凭教案未提及安全问题就给高分。不要输出 JSON、Markdown、代码围栏或思考过程。只按下面六行格式输出，字段之间使用真实 TAB 制表符，字段内容中不得换行：\nSUMMARY<TAB>120字内总体结论\nA<TAB>A1<TAB>1到5或null<TAB>supported|mixed|concern|unknown<TAB>客观证据<TAB>修改意见\nA<TAB>A2<TAB>1到5或null<TAB>supported|mixed|concern|unknown<TAB>客观证据<TAB>修改意见\nA<TAB>A3<TAB>1到5或null<TAB>supported|mixed|concern|unknown<TAB>客观证据<TAB>修改意见\nA<TAB>A4<TAB>1到5或null<TAB>supported|mixed|concern|unknown<TAB>客观证据<TAB>修改意见\nA<TAB>A5<TAB>1到5或null<TAB>supported|mixed|concern|unknown<TAB>客观证据<TAB>修改意见\n输出时用真实制表符替换 <TAB>。\n基础信息：${JSON.stringify({ tool_name: basic.tool_name || "", themes: basic.themes || [], goals: basic.goals || "", class_name: basic.class_name || "", presentations: basic.presentations || [] })}\n补充说明：${description || "未提供"}\n解析限制：${limitations.join("；") || "无"}\n材料正文：\n${textMaterials.join("\n\n").slice(0, 140000) || "无文字材料；请结合随后提供的图片。"}`;
  const content = [{ type: "text", text: prompt }];
  for (const image of imageFiles.slice(0, 10)) content.push({ type: "text", text: `[实物或材料图片：${image.name}]` }, { type: "image", source: { type: "base64", media_type: image.type, data: bytesToBase64(await image.arrayBuffer()) } });
  try {
    const output = imageFiles.length ? await callMiniMaxMedia(env, content) : await callMiniMax(env, [{ role: "user", content: prompt }], 0.1);
    let result;
    try { result = parseModuleAResult(output, files.map(file => file.name), env.MINIMAX_MODEL || "MiniMax-M3"); }
    catch {
      const repair = `把下面的模块 A 评估内容整理成六行 TAB 分隔文本。不得增加事实。只输出 SUMMARY 行和 A1 至 A5 五行；格式为 A<TAB>编号<TAB>1到5或null<TAB>supported|mixed|concern|unknown<TAB>客观证据<TAB>修改意见。\n\n原始内容：\n${String(output || "").slice(0, 18000)}`;
      result = parseModuleAResult(await callMiniMax(env, [{ role: "user", content: repair }], 0.05), files.map(file => file.name), env.MINIMAX_MODEL || "MiniMax-M3");
    }
    return json(result);
  } catch (error) { return json({ error: error instanceof Error ? error.message : "模块 A AI 评估失败" }, 502); }
}

function clampScore(value) { return Math.max(1, Math.min(5, Math.round(value))); }
function clampRatio(value) { return Math.max(0, Math.min(1, value)); }
function ratio(items, predicate) { return items.length ? items.filter(predicate).length / items.length : null; }
function scoreFromRatio(value) { return value == null ? null : clampScore(1 + value * 4); }
function average(items, mapper) { return items.length ? items.reduce((sum, item) => sum + mapper(item), 0) / items.length : null; }
function timeLabel(seconds) {
  const value = Math.max(0, Number(seconds) || 0), minutes = Math.floor(value / 60), rest = Math.floor(value % 60);
  return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}
function evidenceFor(events) {
  return events.slice(0, 8).map(event => ({
    event_id: event.id,
    time: `${timeLabel(event.start_seconds)}-${timeLabel(event.end_seconds ?? event.start_seconds)}`,
    student_id: event.student_id,
    observation: event.note || `${event.type}：${event.outcome}`,
    confidence: event.confidence
  }));
}
function evidenceConfidence(events, preferredCount = 3) {
  if (events.length >= preferredCount && events.filter(event => event.confidence === "low").length <= Math.floor(events.length / 3)) return "high";
  if (events.length >= 2) return "medium";
  return "low";
}
function weightedScore(score) { return score == null ? null : Math.round(score / 5 * 12 * 10) / 10; }
function dimension(id, label, score, finding, events, modification, preferredCount = 3) {
  const noEvidence = score == null, finalScore = noEvidence ? 0 : score;
  return {
    id, label, criterion: CLASSROOM_CRITERIA[id], weight: 12, max_score: 5, score: finalScore, weighted_score: weightedScore(finalScore),
    status: noEvidence ? "insufficient_evidence" : score >= 4 ? "supported" : score >= 3 ? "mixed" : "concern",
    finding, modification, confidence: evidenceConfidence(events, preferredCount), evidence: evidenceFor(events)
  };
}
function outcomePerformance(event, useAssistance = false) {
  const outcome = event.outcome === "positive" ? 1 : event.outcome === "neutral" ? 0.5 : 0;
  if (!useAssistance || event.outcome !== "positive") return outcome;
  const assistance = event.assistance === "none" ? 0.6 : ASSISTANCE_WEIGHT[event.assistance];
  return outcome * assistance;
}

function buildClassroomReport(payload) {
  const lesson = String(payload?.lesson?.name || "未命名课程").slice(0, 100);
  const students = Array.isArray(payload?.students) ? payload.students.slice(0, 3) : [];
  const rawEvents = Array.isArray(payload?.events) ? payload.events.slice(0, 500) : [];
  const events = rawEvents.filter(event => event && event.confirmed !== false && CLASSROOM_TYPES.has(event.type) && CLASSROOM_PHASES.has(event.phase)).map((event, index) => ({
    id: String(event.id || `E${index + 1}`), type: event.type, phase: event.phase,
    student_id: String(event.student_id || "全班").slice(0, 20), outcome: ["positive", "negative", "neutral"].includes(event.outcome) ? event.outcome : "neutral",
    assistance: Object.hasOwn(ASSISTANCE_WEIGHT, event.assistance) ? event.assistance : "none",
    start_seconds: Math.max(0, Number(event.start_seconds) || 0), end_seconds: Math.max(0, Number(event.end_seconds) || Number(event.start_seconds) || 0),
    latency_seconds: event.latency_seconds === "" || event.latency_seconds == null ? null : Math.max(0, Number(event.latency_seconds)),
    confidence: ["high", "medium", "low"].includes(event.confidence) ? event.confidence : "medium", note: String(event.note || "").slice(0, 300)
  }));
  const baselineParticipation = events.filter(e => e.phase === "baseline" && ["response", "engagement", "avoidance", "operation"].includes(e.type));
  const toolParticipation = events.filter(e => e.phase === "tool_use" && ["response", "engagement", "avoidance", "operation"].includes(e.type));
  const participationPerformance = list => average(list, e => e.type === "avoidance" ? (e.outcome === "positive" ? 0.5 : 0) : outcomePerformance(e));
  const baselineParticipationRate = participationPerformance(baselineParticipation);
  const toolParticipationRate = participationPerformance(toolParticipation);
  const b1Delta = baselineParticipationRate == null || toolParticipationRate == null ? null : toolParticipationRate - baselineParticipationRate;
  const b1Ratio = toolParticipationRate == null ? null : b1Delta == null ? toolParticipationRate : clampRatio(toolParticipationRate * 0.75 + clampRatio(0.5 + b1Delta) * 0.25);
  const b1Score = scoreFromRatio(b1Ratio);

  const responses = events.filter(e => e.phase === "tool_use" && ["response", "operation"].includes(e.type));
  const responsePerformance = average(responses, e => outcomePerformance(e, true));
  const responseSuccess = ratio(responses, e => e.outcome === "positive");
  const latencyKnown = responses.filter(e => e.latency_seconds != null);
  const latencyNote = latencyKnown.length ? `，已记录 ${latencyKnown.length} 次反应时长` : "，未记录反应时长";
  const b2Score = scoreFromRatio(responsePerformance);

  const operations = events.filter(e => e.phase === "tool_use" && e.type === "operation");
  const operationPerformance = average(operations, e => outcomePerformance(e, true));
  const coveredStudents = new Set(operations.map(e => e.student_id));
  const expectedStudents = new Set(students.map(s => String(s.id || "")).filter(Boolean));
  const coverage = expectedStudents.size ? [...expectedStudents].filter(id => coveredStudents.has(id)).length / expectedStudents.size : null;
  const b3Ratio = operationPerformance == null ? null : operationPerformance * (coverage == null ? 1 : 0.85 + coverage * 0.15);
  const b3Score = scoreFromRatio(b3Ratio);

  const generalization = events.filter(e => e.phase === "generalization" && ["generalization", "response", "operation"].includes(e.type));
  const generalizationPerformance = average(generalization, e => outcomePerformance(e, true));
  const generalizationSuccess = ratio(generalization, e => e.outcome === "positive");
  const b4Score = scoreFromRatio(generalizationPerformance);

  const negativeTypes = ["avoidance", "emotion"];
  const baseEmotion = events.filter(e => e.phase === "baseline" && negativeTypes.includes(e.type));
  const toolEmotion = events.filter(e => e.phase === "tool_use" && negativeTypes.includes(e.type));
  const baseNegative = ratio(baseEmotion, e => e.outcome === "negative");
  const toolNegative = ratio(toolEmotion, e => e.outcome === "negative");
  const toolEmotionPerformance = average(toolEmotion, e => e.outcome === "negative" ? 0 : e.outcome === "neutral" ? 0.75 : 1);
  const b5Delta = baseNegative == null || toolNegative == null ? null : baseNegative - toolNegative;
  const b5Ratio = toolEmotionPerformance == null ? null : b5Delta == null ? toolEmotionPerformance : clampRatio(toolEmotionPerformance * 0.75 + clampRatio(0.5 + b5Delta) * 0.25);
  const b5Score = scoreFromRatio(b5Ratio);

  const dimensions = [
    dimension("B1", "课堂参与表现", b1Score, toolParticipation.length ? (b1Delta == null ? `记录到 ${toolParticipation.length} 条教具使用中的参与证据，表现值为 ${(toolParticipationRate * 100).toFixed(0)}%；缺少使用前基准，本项按本次课堂表现评分。` : `记录到使用前 ${baselineParticipation.length} 条、使用中 ${toolParticipation.length} 条参与证据，表现值变化 ${b1Delta >= 0 ? "+" : ""}${(b1Delta * 100).toFixed(0)} 个百分点。`) : "未确认教具使用中的参与、反应、操作或回避事实，本项暂不评分。", [...baselineParticipation, ...toolParticipation], toolParticipation.length ? (b1Delta == null ? "下次补录使用前基准，并继续记录主动参与和回避频次。" : b1Score < 4 ? "调整教具呈现和轮次安排，下次复核主动参与与回避变化。" : "保留当前呈现方式，并在后续课次复核参与表现是否稳定。") : "补充至少一条教具使用中的参与或回避客观记录。", 3),
    dimension("B2", "学习理解支持", b2Score, responses.length ? `记录到 ${responses.length} 次指令后反应或操作，正确完成比例为 ${(responseSuccess * 100).toFixed(0)}%${latencyNote}；评分同时考虑完成结果与辅助程度。` : "未确认指令后的学生反应或操作，本项暂不评分。", responses, responses.length ? (b2Score < 4 ? "把指令拆成更小步骤并优化视觉提示，下次记录正确率、提示等级和反应时长。" : "保留当前提示方式，并增加不同指令下的反应样本。") : "补充至少一条教师指令后的学生反应或操作记录。", 3),
    dimension("B3", "操作与分层适配", b3Score, operations.length ? `记录到 ${operations.length} 次教具操作；${coverage == null ? "未设置重点学生层级" : `覆盖 ${(coverage * 100).toFixed(0)}% 的已选学生`}，评分结合完成结果、辅助等级和覆盖情况。` : "未确认学生操作教具的事实，本项暂不评分。", operations, operations.length ? (b3Score < 4 ? "按学生层级简化步骤或增加视觉、手势提示，并补齐未覆盖学生的操作记录。" : "保留当前分层设计，并在更多学生和任务轮次中复核独立完成度。") : "补充至少一条带完成结果和辅助等级的教具操作记录。", 3),
    dimension("B4", "技能习得与泛化", b4Score, generalization.length ? `在更换材料、场景或延迟任务中记录 ${generalization.length} 次迁移机会，成功比例为 ${(generalizationSuccess * 100).toFixed(0)}%；评分同时考虑辅助程度。` : "未确认更换材料、场景或延迟任务后的迁移表现；重复原任务不作为泛化证据。", generalization, generalization.length ? (b4Score < 4 ? "增加不同材料或生活情境的迁移练习，并记录是否独立完成。" : "继续在不同场景复核技能能否稳定迁移。") : "补充至少一条真实迁移任务中的表现记录。", 2),
    dimension("B5", "情绪行为影响", b5Score, toolEmotion.length ? (b5Delta == null ? `记录到 ${toolEmotion.length} 条教具使用中的可观察情绪或回避行为；缺少使用前基准，本项按本次课堂表现评分。` : `记录到使用前 ${baseEmotion.length} 条、使用中 ${toolEmotion.length} 条情绪或回避证据，负向事件比例${b5Delta >= 0 ? "下降或持平" : "上升"}。`) : "未确认教具使用中的可观察情绪或回避行为，本项暂不评分；不能用面部表情推测内心情绪。", [...baseEmotion, ...toolEmotion], toolEmotion.length ? (b5Score < 4 ? "调整刺激强度、等待时间或替代选择，下次记录行为发生频次与持续时间。" : "保留当前支持方式，并继续观察情绪稳定性。") : "补充至少一条教具使用中的可观察情绪或回避行为记录。", 2)
  ];
  const evidenced = dimensions.filter(item => item.status !== "insufficient_evidence"), missing = dimensions.filter(item => item.status === "insufficient_evidence");
  const scoredWeight = evidenced.reduce((sum, item) => sum + item.weight, 0);
  const observedWeightedScore = Math.round(dimensions.reduce((sum, item) => sum + item.weighted_score, 0) * 10) / 10;
  const moduleScore = observedWeightedScore;
  const suggestions = dimensions.filter(item => item.status === "insufficient_evidence" || item.score < 4).map(item => ({ dimension_id: item.id, priority: item.status === "insufficient_evidence" ? "evidence" : item.score <= 2 ? "high" : "medium", action: item.modification })).slice(0, 5);
  return {
    version: "1.1", kind: "classroom_implementation", lesson, generated_at: new Date().toISOString(),
    status: evidenced.length === 5 ? "complete" : evidenced.length ? "partial" : "needs_more_evidence",
    summary: evidenced.length ? `已依据 ${events.length} 条教师确认事件，对 ${evidenced.length} 个维度按量表给出 1-5 分；${missing.length ? `另有 ${missing.length} 个维度没有直接证据，按 0 分计入模块总分。` : "五个维度均有直接证据。"}` : "当前事件与 B1 至 B5 均未形成直接对应，五个维度均按 0 分计入模块总分。",
    dimensions, module_b_score: moduleScore, observed_weighted_score: observedWeightedScore, scored_weight: scoredWeight,
    score_note: missing.length ? `模块 B 总分为 ${moduleScore}/60；${missing.map(item => item.id).join("、")} 没有直接证据，按 0 分计入。0 分表示未取得证据，不等同于已观察到不合格表现。` : "五个维度均按 1-5 分评分，每项按 12 分折算，模块 B 满分 60 分；正式结论须由评估人复核确认。",
    event_count: events.length, students, suggestions,
    audit: {
      rule_version: "classroom-b-v2", confirmed_event_ids: events.map(e => e.id),
      video_uploaded: payload?.video_analysis?.mode === "native_video",
      ai_analysis_used: Boolean(payload?.video_analysis?.used),
      analysis_mode: payload?.video_analysis?.mode || "manual",
      analysis_model: payload?.video_analysis?.model || null,
      candidate_count: Math.max(0, Number(payload?.video_analysis?.candidate_count) || 0),
      confirmed_ai_event_ids: events.filter(e => String(e.id).startsWith("AI")).map(e => e.id)
    }
  };
}

function xmlEscape(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char]);
}
function excelCell(ref, value, style = 3, formula = null) {
  if (formula) return `<c r="${ref}" s="${style}"><f>${xmlEscape(formula)}</f>${value == null ? "" : `<v>${Number(value)}</v>`}</c>`;
  if (value == null || value === "") return `<c r="${ref}" s="${style}"/>`;
  if (typeof value === "number") return `<c r="${ref}" s="${style}"><v>${value}</v></c>`;
  return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;
}
function excelRow(index, cells, height = null) {
  return `<row r="${index}"${height ? ` ht="${height}" customHeight="1"` : ""}>${cells.join("")}</row>`;
}
function worksheetXml(rows, widths, merges = [], freezeRow = 0) {
  const cols = widths.map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`).join("");
  const pane = freezeRow ? `<sheetViews><sheetView workbookViewId="0" showGridLines="0"><pane ySplit="${freezeRow}" topLeftCell="A${freezeRow + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` : '<sheetViews><sheetView workbookViewId="0" showGridLines="0"/></sheetViews>';
  const mergeXml = merges.length ? `<mergeCells count="${merges.length}">${merges.map(ref => `<mergeCell ref="${ref}"/>`).join("")}</mergeCells>` : "";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${pane}<sheetFormatPr defaultRowHeight="18"/><cols>${cols}</cols><sheetData>${rows.join("")}</sheetData>${mergeXml}<pageMargins left="0.3" right="0.3" top="0.5" bottom="0.5" header="0.2" footer="0.2"/><pageSetup orientation="landscape" fitToWidth="1" fitToHeight="0"/></worksheet>`;
}
function uint16(value) { return new Uint8Array([value & 255, value >>> 8 & 255]); }
function uint32(value) { return new Uint8Array([value & 255, value >>> 8 & 255, value >>> 16 & 255, value >>> 24 & 255]); }
function joinBytes(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0), output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.length; }
  return output;
}
let crcTable;
function crc32(bytes) {
  if (!crcTable) crcTable = Array.from({ length: 256 }, (_, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1;
    return value >>> 0;
  });
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ crc >>> 8;
  return (crc ^ 0xffffffff) >>> 0;
}
function zipFiles(files) {
  const encoder = new TextEncoder(), locals = [], centrals = [];
  let offset = 0;
  const now = new Date(), dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1), dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const [name, content] of Object.entries(files)) {
    const filename = encoder.encode(name), data = typeof content === "string" ? encoder.encode(content) : content, crc = crc32(data);
    const local = joinBytes([uint32(0x04034b50), uint16(20), uint16(0x0800), uint16(0), uint16(dosTime), uint16(dosDate), uint32(crc), uint32(data.length), uint32(data.length), uint16(filename.length), uint16(0), filename, data]);
    locals.push(local);
    centrals.push(joinBytes([uint32(0x02014b50), uint16(20), uint16(20), uint16(0x0800), uint16(0), uint16(dosTime), uint16(dosDate), uint32(crc), uint32(data.length), uint32(data.length), uint16(filename.length), uint16(0), uint16(0), uint16(0), uint16(0), uint32(0), uint32(offset), filename]));
    offset += local.length;
  }
  const central = joinBytes(centrals), local = joinBytes(locals);
  const end = joinBytes([uint32(0x06054b50), uint16(0), uint16(0), uint16(centrals.length), uint16(centrals.length), uint32(central.length), uint32(local.length), uint16(0)]);
  return joinBytes([local, central, end]);
}
function buildClassroomWorkbook(payload, report) {
  const phaseLabels = { baseline: "使用前基准", tool_use: "使用教具中", generalization: "迁移任务" };
  const typeLabels = { instruction: "教师指令", response: "学生反应", engagement: "参与行为", avoidance: "回避行为", operation: "教具操作", generalization: "迁移表现", emotion: "可观察情绪行为" };
  const outcomeLabels = { positive: "正确或积极", neutral: "中性事实", negative: "错误或负向" };
  const assistanceLabels = { independent: "独立完成", gesture: "手势提示", verbal: "语言提示", model: "示范提示", physical: "身体辅助", none: "不适用" };
  const statusLabels = { complete: "五项已评分", partial: "部分维度待补证", needs_more_evidence: "需要补充证据" };
  const rows = [
    excelRow(1, [excelCell("A1", "模块 B 课堂实施效果评估", 1)], 28),
    excelRow(2, [excelCell("A2", "课程名称", 7), excelCell("B2", report.lesson, 3)]),
    excelRow(3, [excelCell("A3", "生成时间", 7), excelCell("B3", report.generated_at, 3), excelCell("D3", "评估状态", 7), excelCell("E3", statusLabels[report.status], 3)]),
    excelRow(5, ["序号", "评估维度", "评估指标描述", "权重 / %", "评分 / 1-5", "客观证据记录", "修改意见", "加权得分"].map((value, index) => excelCell(`${String.fromCharCode(65 + index)}5`, value, 2)), 30)
  ];
  report.dimensions.forEach((item, index) => {
    const row = 6 + index;
    const evidence = item.evidence.length ? item.evidence.map(entry => `${entry.time} ${entry.student_id} ${entry.observation}`).join("；") : item.finding;
    rows.push(excelRow(row, [
      excelCell(`A${row}`, item.id, 4), excelCell(`B${row}`, item.label, 3), excelCell(`C${row}`, item.criterion, 3), excelCell(`D${row}`, item.weight, 4),
      excelCell(`E${row}`, item.score, 4), excelCell(`F${row}`, evidence, 3), excelCell(`G${row}`, item.modification, 3),
      excelCell(`H${row}`, item.weighted_score, 5, `IF(E${row}="","",E${row}/5*D${row})`)
    ], 66));
  });
  const evidencedCount = report.dimensions.filter(item => item.status !== "insufficient_evidence").length, zeroEvidenceIds = report.dimensions.filter(item => item.status === "insufficient_evidence").map(item => item.id);
  rows.push(excelRow(11, [excelCell("A11", "模块 B 总分", 6), excelCell("D11", 60, 6), excelCell("E11", `${evidencedCount}/5 项有证据`, 6), excelCell("F11", report.summary, 6), excelCell("G11", zeroEvidenceIds.length ? `${zeroEvidenceIds.join("、")} 无证据按 0 分计` : "请由评估人复核确认", 6), excelCell("H11", report.module_b_score, 6, "SUM(H6:H10)")], 28));
  rows.push(excelRow(13, [excelCell("A13", "评分说明", 7), excelCell("B13", report.score_note, 3)], 42));
  const reportSheet = worksheetXml(rows, [9, 18, 36, 11, 12, 48, 42, 14], ["A1:H1", "B2:H2", "B3:C3", "E3:H3", "A11:C11", "B13:H13"], 5);

  const rawEvents = (Array.isArray(payload.events) ? payload.events : []).filter(event => event && event.confirmed !== false);
  const evidenceRows = [
    excelRow(1, [excelCell("A1", "课堂客观证据记录", 1)], 28),
    excelRow(3, ["事件编号", "开始时间", "结束时间", "阶段", "事件类型", "学生", "结果", "辅助程度", "客观事实", "置信度"].map((value, index) => excelCell(`${String.fromCharCode(65 + index)}3`, value, 2)), 30)
  ];
  rawEvents.forEach((event, index) => {
    const row = 4 + index;
    const values = [event.id || `E${index + 1}`, timeLabel(event.start_seconds), timeLabel(event.end_seconds ?? event.start_seconds), phaseLabels[event.phase] || event.phase, typeLabels[event.type] || event.type, event.student_id || "全班", outcomeLabels[event.outcome] || event.outcome, assistanceLabels[event.assistance] || event.assistance, event.note || "", event.confidence || "medium"];
    evidenceRows.push(excelRow(row, values.map((value, column) => excelCell(`${String.fromCharCode(65 + column)}${row}`, value, column === 8 ? 3 : 4)), 34));
  });
  const evidenceSheet = worksheetXml(evidenceRows, [14, 12, 12, 16, 17, 12, 14, 14, 58, 12], ["A1:J1"], 3);
  const generated = xmlEscape(report.generated_at);
  const files = {
    "[Content_Types].xml": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>',
    "_rels/.rels": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>',
    "xl/workbook.xml": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="模块B评估" sheetId="1" r:id="rId1"/><sheet name="课堂证据" sheetId="2" r:id="rId2"/></sheets><calcPr fullCalcOnLoad="1" forceFullCalc="1"/></workbook>',
    "xl/_rels/workbook.xml.rels": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
    "xl/styles.xml": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="0.0"/></numFmts><fonts count="4"><font><sz val="10"/><name val="Microsoft YaHei"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="10"/><name val="Microsoft YaHei"/></font><font><b/><sz val="16"/><name val="Microsoft YaHei"/></font><font><b/><sz val="10"/><name val="Microsoft YaHei"/></font></fonts><fills count="5"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF315FAA"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE9F0FB"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF3F6FA"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FFD9D9D9"/></left><right style="thin"><color rgb="FFD9D9D9"/></right><top style="thin"><color rgb="FFD9D9D9"/></top><bottom style="thin"><color rgb="FFD9D9D9"/></bottom><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="8"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="center"/></xf><xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf><xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="164" fontId="3" fillId="3" borderId="1" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="3" fillId="4" borderId="1" xfId="0" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>',
    "xl/worksheets/sheet1.xml": reportSheet,
    "xl/worksheets/sheet2.xml": evidenceSheet,
    "docProps/core.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>模块 B 课堂实施效果评估</dc:title><dc:creator>教学评估工具</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${generated}</dcterms:created></cp:coreProperties>`,
    "docProps/app.xml": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>教学评估工具</Application></Properties>'
  };
  return zipFiles(files);
}

const EVALUATION_A_ITEMS = [
  { id: "A1", label: "主题与目标匹配", criterion: "教具完全服务本主题，紧扣认知、语言、社交、生活技能三维目标，不偏离主题", weight: 8 },
  { id: "A2", label: "孤独症认知适配", criterion: "契合低年段 ASD 特点：具象思维主导、视觉加工优势，规避过于抽象、符号化的设计", weight: 8 },
  { id: "A3", label: "具象化多感官设计", criterion: "支持视觉、触觉、听觉至少 2 种及以上感官输入；有实物 / 模拟情境，不是单纯图片卡片", weight: 8 },
  { id: "A4", label: "安全风险预判", criterion: "无吞咽小零件、无尖锐边角、材质安全；可消毒；可预判学生情绪冲动下的投掷、撕毁风险", weight: 8 },
  { id: "A5", label: "课堂实操可行性", criterion: "数量可满足分组 / 个体使用；结构清晰有视觉提示；便于收纳，适合特教课堂常态化使用", weight: 8 }
];
const EVALUATION_STYLES_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="0.0"/></numFmts><fonts count="4"><font><sz val="10"/><name val="Microsoft YaHei"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="10"/><name val="Microsoft YaHei"/></font><font><b/><sz val="16"/><name val="Microsoft YaHei"/></font><font><b/><sz val="10"/><name val="Microsoft YaHei"/></font></fonts><fills count="5"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF315FAA"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE9F0FB"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF3F6FA"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FFD9D9D9"/></left><right style="thin"><color rgb="FFD9D9D9"/></right><top style="thin"><color rgb="FFD9D9D9"/></top><bottom style="thin"><color rgb="FFD9D9D9"/></bottom><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="8"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="center"/></xf><xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf><xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="164" fontId="3" fillId="3" borderId="1" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="3" fillId="4" borderId="1" xfId="0" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';

function oneSheetWorkbook(name, title, sheetXml, generatedAt = new Date().toISOString()) {
  const generated = xmlEscape(generatedAt);
  return zipFiles({
    "[Content_Types].xml": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>',
    "_rels/.rels": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>',
    "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xmlEscape(name)}" sheetId="1" r:id="rId1"/></sheets><calcPr fullCalcOnLoad="1" forceFullCalc="1"/></workbook>`,
    "xl/_rels/workbook.xml.rels": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
    "xl/styles.xml": EVALUATION_STYLES_XML,
    "xl/worksheets/sheet1.xml": sheetXml,
    "docProps/core.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xmlEscape(title)}</dc:title><dc:creator>教学评估工具</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${generated}</dcterms:created></cp:coreProperties>`,
    "docProps/app.xml": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>教学评估工具</Application></Properties>'
  });
}

function evaluationCalculation(record) {
  const aRows = EVALUATION_A_ITEMS.map(item => {
    const value = record?.module_a?.[item.id] || {}, score = Number(value.score);
    const validScore = Number.isFinite(score) && score >= 1 && score <= 5 ? score : null;
    return { ...item, ...value, score: validScore, weighted_score: validScore == null ? null : Math.round(validScore / 5 * 8 * 10) / 10 };
  });
  const aComplete = aRows.every(item => item.score != null && String(item.evidence || "").trim());
  const aScore = Math.round(aRows.reduce((sum, item) => sum + (item.weighted_score || 0), 0) * 10) / 10;
  const bReport = record?.module_b?.report && Array.isArray(record.module_b.report.dimensions) ? record.module_b.report : null;
  const bScore = bReport?.module_b_score == null ? null : Number(bReport.module_b_score);
  const base = aComplete && Number.isFinite(bScore) ? Math.round((aScore + bScore) * 10) / 10 : null;
  const enteredCScore = Math.max(0, Math.min(10, Number(record?.module_c?.score) || 0));
  const cScore = enteredCScore === 0 || String(record?.module_c?.evidence || "").trim() ? enteredCScore : null;
  const finalScore = base == null ? null : Math.round((base + (cScore || 0)) * 10) / 10;
  const safetyVeto = aRows.find(item => item.id === "A4")?.score === 1;
  const grade = safetyVeto ? "不合格（A4 安全一票否决）" : finalScore == null ? "待完成模块 A 与模块 B" : finalScore >= 90 ? "优秀" : finalScore >= 80 ? "良好" : finalScore >= 70 ? "合格" : finalScore >= 60 ? "待改进" : "不合格";
  return { aRows, aComplete, aScore, bReport, bScore, base, cScore, finalScore, safetyVeto, grade };
}

function buildEvaluationWorkbook(record, module = "full") {
  const basic = record.basic || {}, calc = evaluationCalculation(record), rows = [], merges = [];
  let row = 1;
  const addTitle = title => { rows.push(excelRow(row, [excelCell(`A${row}`, title, 1)], 30)); merges.push(`A${row}:H${row}`); row += 2; };
  const addSection = title => { rows.push(excelRow(row, [excelCell(`A${row}`, title, 2)], 25)); merges.push(`A${row}:H${row}`); row += 1; };
  const addBasic = () => {
    addSection("一、基础信息");
    rows.push(excelRow(row, [excelCell(`A${row}`, "教具 / 学具名称", 7), excelCell(`B${row}`, basic.tool_name || "", 3)])); merges.push(`B${row}:H${row}`); row++;
    rows.push(excelRow(row, [excelCell(`A${row}`, "归属教学主题", 7), excelCell(`B${row}`, (basic.themes || []).join("、"), 3)])); merges.push(`B${row}:H${row}`); row++;
    rows.push(excelRow(row, [excelCell(`A${row}`, "对应课时教学目标", 7), excelCell(`B${row}`, basic.goals || "", 3)], 42)); merges.push(`B${row}:H${row}`); row++;
    rows.push(excelRow(row, [excelCell(`A${row}`, "授课教师", 7), excelCell(`B${row}`, basic.teacher || "", 3), excelCell(`C${row}`, "评估人", 7), excelCell(`D${row}`, basic.evaluator || "", 3), excelCell(`E${row}`, "评估日期", 7), excelCell(`F${row}`, basic.evaluation_date || "", 3)])); merges.push(`F${row}:H${row}`); row++;
    rows.push(excelRow(row, [excelCell(`A${row}`, "使用班级", 7), excelCell(`B${row}`, basic.class_name || "", 3), excelCell(`E${row}`, "呈现形式", 7), excelCell(`F${row}`, (basic.presentations || []).join("、"), 3)])); merges.push(`B${row}:D${row}`, `F${row}:H${row}`); row += 2;
  };
  const addHeaders = () => { rows.push(excelRow(row, ["序号", "评估维度", "评估指标描述", "权重 %", "评分 1-5", "客观证据记录", "修改意见", "加权得分"].map((value, index) => excelCell(`${String.fromCharCode(65 + index)}${row}`, value, 2)), 30)); row++; };
  const addA = () => {
    addSection("模块 A：课前适配性评估（权重 40%）"); addHeaders(); const first = row;
    calc.aRows.forEach(item => { const current = row++; rows.push(excelRow(current, [excelCell(`A${current}`, item.id, 4), excelCell(`B${current}`, item.label, 3), excelCell(`C${current}`, item.criterion, 3), excelCell(`D${current}`, 8, 4), excelCell(`E${current}`, item.score, 4), excelCell(`F${current}`, item.evidence || "", 3), excelCell(`G${current}`, item.modification || "", 3), excelCell(`H${current}`, item.weighted_score, 5, `IF(E${current}="","",E${current}/5*D${current})`)], 64)); });
    rows.push(excelRow(row, [excelCell(`A${row}`, "模块 A 小计", 6), excelCell(`D${row}`, 40, 6), excelCell(`E${row}`, calc.aComplete ? "已完成" : "待补充", 6), excelCell(`F${row}`, "所有打分必须填写客观证据记录", 6), excelCell(`G${row}`, calc.safetyVeto ? "A4=1，整体不合格" : "A4 安全项须单独核查", 6), excelCell(`H${row}`, calc.aScore, 6, `SUM(H${first}:H${row - 1})`)], 30)); merges.push(`A${row}:C${row}`); row += 2;
  };
  const addB = () => {
    addSection("模块 B：课堂实施效果评估（权重 60%）"); addHeaders(); const dimensions = calc.bReport?.dimensions || Object.entries(CLASSROOM_CRITERIA).map(([id, criterion]) => ({ id, label: id, criterion, weight: 12, score: null, evidence: [], finding: "待完成课堂实施效果评估", modification: "", weighted_score: null })), first = row;
    dimensions.forEach(item => { const current = row++, evidence = item.evidence?.length ? item.evidence.map(entry => `${entry.time} ${entry.student_id} ${entry.observation}`).join("；") : item.finding || ""; rows.push(excelRow(current, [excelCell(`A${current}`, item.id, 4), excelCell(`B${current}`, item.label, 3), excelCell(`C${current}`, item.criterion || CLASSROOM_CRITERIA[item.id], 3), excelCell(`D${current}`, item.weight ?? 12, 4), excelCell(`E${current}`, item.score, 4), excelCell(`F${current}`, evidence, 3), excelCell(`G${current}`, item.modification || "", 3), excelCell(`H${current}`, item.weighted_score, 5, `IF(E${current}="","",E${current}/5*D${current})`)], 66)); });
    rows.push(excelRow(row, [excelCell(`A${row}`, "模块 B 小计", 6), excelCell(`D${row}`, 60, 6), excelCell(`E${row}`, calc.bScore == null ? "待补证" : "已完成", 6), excelCell(`F${row}`, calc.bReport?.summary || "待完成课堂实施效果评估", 6), excelCell(`G${row}`, "依据课堂真实观察证据评分", 6), excelCell(`H${row}`, calc.bReport?.observed_weighted_score ?? null, 6, `SUM(H${first}:H${row - 1})`)], 32)); merges.push(`A${row}:C${row}`); row += 2;
  };
  const addC = () => {
    addSection("模块 C：创新推广加分项（最高 +10 分）"); rows.push(excelRow(row, [excelCell(`A${row}`, "序号", 2), excelCell(`B${row}`, "加分项目（综合单指标）", 2), excelCell(`C${row}`, "加分说明", 2), excelCell(`F${row}`, "加分（0-10）", 2), excelCell(`G${row}`, "佐证材料记录", 2)], 30)); merges.push(`C${row}:E${row}`, `G${row}:H${row}`); row++;
    rows.push(excelRow(row, [excelCell(`A${row}`, "C1", 4), excelCell(`B${row}`, "创新与推广综合加分", 3), excelCell(`C${row}`, "包含：设计创新、校内教师引用频次、师生家长反馈、各级评比获奖、案例论文发表、区域推广等综合情况，不重复累加，按最高水平赋值", 3), excelCell(`F${row}`, calc.cScore == null ? "待补佐证" : calc.cScore, 4), excelCell(`G${row}`, record.module_c?.evidence || "", 3)], 68)); merges.push(`C${row}:E${row}`, `G${row}:H${row}`); row += 2;
  };
  const addSummary = () => {
    addSection("三、综合结果判定"); const values = [["基础总分（模块 A + 模块 B）", calc.base == null ? "待完成（满分 100 分）" : calc.base],["最终综合得分（基础分 + 加分）", calc.finalScore == null ? "待完成（满分 110 分）" : calc.finalScore],["综合等级", calc.grade],["资源包处置建议", record.summary?.disposition || ""],["课堂使用注意事项", record.summary?.attention || ""]];
    values.forEach(([label, value]) => { rows.push(excelRow(row, [excelCell(`A${row}`, label, 7), excelCell(`C${row}`, value, 3)], label === "课堂使用注意事项" ? 42 : 24)); merges.push(`A${row}:B${row}`, `C${row}:H${row}`); row++; }); row++;
    addSection("四、签字确认"); rows.push(excelRow(row, [excelCell(`A${row}`, "角色", 2), excelCell(`C${row}`, "姓名 / 签字", 2), excelCell(`F${row}`, "日期", 2)], 26)); merges.push(`A${row}:B${row}`, `C${row}:E${row}`, `F${row}:H${row}`); row++;
    [["teacher", "授课教师"], ["evaluator", "评估人员（教研）"], ["leader", "教研组长"]].forEach(([id, label]) => { const signature = record.summary?.signatures?.[id] || {}; rows.push(excelRow(row, [excelCell(`A${row}`, label, 3), excelCell(`C${row}`, signature.name || "", 3), excelCell(`F${row}`, signature.date || "", 3)], 25)); merges.push(`A${row}:B${row}`, `C${row}:E${row}`, `F${row}:H${row}`); row++; }); row++;
    addSection("五、量表配套评分锚点说明"); ["5 分（优秀）：指标完全达成，超出预期，可以作为示范教具；", "4 分（良好）：指标基本达成，仅少量细节需要微调；", "3 分（合格）：指标大体达成，存在明显不足，修改后可以使用；", "2 分（待改进）：指标达成度低，需要大幅度重新调整；", "1 分（不合格）：完全不达标，存在安全风险 / 严重不适配，禁止课堂使用。"].forEach(text => { rows.push(excelRow(row, [excelCell(`A${row}`, text, 3)], 23)); merges.push(`A${row}:H${row}`); row++; }); row++;
    addSection("六、评估原则"); ["1. 所有打分必须填写客观证据记录，写课堂观察事实，禁止单纯主观感受；", "2. 安全一票否决：模块 A4 安全项打 1 分，直接判定整体不合格，禁止用于教学；", "3. 本量表服务课题闭环：设计 — 实施 — 反馈 — 优化，评估结果用于迭代教具与主题教学活动。"].forEach(text => { rows.push(excelRow(row, [excelCell(`A${row}`, text, 3)], 25)); merges.push(`A${row}:H${row}`); row++; });
  };
  const title = module === "A" ? "模块 A 课前适配性评估" : module === "C" ? "模块 C 创新推广加分项" : module === "demo" ? "核心演示评估表（模块 A + 模块 B）" : "孤独症儿童主题式教学·教具学具完整评估表";
  addTitle(title); addBasic(); if (module === "A") addA(); else if (module === "C") addC(); else if (module === "demo") { addA(); addB(); } else { addA(); addB(); addC(); addSummary(); }
  return oneSheetWorkbook(module === "A" ? "课前适配性评估" : module === "C" ? "创新推广加分项" : module === "demo" ? "核心演示" : "完整评估表", title, worksheetXml(rows, [10, 20, 39, 11, 12, 48, 42, 14], merges, 0), record.updated_at || new Date().toISOString());
}

async function evaluationExport(request) {
  let record, module = "full";
  try { const form = await request.formData(); record = JSON.parse(String(form.get("payload") || "")); module = String(form.get("module") || "full"); } catch { return json({ error: "评估记录不是有效数据" }, 400); }
  if (!record || !record.basic || !record.module_a) return json({ error: "评估记录不完整" }, 400);
  if (module === "B") {
    const classroomPayload = { lesson: { name: record.basic.tool_name || "课堂", goals: String(record.basic.goals || "").split(/\n+/).filter(Boolean), instructions: [] }, events: Array.isArray(record.module_b?.events) ? record.module_b.events : [], video_analysis: record.module_b?.analysis_info || {} };
    const report = record.module_b?.report && Array.isArray(record.module_b.report.dimensions) ? record.module_b.report : buildClassroomReport(classroomPayload);
    return new Response(buildClassroomWorkbook(classroomPayload, report), { headers: { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "content-disposition": "attachment; filename=classroom-module-b.xlsx", "cache-control": "no-store" } });
  }
  const normalizedModule = ["A", "C", "demo"].includes(module) ? module : "full";
  return new Response(buildEvaluationWorkbook(record, normalizedModule), { headers: { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "content-disposition": `attachment; filename=${normalizedModule === "A" ? "module-a" : normalizedModule === "C" ? "module-c" : normalizedModule === "demo" ? "core-demo-a-b" : "complete-evaluation"}.xlsx`, "cache-control": "no-store" } });
}

async function classroomReport(request) {
  let payload;
  try { payload = await request.json(); } catch { return json({ error: "课堂事件数据不是有效 JSON" }, 400); }
  if (!payload || !Array.isArray(payload.events)) return json({ error: "请提供课堂事件列表" }, 400);
  return json(buildClassroomReport(payload));
}

async function classroomExport(request) {
  let payload;
  try {
    if ((request.headers.get("content-type") || "").includes("application/json")) payload = await request.json();
    else {
      const form = await request.formData();
      payload = JSON.parse(String(form.get("payload") || ""));
    }
  } catch { return json({ error: "课堂事件数据不是有效 JSON" }, 400); }
  if (!payload || !Array.isArray(payload.events)) return json({ error: "请提供课堂事件列表" }, 400);
  const report = buildClassroomReport(payload);
  return new Response(buildClassroomWorkbook(payload, report), { headers: {
    "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "content-disposition": "attachment; filename=classroom-module-b.xlsx",
    "cache-control": "no-store"
  } });
}

async function extractClassroomPlan(request, env) {
  if (!env.MINIMAX_API_KEY) return json({ error: "尚未配置模型密钥，暂时无法智能提取教案" }, 503);
  const form = await request.formData();
  const file = form.get("lesson_plan");
  if (!file || typeof file === "string") return json({ error: "请选择一份可读取的教案" }, 400);
  if (file.size > 10 * 1024 * 1024) return json({ error: "教案文件请控制在 10MB 以内" }, 413);
  const text = await extractFile(file);
  if (!text?.trim()) return json({ error: "未从教案中读取到文字，请转换为 DOCX、PPTX、TXT 或 MD" }, 422);
  const system = "你负责从特殊教育教案中提取课堂视频观察计划。不要评价，不要编造，不要输出 JSON、Markdown、代码围栏或思考过程。只输出逐行 TAB 分隔文本：LESSON<TAB>课程名；GOAL<TAB>可观察目标；STEP<TAB>课堂环节；INSTRUCTION<TAB>关键指令；RESPONSE<TAB>预期学生反应；TRANSFER<TAB>迁移任务。除 LESSON 一行外，其他类型最多6行；字段内容不得换行。输出时使用真实制表符。";
  const parsePlan = rawContent => {
    const cleaned = String(rawContent || "").replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
    const start = cleaned.indexOf("{"), end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        const data = JSON.parse(escapeControlsInStrings(cleaned.slice(start, end + 1)).replace(/,\s*([}\]])/g, "$1"));
        const result = { lesson: String(data.lesson || ""), goals: (data.goals || []).slice(0, 6), steps: (data.steps || []).slice(0, 6), instructions: (data.instructions || []).slice(0, 6), expected_responses: (data.expected_responses || []).slice(0, 6), generalization_tasks: (data.generalization_tasks || []).slice(0, 6) };
        if (result.goals.length || result.steps.length || result.instructions.length) return result;
      } catch {}
    }
    const result = { lesson: "", goals: [], steps: [], instructions: [], expected_responses: [], generalization_tasks: [] };
    const targets = { GOAL: "goals", STEP: "steps", INSTRUCTION: "instructions", RESPONSE: "expected_responses", TRANSFER: "generalization_tasks" };
    for (const line of cleaned.split(/\r?\n/)) {
      let parts = line.trim().replace(/^[-*]\s*/, "").split("\t").map(value => value.trim());
      if (parts.length < 2 && line.includes("|")) parts = line.split("|").map(value => value.trim()).filter(Boolean);
      const type = String(parts.shift() || "").toUpperCase(), value = parts.join(" ").trim();
      if (!value) continue;
      if (type === "LESSON") result.lesson = value;
      else if (targets[type] && result[targets[type]].length < 6) result[targets[type]].push(value);
    }
    if (!result.goals.length && !result.steps.length && !result.instructions.length) throw new Error("观察计划缺少可读取条目");
    return result;
  };
  try {
    const content = await callMiniMax(env, [{ role: "system", content: system }, { role: "user", content: text.slice(0, 80000) }], 0.1, 4096);
    let data;
    try { data = parsePlan(content); }
    catch {
      const repair = `把下面的教案观察计划整理成 TAB 分隔文本，不增加事实。只使用 LESSON、GOAL、STEP、INSTRUCTION、RESPONSE、TRANSFER 六种行类型，每行一个条目。\n\n原始内容：\n${String(content || "").slice(0, 18000)}`;
      data = parsePlan(await callMiniMax(env, [{ role: "user", content: repair }], 0.05, 4096));
    }
    data.lesson ||= file.name.replace(/\.[^.]+$/, "");
    return json(data);
  } catch { return json({ error: "教案已读取，但 AI 未能整理出观察计划，请点击按钮重试" }, 502); }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/api/evaluate") return evaluate(request, env);
    if (request.method === "POST" && url.pathname === "/api/classroom/plan") return extractClassroomPlan(request, env);
    if (request.method === "POST" && url.pathname === "/api/evaluation/module-a") return evaluateModuleA(request, env);
    if (request.method === "POST" && url.pathname === "/api/classroom/video-candidates") return analyzeClassroomVideo(request, env);
    if (request.method === "POST" && url.pathname === "/api/classroom/report") return classroomReport(request);
    if (request.method === "POST" && url.pathname === "/api/classroom/export") return classroomExport(request);
    if (request.method === "POST" && url.pathname === "/api/evaluation/export") return evaluationExport(request);
    if (request.method === "GET" && url.pathname === "/api/health") return json({ ok: true, model: env.MINIMAX_MODEL || "MiniMax-M3", configured: Boolean(env.MINIMAX_API_KEY) });
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) return new Response(PAGE_HTML, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache", "x-content-type-options": "nosniff" } });
    if (request.method === "GET" && (url.pathname === "/classroom" || url.pathname === "/classroom.html")) return new Response(CLASSROOM_HTML, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache", "x-content-type-options": "nosniff" } });
    return new Response("Not Found", { status: 404 });
  }
};
