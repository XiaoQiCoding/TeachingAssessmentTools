# 特殊教育教学评估模块设计

## 项目结构

本项目使用一个 Git 仓库管理，前端与后端在目录中分开：

```text
webapp/
├─ frontend/                 教师使用的网页界面
├─ backend/                  文件解析、评估编排和 MiniMax 调用
├─ shared/                   前后端共用的报告数据契约
├─ skills/                   课前、课后两套评估规则
├─ tests/                    本地端到端冒烟验证
├─ build.mjs                 生成可部署的服务端产物
└─ dist/                     构建产物
```

部署时前端可以放入静态托管，后端放入云函数；开发和版本管理仍保持一个项目。MiniMax 密钥只能由后端环境变量读取。

## 页面流程

核心 Demo 入口 `/` 只展示模块 A 课前适配性评估、模块 B 课堂实施效果评估和 A+B Excel 导出。模块 A 通过 `POST /api/evaluation/module-a` 读取教案、教具说明和实物照片，自动生成 A1–A5 的评分、客观证据、修改意见与加权分；模块 B 进入 `/classroom` 由 AI 提取课堂视频候选证据，复核后由固定规则生成 B1–B5 评分并回写演示记录。完整量表流程保留在 `main` 分支。

浏览器使用 `teaching-evaluation-records-v1` 保存多份独立评估记录，使用 `teaching-evaluation-active-record-v1` 标记当前记录。每个模块 B 使用按评估编号隔离的暂存键，避免不同教师或不同教具之间串数据。保存内容仅包含基础信息、评分、文字证据、匿名事件和报告，不保存视频文件。

## 课堂实施评估 MVP

网站使用量表原名“课前适配性评估”和“课堂实施效果评估”，并增加“创新推广加分项”。模块 B 使用独立工作页 `/classroom`，按“教案观察计划、选择本机视频、AI 提取候选节点、评委确认、生成 B1 至 B5 量表报告”运行。20MB 以内的视频通过 Anthropic 兼容接口交给 MiniMax M3 原生分析；较大视频由浏览器抽取最多 36 张带真实时间戳的 JPEG 关键帧后分析。模型只生成候选节点，默认不参与评分；评委勾选、修改或补充后形成正式事件。事件包含阶段、类型、匿名学生编号、结果、辅助等级、时间、事实描述、置信度和来源。

`POST /api/evaluation/module-a` 接收课前文字材料和图片并返回严格对应量表的 A1–A5 结果；`POST /api/classroom/plan` 从教案提取观察计划；`POST /api/classroom/video-candidates` 接收短视频或关键帧并返回候选节点；`POST /api/classroom/report` 不依赖模型，使用 `classroom-b-v2` 固定规则处理评委确认后的事件；`POST /api/classroom/export` 生成模块 B Excel；`POST /api/evaluation/export` 根据当前完整评估记录导出模块 A、模块 B、模块 C 或完整量表 Excel。B1 至 B5 只要出现至少一条直接对应事实即可形成低置信度评分建议，更多样本会提高置信度；没有对应事实时才返回空分，不把未知当作低分。完整模块 B 总分仅在五项均有分数时生成。

## 服务端调用流程

浏览器不应直接保存 LLM 密钥，也不应把 skill 当作普通附件交给用户修改。建议由服务端完成：

1. 接收文件，为每个文件生成 `source_id`，去除文件名中的儿童姓名等身份信息。
2. 在隔离环境中解析 DOC、DOCX、PDF、PPTX 和图片，保留章节、页码、幻灯片序号或图片编号。
3. 根据 `mode` 选择一份固定版本的 skill：
   - `pre` → `skills/special-education-preclass/SKILL.md`
   - `post` → `skills/special-education-postclass/SKILL.md`
4. 将系统安全规则、对应 skill、报告数据契约、解析材料及教师描述一起提交给 LLM。
5. 模型按逐行协议返回精简结果，服务端将其还原为 `shared/evaluation.schema.json` 定义的完整报告，避免长 JSON 被截断。
6. 保存报告时记录 skill 版本、模型、时间、输入材料哈希和结果，方便后续复查。原始儿童材料应设置明确保存期限和访问权限。

前端可调用统一接口：

```http
POST /api/evaluate
Content-Type: multipart/form-data

mode=pre|post
description=教师补充描述
lesson_plan=<file>
attachments[]=<file>
```

接口返回 `shared/evaluation.schema.json` 定义的 JSON。页面将 `dimensions` 显示在“评估结果”，将 `suggestions` 显示在“建议”，将 `questions` 作为材料不足时的简短追问。

## 结果边界

- 教案和 PPT 可以支持设计初评，不能单独证明实际效果。
- 课后“提升”需要可比记录；没有基线时只报告本次表现。
- 师生家长反馈分别呈现，不替他们表达意见。
- 校内引用必须带统计时间范围，区分观摩、意向和真实课堂使用。
- 获奖是一个独立指标，不加入教学质量总分，也不抵消教学问题。
- 页面严格按重构版量表计算分数和等级；当前工程实现仍需在正式使用前完成量表信效度与实际评估流程验证。
