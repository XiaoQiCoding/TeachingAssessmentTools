import fs from "node:fs";

const html = fs.readFileSync("frontend/index.html", "utf8");
const classroomHtml = fs.readFileSync("frontend/classroom.html", "utf8");
new Function(fs.readFileSync('frontend/evaluation-model.js','utf8'));
new Function(fs.readFileSync('frontend/evaluation-diagnostics.js','utf8'));
new Function(fs.readFileSync('frontend/assessment-materials.js','utf8'));
new Function(fs.readFileSync('frontend/assessment-navigation.js','utf8'));
for (const [name, page] of [["index", html], ["classroom", classroomHtml]]) {
  const start = page.lastIndexOf("<script>");
  const end = page.lastIndexOf("</script>");
  if (start < 0 || end <= start) throw new Error(`${name} client script not found`);
  new Function(page.slice(start + 8, end));
}
JSON.parse(fs.readFileSync("shared/evaluation.schema.json", "utf8"));
JSON.parse(fs.readFileSync("shared/classroom.schema.json", "utf8"));
JSON.parse(fs.readFileSync("shared/evaluation-record.schema.json", "utf8"));
for (const file of [
  "skills/special-education-preclass/SKILL.md",
  "skills/special-education-postclass/SKILL.md"
]) {
  const text = fs.readFileSync(file, "utf8");
  if (!/^---\r?\nname: [a-z0-9-]+\r?\ndescription: .+\r?\n---/.test(text)) throw new Error(`Invalid skill frontmatter: ${file}`);
}
console.log("Client, schema and skills are valid");
