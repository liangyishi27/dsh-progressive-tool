标题：[插件提交] liangyishi27/dsh-progressive-tool — 核心工具直通、长尾工具按需披露，降低每请求工具 schema 开销

正文：

### 仓库地址
https://github.com/liangyishi27/dsh-progressive-tool

### 一句话价值
安装后，少量核心工具保持直接调用，其余工具改为按需搜索、查看、调用，实测把每请求 tool schema 从约 65 KB 降到约 29 KB（声明工具约 87 → 31）。

### 能力分类
工具与能力

### 二级分类
命令行工具 / 工具与能力（tools）

### 安装命令
dsh plugin --profile web add dsh-progressive-tool

### 兼容与运行要求
DeepSeek Harness 0.2.x（实测 0.2.2-rc.5），`@deepseek-ai/dsh-tools` 0.2.x，Node 20+；支持 desktop 与 web profile，Windows / macOS / Linux。

### 许可证
MIT（仓库根有 LICENSE）

### 截图 / 演示
docs/preview.svg（特性示意图）；README 中的实测数据（约 65 KB → 29 KB，工具 87 → 31）

### 补充说明
权限：不新增系统权限；仅在 agent 作用域安装 ToolExecutor 并注册三个元工具（tool_search / tool_inspect / tool_call）；延后工具执行仍走原有审批与守卫管线。外部服务：无。已知限制：节省量只来自请求中的工具声明；实际调用延后工具时，该调用与结果仍会进入会话；若 composition 呈现 PTC 的 run_code，则该步骤原样透传不做二次收窄。

### 提交前自查
- [x] 仓库已公开
- [x] 已添加 GitHub topic：dsh-plugin
- [x] README 包含安装命令
- [x] 插件导出 apply(ctx) 模块
- [x] 仓库根目录包含 package.json

提交入口：https://dsh-plugin.org/zh/submit
 Issues：https://github.com/dshplugin/dsh-plugin-hub/issues/new
