# 特殊教育教学评估工具

这是一个面向教师的特殊教育主题式教学评估项目。当前包含课前教具学具建议、课后使用评估、两套 AI 评估规则、可试用的网站，以及配套的表格和审阅文档。

## 目录说明

```text
webapp/                 网站源代码、AI 评估规则和测试
docs/project/           项目方案、量表重构说明等综合文档
docs/rule-review/       供领导审阅的课前、课后规则 Word 文档
references/templates/   原始评估量表模板
references/examples/    示例教案等输入材料
artifacts/workbooks/    可直接使用的 AI 评估表格
artifacts/examples/     示例评估结果
tools/documents/        规则审阅文档生成工具
tools/spreadsheets/     评估表格生成工具
outputs/                临时生成文件与检查预览，不纳入 Git
```

## 网站运行

进入 `webapp` 目录后运行：

```powershell
npm run validate
npm run build
npm test
npm start
```

本地服务默认使用 `http://127.0.0.1:4173/`。调用模型时，在后端运行环境中设置 `MINIMAX_API_KEY`，不要把密钥写入网页、代码或 Git。

## 两套评估规则

- 课前规则：`webapp/skills/special-education-preclass/SKILL.md`
- 课后规则：`webapp/skills/special-education-postclass/SKILL.md`

网站根据教师选择的评估阶段加载相应规则。教师可上传教案、PPT、图片、课堂记录、反馈、引用记录或奖状，并补充几句话描述。系统只依据已提供的材料判断；材料不足时保留未知，并提出少量关键问题。

## 版本管理约定

- 网站代码、评估规则、正式文档、参考材料和交付表格纳入 Git。
- 构建文件、预览图、检查日志、模型密钥和本机配置不纳入 Git。
- 原网站子目录的历史已备份到本机 `.git-history/`，该目录不会进入仓库。
