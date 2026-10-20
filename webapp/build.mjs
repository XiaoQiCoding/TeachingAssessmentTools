import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const read = file => fs.readFile(path.join(root, file), "utf8");
const [template, html, classroomHtml, pre, post, schemaText, modelScript, diagnosticScript] = await Promise.all([
  read("backend/worker.template.js"), read("frontend/index.html"), read("frontend/classroom.html"),
  read("skills/special-education-preclass/SKILL.md"),
  read("skills/special-education-postclass/SKILL.md"),
  read("shared/evaluation.schema.json"),read('frontend/evaluation-model.js'),read('frontend/evaluation-diagnostics.js')
]);
const output = template
  .replace("__PAGE_HTML__", JSON.stringify(html))
  .replace("__CLASSROOM_HTML__", JSON.stringify(classroomHtml))
  .replace('__MODEL_SELECTOR_JS__',JSON.stringify(modelScript))
  .replace('__DIAGNOSTICS_JS__',JSON.stringify(diagnosticScript))
  .replace("__PRE_SKILL__", JSON.stringify(pre))
  .replace("__POST_SKILL__", JSON.stringify(post))
  .replace("__OUTPUT_SCHEMA__", JSON.stringify(JSON.parse(schemaText)));
await fs.rm(path.join(root, "dist"), { recursive: true, force: true });
await fs.mkdir(path.join(root, "dist/server"), { recursive: true });
await fs.writeFile(path.join(root, "dist/server/index.js"), output);
console.log("Built dist/server/index.js");
