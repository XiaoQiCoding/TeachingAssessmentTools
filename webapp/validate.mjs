import fs from "node:fs";

const html = fs.readFileSync("frontend/index.html", "utf8");
const start = html.lastIndexOf("<script>");
const end = html.lastIndexOf("</script>");
if (start < 0 || end <= start) throw new Error("Client script not found");
new Function(html.slice(start + 8, end));
JSON.parse(fs.readFileSync("shared/evaluation.schema.json", "utf8"));
for (const file of [
  "skills/special-education-preclass/SKILL.md",
  "skills/special-education-postclass/SKILL.md"
]) {
  const text = fs.readFileSync(file, "utf8");
  if (!/^---\r?\nname: [a-z0-9-]+\r?\ndescription: .+\r?\n---/.test(text)) throw new Error(`Invalid skill frontmatter: ${file}`);
}
console.log("Client, schema and skills are valid");
