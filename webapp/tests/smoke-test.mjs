import fs from "node:fs/promises";
import path from "node:path";
import worker from "../dist/server/index.js";

const outbound = [];
const outboundModels = [];
let callCount = 0;
globalThis.fetch = async (_url, options) => {
  const body = JSON.parse(options.body);
  outbound.push(body.messages.at(-1).content);
  outboundModels.push(body.model);
  callCount++;
  if (String(_url).includes("/anthropic/v1/messages")) return new Response(JSON.stringify({
    content: [{ type: "text", text: JSON.stringify({ summary: "发现一条候选证据", candidates: [{ start_seconds: 5, end_seconds: 12, phase: "tool_use", type: "response", student_id: "待确认", outcome: "positive", assistance: "gesture", confidence: "medium", note: "学生在手势提示后完成操作", reason: "对应课堂目标" }] }) }]
  }), { headers: { "content-type": "application/json" } });
  if (String(body.messages.at(-1).content).includes("模块 A 量表")) return new Response(JSON.stringify({
    choices: [{ message: { content: `SUMMARY\t模块 A AI 评估完成\n${["A1", "A2", "A3", "A4", "A5"].map((id, index) => `A\t${id}\t${index === 3 ? 5 : 4}\tsupported\t测试材料中的 ${id} 客观证据\t${id} 修改建议`).join("\n")}` } }], base_resp: { status_code: 0, status_msg: "success" }
  }), { headers: { "content-type": "application/json" } });
  return new Response(JSON.stringify({
    choices: [{ message: { content: "META\tpre\tpartial\t测试课程\nSUMMARY\t测试完成\nTOOL\t测试教具\t测试目标\t测试活动\t教师描述\nDIM\talignment\tsupported\t教具与目标匹配\t教师描述\nDIM\tadequacy\tmixed\t数量待确认\t教师描述\nDIM\toutcomes\tnot_applicable\t课前不适用\t未提供\nDIM\tinnovation_feedback\tunknown\t未提供\t未提供\nDIM\tawards\tunknown\t未提供\t未提供\nSUG\thigh\tadequacy\t测试教具\t数量不明\t补充数量\t教案\t观察参与率\t教师描述" } }], base_resp: { status_code: 0, status_msg: "success" }
  }), { headers: { "content-type": "application/json" } });
};

