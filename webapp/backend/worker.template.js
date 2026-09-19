const PAGE_HTML = __PAGE_HTML__;
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
  return locator && locator !== "未提供" ? [{ source_id: "materials", locator, kind: "material", excerpt: "" }] : [];
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

async function callMiniMax(env, messages, temperature = 0.2) {
  const response = await fetch("https://api.minimaxi.com/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${env.MINIMAX_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "MiniMax-M2.7", messages, temperature, top_p: 0.9, max_completion_tokens: 2048 })
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`MiniMax 接口请求失败（${response.status}）`);
  const baseCode = payload?.base_resp?.status_code;
  if (baseCode && baseCode !== 0) throw new Error(payload?.base_resp?.status_msg || `MiniMax 返回错误 ${baseCode}`);
  return String(payload?.choices?.[0]?.message?.content || "");
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
  const system = `${skill}\n\n不要输出 JSON、Markdown、代码围栏或思考过程。只按下面的逐行格式输出，字段之间必须使用一个 TAB 制表符，字段内容中不得出现 TAB 或换行：\nMETA<TAB>pre或post<TAB>complete或partial或needs_input<TAB>课程名\nSUMMARY<TAB>100字内摘要\nTOOL<TAB>教具名<TAB>目标<TAB>活动<TAB>依据位置\nDIM<TAB>维度id<TAB>状态<TAB>80字内结论<TAB>依据位置\nSUG<TAB>优先级<TAB>维度id<TAB>教具<TAB>问题<TAB>行动<TAB>修改位置<TAB>下次观察<TAB>依据位置\nQ<TAB>追问\nLIMIT<TAB>限制\nDIM 必须依次输出 alignment、adequacy、outcomes、innovation_feedback、awards 五行；状态只能是 supported、mixed、unsupported、unknown、not_applicable。TOOL 最多8行，SUG 最多4行，Q 最多3行，LIMIT 最多3行。依据位置只能来自材料，未知写“未提供”，不得编造页码。输出时用真实制表符替换示例中的 <TAB>。`;
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/api/evaluate") return evaluate(request, env);
    if (request.method === "GET" && url.pathname === "/api/health") return json({ ok: true, model: "MiniMax-M2.7", configured: Boolean(env.MINIMAX_API_KEY) });
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) return new Response(PAGE_HTML, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache", "x-content-type-options": "nosniff" } });
    return new Response("Not Found", { status: 404 });
  }
};
