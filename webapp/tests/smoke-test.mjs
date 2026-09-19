import fs from "node:fs/promises";
import path from "node:path";
import worker from "../dist/server/index.js";

const outbound = [];
let callCount = 0;
globalThis.fetch = async (_url, options) => {
  const body = JSON.parse(options.body);
  outbound.push(body.messages.at(-1).content);
  callCount++;
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
console.log("Worker route, document extraction, and line result parsing are valid");
