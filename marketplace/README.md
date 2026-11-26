# 插件市场投稿材料 — dsh-progressive-tool

投稿前提：把本仓库作为**公开 GitHub 仓库**发布（仓库需带 `dsh-plugin` topic）。
插件已发布到 npm：`dsh-progressive-tool`（安装命令见根 README）。

所有 `OWNER` 占位符已替换为真实用户名 `liangyishi27`。

## 三个市场入口与文件

| 市场 | 投稿文件 | 目标仓库 / 入口 | 说明 |
|---|---|---|---|
| 1024 Store（deepseek1024.com） | [catalog-plugin.json](catalog-plugin.json) | [imsai-sh/awesome-deepseek-harness-plugins](https://github.com/imsai-sh/awesome-deepseek-harness-plugins) → `catalog/plugins/liangyishi27--dsh-progressive-tool.json` | PR 只加这一个 JSON 文件；静态校验通过后自动合并。仓库需公开、`dsh-plugin` topic，且 `package.json` 的非空 `dsh.bundle.patch` 与 patch 文件在同一 tree 中。 |
| awesome-dsh-plugin | [awesome-plugin.yml](awesome-plugin.yml) | [awesome-dsh-plugin/awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) → `data/plugins/liangyishi27__dsh-progressive-tool.yml` | PR 只加这一个 YAML 文件；不要手改 README。仓库创建满 24 小时后可提。 |
| DSH Plugin Hub（dsh-plugin.org） | [plugin-hub-submission.md](plugin-hub-submission.md) | [提交页](https://dsh-plugin.org/zh/submit) | 公开仓库 + topic 后，按清单用 GitHub Issue 模板提交；自动扫描收录为 `unconfirmed`。 |

## 提交顺序建议

1. 创建 GitHub 仓库 → 推送代码 → 添加 `dsh-plugin` topic → 打 tag `v1.0.0`。
2. `npm publish`（确认 registry 的 `dist-tags.latest` 与 tarball 均可下载）。
3. 等仓库满 24 小时。
4. 提 1024 Store PR（自动合并）。
5. 提 awesome-dsh-plugin PR（人工审核）。
6. 在 dsh-plugin.org 创建 Issue。

## 备注

- `category` 选 `tools`：本插件改变的是工具披露方式，属于工具能力范畴。
- 截图使用矢量预览图 `docs/preview.svg`；若市场要求位图，可补 `screenshots.json` 与 PNG 截图（awesome-dsh-plugin 的 `icon:` 字段只收 GitHub 托管的 png/jpg/webp）。
