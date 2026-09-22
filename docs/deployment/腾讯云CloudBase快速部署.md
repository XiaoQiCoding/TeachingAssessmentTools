# 腾讯云 CloudBase Run 快速部署

本说明用于把当前领导演示版部署到腾讯云云托管（CloudBase Run）。演示阶段可直接使用平台分配的 HTTPS 默认域名，不需要先准备自定义域名。

## 控制台部署参数

1. 登录腾讯云，进入“云开发 CloudBase”并创建一个按量计费环境。
2. 进入“云托管”，新建服务，服务名可填写 `teaching-evaluation-demo`。
3. 部署方式选择“本地代码 / Dockerfile”，上传 `outputs/deployment/teaching-evaluation-cloudbase-20260921.zip`。
4. 容器端口填写 `8080`，最小实例数演示阶段可设为 `0`，最大实例数设为 `1`。
5. 添加以下环境变量：

   - `MINIMAX_API_KEY`：MiniMax 中国版 Token Plan 密钥
   - `MINIMAX_MODEL`：`MiniMax-M3`
   - `MINIMAX_API_BASE`：`https://api.minimaxi.com/v1`
   - `MINIMAX_ANTHROPIC_BASE`：`https://api.minimaxi.com/anthropic/v1`

6. 开启公网访问，部署完成后用平台分配的默认域名访问。
7. 先打开 `/api/health`，应看到 `ok: true`、`configured: true`；再打开 `/` 检查完整页面。

## 给领导演示前检查

- 使用匿名材料，不在文件名、教案、图片或视频中包含学生真实姓名。
- 先完成一次模块 A 文件上传和评分，确认 MiniMax 密钥可用。
- 再进入模块 B，用一段较短视频测试关键帧分析和候选证据确认。
- 检查 A+B Excel 能正常下载。
- 默认域名只用于短期测试演示；正式上线应绑定已备案域名并增加登录、访问控制、限流和日志脱敏。

## 回退方式

CloudBase Run 每次部署会生成独立版本。新版本异常时，在服务的流量管理中把流量切回上一个正常版本即可。