const form = new FormData();
form.set("mode", "pre");
form.set("description", "测试教学描述");
if (process.argv[2]) {
  const filename = process.argv[2];
  form.append("files", new File([await fs.readFile(filename)], path.basename(filename)));
}
const response = await worker.fetch(new Request("https://example.test/api/evaluate", { method: "POST", body: form }), { MINIMAX_API_KEY: "test-key" });
const result = await response.json();
if (!response.ok || result.summary !== "测试完成") throw new Error(JSON.stringify(result));
if (!outbound[0].includes("测试教学描述")) throw new Error("Description did not reach model request");
if (process.argv[2] && !outbound[0].includes("剥西红柿")) throw new Error("Legacy DOC text was not extracted");
if (callCount !== 1 || result.dimensions.length !== 5) throw new Error("Line result was not parsed correctly");
if (outboundModels[0] !== "MiniMax-M3") throw new Error(`Unexpected default model: ${outboundModels[0]}`);
const moduleAForm = new FormData();
moduleAForm.set("description", "教具使用圆角可消毒材料，并按教学目标设计");
moduleAForm.set("basic", JSON.stringify({ tool_name: "测试教具", themes: ["认知主题"], goals: "完成分类" }));
const moduleAResponse = await worker.fetch(new Request("https://example.test/api/evaluation/module-a", { method: "POST", body: moduleAForm }), { MINIMAX_API_KEY: "test-key" });
const moduleAResult = await moduleAResponse.json();
if (!moduleAResponse.ok || moduleAResult.kind !== "preclass_adaptation" || moduleAResult.dimensions.length !== 5 || moduleAResult.module_a_score !== 33.6 || moduleAResult.audit.safety_veto) throw new Error(JSON.stringify(moduleAResult));
const videoForm = new FormData();
videoForm.set("mode", "frames");
videoForm.set("duration", "30");
videoForm.set("lesson", "测试课堂");
videoForm.set("goals", "完成操作");
videoForm.set("instructions", "请完成操作");
videoForm.set("frame_times", "[5]");
videoForm.append("frames", new File([new Uint8Array([255, 216, 255, 217])], "frame-01.jpg", { type: "image/jpeg" }));
const videoResponse = await worker.fetch(new Request("https://example.test/api/classroom/video-candidates", { method: "POST", body: videoForm }), { MINIMAX_API_KEY: "test-key" });
const videoResult = await videoResponse.json();
if (!videoResponse.ok || videoResult.candidates.length !== 1 || videoResult.candidates[0].confirmed !== false || videoResult.analysis.mode !== "sampled_frames") throw new Error(JSON.stringify(videoResult));
const classroomResponse = await worker.fetch(new Request("https://example.test/api/classroom/report", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ lesson: { name: "测试课堂" }, students: [{ id: "S01", level: "基础层" }], events: [
  { id: "E1", phase: "baseline", type: "engagement", student_id: "S01", outcome: "negative", assistance: "none", start_seconds: 1, confidence: "high", note: "未参与", confirmed: true },
  { id: "E2", phase: "baseline", type: "response", student_id: "S01", outcome: "negative", assistance: "none", start_seconds: 4, confidence: "high", note: "未反应", confirmed: true },
  { id: "E3", phase: "tool_use", type: "response", student_id: "S01", outcome: "positive", assistance: "gesture", start_seconds: 10, confidence: "high", note: "手势提示后完成", confirmed: true },
  { id: "E4", phase: "tool_use", type: "operation", student_id: "S01", outcome: "positive", assistance: "independent", start_seconds: 20, confidence: "high", note: "独立操作", confirmed: true },
  { id: "E5", phase: "tool_use", type: "response", student_id: "S01", outcome: "positive", assistance: "independent", start_seconds: 30, confidence: "high", note: "正确反应", confirmed: true }
] }) }), {});
const classroom = await classroomResponse.json();
if (!classroomResponse.ok || classroom.version !== "1.1" || classroom.dimensions.length !== 5 || classroom.dimensions.slice(0, 3).some(item => item.score == null) || classroom.dimensions.slice(3).some(item => item.score != null) || classroom.scored_weight !== 36 || classroom.module_b_score !== null || classroom.audit.rule_version !== "classroom-b-v2" || classroom.audit.ai_analysis_used !== false) throw new Error(JSON.stringify(classroom));
if (!classroom.dimensions.every(item => item.weight === 12 && item.max_score === 5 && item.criterion && item.modification)) throw new Error("Module B rubric fields are incomplete");
const exportResponse = await worker.fetch(new Request("https://example.test/api/classroom/export", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ lesson: { name: "测试课堂" }, students: [{ id: "S01", level: "基础层" }], events: [
  { id: "E1", phase: "baseline", type: "engagement", student_id: "S01", outcome: "negative", assistance: "none", start_seconds: 1, confidence: "high", note: "未参与", confirmed: true },
  { id: "E2", phase: "tool_use", type: "response", student_id: "S01", outcome: "positive", assistance: "gesture", start_seconds: 10, confidence: "high", note: "手势提示后完成", confirmed: true },
  { id: "E3", phase: "tool_use", type: "operation", student_id: "S01", outcome: "positive", assistance: "independent", start_seconds: 20, confidence: "high", note: "独立操作", confirmed: true }
] }) }), {});
const exportBytes = new Uint8Array(await exportResponse.arrayBuffer());
const exportText = new TextDecoder().decode(exportBytes);
if (!exportResponse.ok || exportResponse.headers.get("content-type") !== "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" || exportBytes[0] !== 0x50 || exportBytes[1] !== 0x4b || !exportText.includes("模块B评估") || !exportText.includes("客观证据记录")) throw new Error("Module B XLSX export is invalid");
const record = {
  id: "EV-TEST", version: "1.0",
  basic: { tool_name: "测试教具", themes: ["认知主题"], goals: "完成分类", teacher: "教师甲", evaluator: "评估人乙", evaluation_date: "2026-09-20", class_name: "低年段一班", presentations: ["实物", "图像"] },
  module_a: Object.fromEntries(["A1", "A2", "A3", "A4", "A5"].map(id => [id, { score: 4, evidence: `${id} 客观证据`, modification: `${id} 修改意见` }])),
  module_b: { report: classroom, events: [], analysis_info: null },
  module_c: { score: 6, evidence: "校内教师引用与获奖材料" },
  summary: { disposition: "修改完善后再评估", attention: "小组使用", signatures: { teacher: { name: "教师甲", date: "2026-09-20" }, evaluator: { name: "评估人乙", date: "2026-09-20" }, leader: { name: "组长丙", date: "2026-09-20" } } }
};
const fullExportForm = new FormData();
fullExportForm.set("payload", JSON.stringify(record));
fullExportForm.set("module", "full");
const fullExportResponse = await worker.fetch(new Request("https://example.test/api/evaluation/export", { method: "POST", body: fullExportForm }), {});
const fullExportBytes = new Uint8Array(await fullExportResponse.arrayBuffer());
const fullExportText = new TextDecoder().decode(fullExportBytes);
if (!fullExportResponse.ok || fullExportBytes[0] !== 0x50 || fullExportBytes[1] !== 0x4b || !fullExportText.includes("完整评估表") || !fullExportText.includes("A4") || !fullExportText.includes("创新与推广综合加分") || !fullExportText.includes("安全一票否决")) throw new Error("Complete evaluation XLSX export is invalid");
const demoExportForm = new FormData();
demoExportForm.set("payload", JSON.stringify(record));
demoExportForm.set("module", "demo");
const demoExportResponse = await worker.fetch(new Request("https://example.test/api/evaluation/export", { method: "POST", body: demoExportForm }), {});
const demoExportBytes = new Uint8Array(await demoExportResponse.arrayBuffer());
const demoExportText = new TextDecoder().decode(demoExportBytes);
if (!demoExportResponse.ok || demoExportBytes[0] !== 0x50 || demoExportBytes[1] !== 0x4b || !demoExportText.includes("核心演示") || !demoExportText.includes("模块 A") || !demoExportText.includes("模块 B") || demoExportText.includes("创新与推广综合加分")) throw new Error("Core demo XLSX export is invalid");
const indexResponse = await worker.fetch(new Request("https://example.test/"), {});
const indexHtml = await indexResponse.text();
if (!indexResponse.ok || !indexHtml.includes("核心 Demo") || !indexHtml.includes("课前适配性评估") || !indexHtml.includes("课堂实施效果评估") || indexHtml.includes("创新推广加分项") || !indexHtml.includes("开始 AI 评估模块 A") || !indexHtml.includes("/api/evaluation/module-a") || !indexHtml.includes("导出 A+B 核心 Excel")) throw new Error("Core demo page is incomplete");
const pageResponse = await worker.fetch(new Request("https://example.test/classroom"), {});
const pageHtml = await pageResponse.text();
if (!pageResponse.ok || !pageHtml.includes("AI 提取并确认课堂证据") || !pageHtml.includes("AI 分析 · 人工复核") || !pageHtml.includes("restoreDraft") || !pageHtml.includes("下载 Excel 表格") || !pageHtml.includes("评估指标描述") || pageHtml.includes("创新推广加分项")) throw new Error("Classroom demo page was not served with rubric report and draft recovery");
console.log("Evaluation routes, AI video candidates, classroom rules, document extraction, and client pages are valid");
