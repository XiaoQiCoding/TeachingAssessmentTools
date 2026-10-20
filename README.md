# 特殊教育教学评估工具

这是面向领导展示的核心 Demo 版本，只保留模块 A 课前适配性评估、模块 B 课堂实施效果评估，以及 A+B 核心 Excel 导出。完整量表版本保存在 `full-evaluation` 分支。

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

课堂评估模块的开发说明、接口、评分边界和后续视频自动分析方案见 `docs/classroom-evaluation/README.md`。

## 网站运行

Windows 可直接双击项目根目录的 `start-local.bat`，脚本会构建、更新本地服务并打开完整评估页面。

进入 `webapp` 目录后运行：

```powershell
npm run validate
npm run build
npm test
npm start
```

本地服务默认使用 `http://127.0.0.1:4174/`，界面默认模型为千问 `qwen3.8-flash`，可切换千问 Max、Plus 或 MiniMax M3。千问配置保存在 `webapp/.env.local` 的 `QWEN_API_KEY`、`QWEN_API_BASE` 中；MiniMax 使用独立的 `MINIMAX_API_KEY`。服务启动时自动读取，密钥不写入网页或 Git。服务器部署需单独配置相应环境变量，详见 [千问模型接入说明](docs/千问模型接入说明.md)。

完整评估入口为 `http://127.0.0.1:4174/`，课堂实施效果评估工作页为 `http://127.0.0.1:4174/classroom`。每套教具建立一份独立评估记录，评分和文字证据保存在当前浏览器。课堂分析将原视频上传一次至本服务供直接切片，闲置6小时后清理；本机原文件不修改，模型只接收选取片段或画面。新建记录默认采用“全课稀疏初筛→重点精看→缺证补查”，也可选择原有完整检查；实际观察范围与token用量分别显示。详见 [长视频快速分析](docs/长视频快速分析.md)。系统结合教案和课堂视频生成候选时间节点，候选节点必须由评委勾选确认后才进入 B1 至 B5 固定规则报告。日志、计时和临时视频管理见 [日志与耗时诊断](docs/日志与耗时诊断.md)。

## 量表与辅助规则

- 课前规则：`webapp/skills/special-education-preclass/SKILL.md`
- 课后规则：`webapp/skills/special-education-postclass/SKILL.md`

网页量表以 `test/（省级课题）孤独症儿童主题式教学·教具学具评估量表（重构版） .docx` 为结构依据。模块 A 由 AI 读取教案、教具说明与实物照片后生成 A1–A5 评分；模块 B 由 AI 从课堂视频提取候选证据并由系统生成 B1–B5 评分。评估人负责复核事实，不需要从头填写两个模块的评分表；客观证据和 A4 安全一票否决原则保持不变。

## 版本管理约定

- 网站代码、评估规则、正式文档、参考材料和交付表格纳入 Git。
- 构建文件、预览图、检查日志、模型密钥和本机配置不纳入 Git。
- 原网站子目录的历史已备份到本机 `.git-history/`，该目录不会进入仓库。
